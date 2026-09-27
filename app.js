const DB_NAME = 'denshaSoundDB';
const DB_VERSION = 1;
const STORE = 'sounds';
const DEFAULT_PIN = '2580';
const slots = [
  { id: '1', defaultLabel: '放送 1' },
  { id: '2', defaultLabel: '放送 2' },
  { id: '3', defaultLabel: 'ベル' }
];

let db;
let activeRecorder = null;
let activeStream = null;
let activeChunks = [];
let activeSlot = null;
let currentAudio = null;
let holdTimer = null;

const statusText = document.getElementById('statusText');
const settingsDialog = document.getElementById('settingsDialog');
const pinDialog = document.getElementById('pinDialog');
const pinInput = document.getElementById('pinInput');
const pinError = document.getElementById('pinError');

function setStatus(text) { statusText.textContent = text; }

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getPin() { return localStorage.getItem('parentPin') || DEFAULT_PIN; }
function getLabel(slot) { return localStorage.getItem(`label-${slot.id}`) || slot.defaultLabel; }
function saveLabel(slot, label) {
  const cleaned = label.trim() || slot.defaultLabel;
  localStorage.setItem(`label-${slot.id}`, cleaned);
  document.getElementById(`label${slot.id}`).textContent = cleaned;
}

function stopCurrentAudio() {
  if (currentAudio) {
    currentAudio.pause();
    if (currentAudio.src?.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src);
    currentAudio = null;
  }
}

async function playSlot(id) {
  stopCurrentAudio();
  const slot = slots.find(s => s.id === id);
  const record = await dbGet(id);
  if (record?.blob) {
    const url = URL.createObjectURL(record.blob);
    const audio = new Audio(url);
    currentAudio = audio;
    setStatus(`${getLabel(slot)} を再生中`);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      setStatus('ボタンをおしてね');
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      setStatus('音声を再生できませんでした');
    };
    await audio.play();
  } else if (id === '3') {
    playBuiltInBell();
  } else {
    setStatus(`${getLabel(slot)} はまだ録音されていません`);
    navigator.vibrate?.(40);
  }
}

function playBuiltInBell() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  const ctx = new AudioCtx();
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.connect(ctx.destination);
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.55, now + 0.02);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 1.25);
  [880, 1174.66].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = i === 0 ? 0.8 : 0.45;
    osc.connect(gain); gain.connect(master);
    osc.start(now + i * 0.16); osc.stop(now + 1.3);
  });
  setStatus('ベルを再生中');
  setTimeout(() => { setStatus('ボタンをおしてね'); ctx.close(); }, 1400);
}

function preferredMimeType() {
  const candidates = [
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm'
  ];
  if (!window.MediaRecorder) return '';
  return candidates.find(t => MediaRecorder.isTypeSupported?.(t)) || '';
}

async function startRecording(slotId, button) {
  if (activeRecorder) return;
  try {
    activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = preferredMimeType();
    activeRecorder = mime ? new MediaRecorder(activeStream, { mimeType: mime }) : new MediaRecorder(activeStream);
    activeChunks = [];
    activeSlot = slotId;
    activeRecorder.ondataavailable = e => { if (e.data?.size) activeChunks.push(e.data); };
    activeRecorder.onstop = async () => {
      const blob = new Blob(activeChunks, { type: activeRecorder.mimeType || mime || 'audio/mp4' });
      await dbPut({ id: activeSlot, blob, mimeType: blob.type, sourceType: 'recording', sourceName: 'このiPhoneで録音', updatedAt: Date.now() });
      activeStream?.getTracks().forEach(t => t.stop());
      activeRecorder = null; activeStream = null; activeChunks = []; activeSlot = null;
      renderSettings();
      setStatus('録音を保存しました');
    };
    activeRecorder.start();
    button.classList.add('recording');
    button.textContent = '● 録音中…';

    // 録音開始前に描画されていた「停止して保存」は disabled なので、
    // 録音を開始したカードの停止ボタンをここで明示的に有効化する。
    const card = button.closest('.slot-card');
    const stopButton = card?.querySelector('.stop-btn');
    if (stopButton) stopButton.disabled = false;
  } catch (err) {
    console.error(err);
    alert('マイクを使えませんでした。iPhoneの設定で、このWebアプリのマイクを許可してください。');
  }
}

function stopRecording(button) {
  if (activeRecorder?.state === 'recording') {
    // 二重タップを防ぎつつ、MediaRecorder の onstop で保存する。
    if (button) button.disabled = true;
    activeRecorder.stop();
  }
}

