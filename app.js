const DB_NAME = 'denshaSoundDB';
const DB_VERSION = 1;
const STORE = 'sounds';
const DEFAULT_PIN = '2580';
const slots = ['7','8','9','4','5','6','1','2','3','0'].map(id => ({ id, defaultLabel: id }));

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
function getLabel(slot) { return slot.defaultLabel; }

function stopCurrentAudio() {
  if (currentAudio) {
    currentAudio.pause();
    if (currentAudio.src?.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src);
    currentAudio = null;
  }
}

async function playSlot(id) {
  try {
    stopCurrentAudio();
    const slot = slots.find(s => s.id === id);
    const record = await dbGet(id);
    if (!record?.blob) {
      setStatus(`${getLabel(slot)} はまだ登録されていません`);
      navigator.vibrate?.(40);
      return;
    }
    const url = URL.createObjectURL(record.blob);
    const audio = new Audio(url);
    currentAudio = audio;
    setStatus(`${getLabel(slot)} を再生中`);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      setStatus('ボタンをおしてください');
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      currentAudio = null;
      setStatus('音声を再生できませんでした');
    };
    await audio.play();
  } catch (e) {
    console.error(e);
    setStatus('音声を再生できませんでした');
  }
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
      await dbPut({ id: activeSlot, blob, mimeType: blob.type, sourceType: 'recording', sourceName: 'この iPhone で録音', updatedAt: Date.now() });
      activeStream?.getTracks().forEach(t => t.stop());
      activeRecorder = null; activeStream = null; activeChunks = []; activeSlot = null;
      await renderSettings();
      setStatus('録音を保存しました');
    };
    activeRecorder.start();
    button.classList.add('recording');
    button.textContent = '録音中';
    const card = button.closest('.slot-card');
    const stopButton = card?.querySelector('.stop-btn');
    if (stopButton) stopButton.disabled = false;
  } catch (err) {
    console.error(err);
    alert('マイクを使えませんでした。iPhone の設定で、この Web アプリのマイクを許可してください。');
  }
}

function stopRecording(button) {
  if (activeRecorder?.state === 'recording') {
    if (button) button.disabled = true;
    activeRecorder.stop();
  }
}

async function importAudioFile(slotId, file) {
  if (!file) return;
  const MAX_BYTES = 50 * 1024 * 1024;
  if (file.size > MAX_BYTES) {
    alert('音声ファイルが大きすぎます。50MB 以下を目安にしてください。');
    return;
  }

  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  const looksLikeAudio = type.startsWith('audio/') || /\.(mp3|m4a|mp4|wav|aac|caf|aif|aiff|webm|ogg)$/i.test(name);
  if (!looksLikeAudio) {
    alert('音声ファイルを選んでください。MP3・M4A・WAV などが使えます。');
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
    setStatus(`${slotId} に音声ファイルを登録しました`);
  } catch (err) {
    console.error(err);
    alert('音声ファイルを保存できませんでした。別のファイルで試してください。');
  }
}

function describeRecord(record) {
  if (!record) return '音声はまだ登録されていません';
  if (record.sourceType === 'file') return `音声ファイル：${record.sourceName || '登録済み'}`;
  return 'この iPhone で録音した音声を使用';
}

async function renderSettings() {
  const root = document.getElementById('slotSettings');
  root.innerHTML = '';
  for (const slot of slots) {
    const record = await dbGet(slot.id);
    const card = document.createElement('article');
    card.className = 'slot-card';
    card.innerHTML = `
      <h3><span class="slot-number">${slot.id}</span>ボタン ${slot.id}</h3>
      <div class="slot-actions">
        <button class="record-btn">録音</button>
        <button class="stop-btn" ${activeSlot === slot.id ? '' : 'disabled'}>停止して保存</button>
        <button class="file-btn">音声ファイルを選ぶ</button>
        <input class="audio-file-input" type="file" accept="audio/*,.mp3,.m4a,.wav,.aac,.caf,.aif,.aiff,.webm,.ogg" hidden />
        <button class="play-btn" ${record ? '' : 'disabled'}>試しに再生</button>
        <button class="delete-btn" ${record ? '' : 'disabled'}>音声を消す</button>
      </div>
      <small class="source-info">${escapeHtml(describeRecord(record))}</small>
    `;
    const fileInput = card.querySelector('.audio-file-input');
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
      if (!confirm(`${slot.id} に登録した音声を消しますか？`)) return;
      await dbDelete(slot.id);
      renderSettings();
    });
    root.appendChild(card);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));
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
  slots.forEach(s => {
    const el = document.getElementById(`label${s.id}`);
    if (el) el.textContent = getLabel(s);
  });
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
    setStatus('ボタンをおしてください');
  });

  document.getElementById('savePin').addEventListener('click', () => {
    const v = document.getElementById('newPin').value.trim();
    if (!/^\d{4,8}$/.test(v)) return alert('暗証番号は 4〜8 桁の数字にしてください。');
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