async function importAudioFile(slotId, file) {
  if (!file) return;
  const MAX_BYTES = 50 * 1024 * 1024;
  if (file.size > MAX_BYTES) {
    alert('音声ファイルが大きすぎます。50MB以下を目安にしてください。');
    return;
  }

  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  const looksLikeAudio = type.startsWith('audio/') || /\.(mp3|m4a|mp4|wav|aac|caf|aif|aiff|webm|ogg)$/i.test(name);
  if (!looksLikeAudio) {
    alert('音声ファイルを選んでください。MP3・M4A・WAVなどが使えます。');
    return;
  }

  try {
    const blob = file.slice(0, file.size, file.type || 'application/octet-stream');
    await dbPut({
      id: slotId,
      blob,
      mimeType: blob.type,
      sourceType: 'file',
      sourceName: file.name || '選択した音声ファイル',
      updatedAt: Date.now()
    });
    await renderSettings();
    const slot = slots.find(s => s.id === slotId);
    setStatus(`${getLabel(slot)} に音声ファイルを登録しました`);
  } catch (err) {
    console.error(err);
    alert('音声ファイルを保存できませんでした。別のファイルで試してください。');
  }
}

function describeRecord(record, slotId) {
  if (!record) return slotId === '3' ? '音声未登録（標準ベル音を使用）' : '音声はまだ登録されていません';
  if (record.sourceType === 'file') return `音声ファイル：${record.sourceName || '登録済み'}`;
  return 'このiPhoneで録音した音声を使用';
}

async function renderSettings() {
  const root = document.getElementById('slotSettings');
  root.innerHTML = '';
  for (const slot of slots) {
    const record = await dbGet(slot.id);
    const card = document.createElement('article');
    card.className = 'slot-card';
    card.innerHTML = `
      <h3>${slot.id === '1' ? '🔴' : slot.id === '2' ? '🟡' : '🟢'} ボタン ${slot.id}</h3>
      <label>ボタン名</label>
      <input class="label-input" value="${escapeHtml(getLabel(slot))}" maxlength="16" />
      <div class="slot-actions">
        <button class="record-btn">● その場で録音</button>
        <button class="stop-btn" ${activeSlot === slot.id ? '' : 'disabled'}>■ 停止して保存</button>
        <button class="file-btn">📁 音声ファイルを選ぶ</button>
        <input class="audio-file-input" type="file" accept="audio/*,.mp3,.m4a,.wav,.aac,.caf,.aif,.aiff,.webm,.ogg" hidden />
        <button class="play-btn" ${record ? '' : (slot.id === '3' ? '' : 'disabled')}>▶ 試しに再生</button>
        <button class="delete-btn" ${record ? '' : 'disabled'}>音声を消す</button>
      </div>
      <small class="source-info">${escapeHtml(describeRecord(record, slot.id))}</small>
    `;
    const input = card.querySelector('.label-input');
    const fileInput = card.querySelector('.audio-file-input');
    input.addEventListener('change', () => saveLabel(slot, input.value));
    card.querySelector('.record-btn').addEventListener('click', e => startRecording(slot.id, e.currentTarget));
    card.querySelector('.stop-btn').addEventListener('click', e => stopRecording(e.currentTarget));
    card.querySelector('.file-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (file) await importAudioFile(slot.id, file);
      fileInput.value = '';
    });
    card.querySelector('.play-btn').addEventListener('click', () => playSlot(slot.id));
    card.querySelector('.delete-btn').addEventListener('click', async () => {
      if (!confirm('このボタンに登録した音声を消しますか？')) return;
      await dbDelete(slot.id); renderSettings();
    });
    root.appendChild(card);
  }
}

function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));
}

function openPinDialog() {
  pinInput.value = '';
  pinError.hidden = true;
  pinDialog.showModal();
  setTimeout(() => pinInput.focus(), 100);
}

function beginHold() {
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    navigator.vibrate?.(50);
    openPinDialog();
  }, 2000);
}
function cancelHold() { clearTimeout(holdTimer); }

async function init() {
  db = await openDB();
  slots.forEach(s => document.getElementById(`label${s.id}`).textContent = getLabel(s));
  document.querySelectorAll('.sound-btn').forEach(btn => btn.addEventListener('click', () => playSlot(btn.dataset.slot)));

  const p = document.getElementById('parentBtn');
  p.addEventListener('pointerdown', beginHold);
  ['pointerup','pointercancel','pointerleave'].forEach(ev => p.addEventListener(ev, cancelHold));

  document.getElementById('pinCancel').addEventListener('click', () => pinDialog.close());

  document.getElementById('pinForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (pinInput.value === getPin()) {
      pinDialog.close();
      await renderSettings();
      document.getElementById('newPin').value = getPin();
      settingsDialog.showModal();
    } else {
      pinError.hidden = false;
    }
  });

  document.getElementById('closeSettings').addEventListener('click', () => {
    if (activeRecorder) {
      alert('録音中です。先に「停止して保存」を押してください。');
      return;
    }
    settingsDialog.close();
    setStatus('ボタンをおしてね');
  });

  document.getElementById('savePin').addEventListener('click', () => {
    const v = document.getElementById('newPin').value.trim();
    if (!/^\d{4,8}$/.test(v)) return alert('暗証番号は4〜8桁の数字にしてください。');
    localStorage.setItem('parentPin', v);
    alert('暗証番号を変更しました。');
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.error);
  }
}

init().catch(err => {
  console.error(err);
  setStatus('初期化に失敗しました');
});
