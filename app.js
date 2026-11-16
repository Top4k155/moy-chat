import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signOut, signInWithCustomToken, signInWithCredential } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getDatabase, ref, push, query, limitToLast, onValue, serverTimestamp, remove, set, update, get } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js';
import { firebaseConfig, ownerEmail } from './firebase-config.js';
import { YANDEX_CLIENT_ID, API_BASE, VAPID_KEY } from './config.js';

const $ = (s) => document.querySelector(s);
const login = $('#login');
const appBox = $('#app');
const loginError = $('#loginError');
const status = $('#status');
const feed = $('#feed');
const tasksBox = $('#tasks');
const chatError = $('#chatError');
const menu = $('#taskMenu');

let auth;
let db;
let fbApp;
let user;
let stopTasks;
let stopPin;
let stopConn;
let stopOwner;
let menuPin = '';

let allTasks = {};
let currentFilter = 'all';
let searchQuery = '';

const OWNER_EMAIL = String(ownerEmail || '').toLowerCase();
const placeholder = !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('ВСТАВЬТЕ') || firebaseConfig.projectId === 'ВАШ-ПРОЕКТ';

function safe(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function clockMode() {
  try { return localStorage.getItem('chat-clock-mode') || 'auto'; } catch { return 'auto'; }
}
function formatDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    const mode = clockMode();
    const opts = { day: '2-digit', month: '2-digit', hour: 'numeric', minute: '2-digit' };
    if (mode === '12') opts.hour12 = true;
    if (mode === '24') opts.hour12 = false;
    return new Intl.DateTimeFormat('ru-RU', opts).format(new Date(n));
  } catch {
    return '';
  }
}
function hiddenKey() {
  return 'task-hidden:' + (user?.uid || 'none');
}
function hiddenIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(hiddenKey()) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
function rememberHidden(id) {
  const hidden = [...new Set([...hiddenIds(), id])].slice(-500);
  try { localStorage.setItem(hiddenKey(), JSON.stringify(hidden)); } catch {}
}
function isOwn(t) {
  return typeof user?.uid === 'string' && user.uid.length > 0 && t?.uid === user.uid;
}
let dbOwner = String(OWNER_EMAIL || '');
function isOwner() {
  return Boolean(dbOwner) && Boolean(user?.email) && user.email.toLowerCase() === dbOwner;
}
function watchOwner() {
  try {
    return onValue(ref(db, 'access/owner'), (snap) => {
      const next = String(snap.val() || '').toLowerCase();
      if (next && next !== dbOwner) {
        dbOwner = next;
        syncAdminLink();
        renderTasks();
      }
    }, () => {});
  } catch {
    return undefined;
  }
}
function syncAdminLink() {
  const link = document.getElementById('adminLink');
  if (link) link.classList.toggle('hidden', !isOwner());
}
function showError(e) {
  const code = e?.code || '';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Вход отменён.';
  if (code === 'auth/network-request-failed') return 'Нет сети. Проверьте интернет и попробуйте снова.';
  if (/permission[-_ ]denied/i.test(`${code} ${e?.message || ''}`)) return 'Вы не в разрешённом списке пользователей. Обратитесь к администратору.';
  if (code === 'auth/unauthorized-domain') return 'Добавьте адрес сайта в Authentication → Settings → Authorized domains.';
  return e?.message || 'Не удалось подключиться.';
}
function fail(e) {
  chatError.textContent = showError(e);
  if (String(e?.code || '').includes('permission')) status.textContent = 'нет доступа к базе';
}
function closeMenu() {
  menu.classList.add('hidden');
  delete menu.dataset.id;
  delete menu.dataset.own;
  menuPin = '';
}
function safeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
function closeSettings() {
  const panel = $('#settingsPanel');
  if (panel) panel.classList.add('hidden');
}
function fmtSize(n) {
  const b = Number(n) || 0;
  if (b <= 0) return '';
  if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + ' КБ';
  return (b / (1024 * 1024)).toFixed(1).replace('.', ',') + ' МБ';
}
function fileButton(f) {
  const name = safe(f.name || 'файл');
  const size = fmtSize(f.size);
  return `<button type="button" class="file" data-key="${safe(f.key)}" data-name="${name}" aria-label="Скачать файл ${name}"><span>📄</span><span><strong>${name}</strong><small>${size ? size + ' · ' : ''}Скачать</small></span></button>`;
}

const PRIO_LABEL = { high: 'Высокий', medium: 'Средний', low: 'Низкий' };
const PRIO_WEIGHT = { high: 3, medium: 2, low: 1 };

function isOverdue(deadlineStr, isDone) {
  if (!deadlineStr || isDone) return false;
  const today = new Date().toISOString().slice(0, 10);
  return deadlineStr < today;
}

function renderTasks() {
  if (!user) return;
  const hidden = new Set(hiddenIds());
  const entries = Object.entries(allTasks).filter(([id, t]) => t && !hidden.has(id));

  const activeCount = entries.filter(([, t]) => t.status !== 'done').length;
  $('#counter').textContent = entries.length ? `(${activeCount} активных из ${entries.length})` : '';

  const q = searchQuery.toLowerCase();
  const filtered = entries.filter(([, t]) => {
    const done = t.status === 'done';
    if (currentFilter === 'active' && done) return false;
    if (currentFilter === 'doing' && t.status !== 'doing') return false;
    if (currentFilter === 'done' && !done) return false;
    if (currentFilter === 'mine' && !isOwn(t)) return false;

    if (q) {
      const hay = `${t.title || ''} ${t.name || ''} ${t.email || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  filtered.sort(([, a], [, b]) => {
    const aDone = a.status === 'done' ? 1 : 0;
    const bDone = b.status === 'done' ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    const pw = (PRIO_WEIGHT[b.priority] || 2) - (PRIO_WEIGHT[a.priority] || 2);
    if (pw !== 0) return pw;
    return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
  });

  tasksBox.replaceChildren();
  $('#empty').classList.toggle('hidden', filtered.length > 0);

  for (const [id, t] of filtered) {
    const done = t.status === 'done';
    const prio = ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium';
    const st = ['todo', 'doing', 'done'].includes(t.status) ? t.status : 'todo';
    const overdue = isOverdue(t.deadline, done);

    const node = document.createElement('article');
    node.className = 'task' + (done ? ' done' : '');
    node.dataset.id = id;

    const who = safe(t.name || t.email || 'Участник');
    const deadlineHtml = t.deadline
      ? `<span class="deadline ${overdue ? 'overdue' : ''}">📅 ${safe(t.deadline)}${overdue ? ' (просрочено)' : ''}</span>`
      : '';

    node.innerHTML = `
      <input type="checkbox" class="chk" ${done ? 'checked' : ''} aria-label="Отметить выполненной">
      <div class="task-main">
        <div class="task-head">
          <span class="badge prio-${prio}">${PRIO_LABEL[prio]}</span>
          <select class="status-select" aria-label="Статус задачи">
            <option value="todo" ${st === 'todo' ? 'selected' : ''}>К выполнению</option>
            <option value="doing" ${st === 'doing' ? 'selected' : ''}>В работе</option>
            <option value="done" ${st === 'done' ? 'selected' : ''}>Готово</option>
          </select>
          <span class="task-title">${safe(t.title || '')}</span>
        </div>
        ${t.file ? fileButton(t.file) : ''}
        <div class="task-meta">
          <span>👤 ${who}</span>
          <span>🕒 ${formatDate(t.createdAt)}</span>
          ${deadlineHtml}
        </div>
      </div>
    `;

    node.querySelector('.chk').addEventListener('change', async (e) => {
      const nextStatus = e.target.checked ? 'done' : 'todo';
      try {
        await update(ref(db, `tasks/${id}`), { status: nextStatus, updatedAt: Date.now() });
      } catch (err) {
        e.target.checked = !e.target.checked;
        fail(err);
      }
    });

    node.querySelector('.status-select').addEventListener('change', async (e) => {
      try {
        await update(ref(db, `tasks/${id}`), { status: e.target.value, updatedAt: Date.now() });
      } catch (err) {
        fail(err);
      }
    });

    bindTaskMenu(node, id, t);
    tasksBox.append(node);
  }
}

function bindTaskMenu(node, id, t) {
  let timer;
  let hold = false;
  let startX = 0;
  let startY = 0;
  const open = (x, y) => {
    if (!user) return;
    menu.dataset.id = id;
    menu.dataset.own = (isOwn(t) || isOwner()) ? '1' : '0';
    menuPin = String(t.title || '');
    menu.innerHTML = `
      <button type="button" data-action="hide-local">Скрыть у меня</button>
      ${(isOwn(t) || isOwner()) ? '<button type="button" data-action="delete">Удалить у всех</button>' : ''}
      ${isOwner() ? '<button type="button" data-action="pin">Закрепить как цель</button>' : ''}
    `;
    menu.classList.remove('hidden');
    const width = menu.offsetWidth || 190;
    const height = menu.offsetHeight || 80;
    menu.style.left = Math.max(8, Math.min(x, innerWidth - width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - height - 8)) + 'px';
  };
  node.addEventListener('contextmenu', (e) => {
    if (e.target.closest('select,input,button')) return;
    e.preventDefault();
    open(e.clientX, e.clientY);
  });
  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('select,input,button')) return;
    hold = false;
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => { hold = true; open(e.clientX, e.clientY); }, 550);
  });
  node.addEventListener('pointermove', (e) => {
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 12) clearTimeout(timer);
  });
  node.addEventListener('pointerup', () => clearTimeout(timer));
  node.addEventListener('pointercancel', () => clearTimeout(timer));
  node.addEventListener('click', (e) => {
    if (!hold) return;
    e.preventDefault();
    e.stopPropagation();
    hold = false;
  });
}

function listenPin() {
  stopPin?.();
  stopPin = onValue(ref(db, 'pinnedTask'), (snap) => {
    const p = snap.val();
    const bar = $('#pinbar');
    if (p?.text) {
      bar.classList.add('visible');
      $('#pintext').textContent = String(p.text);
      $('#unpin').classList.toggle('hidden', !isOwner());
    } else {
      bar.classList.remove('visible');
      $('#pintext').textContent = '';
    }
  }, fail);
}

function listen() {
  stopTasks?.();
  allTasks = {};
  tasksBox.replaceChildren();
  stopOwner?.();
  stopOwner = watchOwner();
  syncAdminLink();
  status.textContent = 'Соединяемся…';
  chatError.textContent = '';

  const q = query(ref(db, 'tasks'), limitToLast(250));
  stopTasks = onValue(q, (snap) => {
    allTasks = snap.val() || {};
    renderTasks();
  }, fail);

  listenPin();
  stopConn?.();
  stopConn = onValue(ref(db, '.info/connected'), (snap) => {
    status.textContent = snap.val() ? 'Подключено · синхронизировано' : 'Нет сети, ждём связь';
  });
}

function stopAll() {
  stopTasks?.(); stopTasks = null;
  stopPin?.(); stopPin = null;
  stopConn?.(); stopConn = null;
  stopOwner?.(); stopOwner = null;
  user = null;
  allTasks = {};
  tasksBox.replaceChildren();
  $('#pinbar')?.classList.remove('visible');
  $('#pintext').textContent = '';
  closeMenu();
  closeSettings();
  const photo = $('#photo');
  photo.classList.add('hidden');
  photo.removeAttribute('src');
}

function showPhoto(url) {
  const photo = $('#photo');
  if (typeof url === 'string' && url.startsWith('https://')) {
    photo.src = url;
    photo.classList.remove('hidden');
    return;
  }
  photo.classList.add('hidden');
  photo.removeAttribute('src');
}

if (!placeholder) {
  const firebase = initializeApp(firebaseConfig);
  fbApp = firebase;
  auth = getAuth(firebase);
  db = getDatabase(firebase);

  const loginBtn = $('#loginBtn');
  const GIS_CLIENT_ID = '887986973315-3pepkalo7oe4dl70025rij8nm8sgq3i5.apps.googleusercontent.com';
  loginBtn.classList.add('hidden');
  const gisBtn = $('#gisBtn');
  let tokenClient = null;
  let gisLoading = null;

  function loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (!gisLoading) {
      gisLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => { gisLoading = null; s.remove(); reject(new Error('gsi')); };
        document.head.appendChild(s);
      });
    }
    return gisLoading;
  }

  function initGis() {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GIS_CLIENT_ID,
      scope: 'openid email profile',
      prompt: 'select_account',
      callback: async (resp) => {
        if (resp.error) { loginError.textContent = 'Вход через Google не выполнен.'; return; }
        loginError.textContent = '';
        try {
          await signInWithCredential(auth, GoogleAuthProvider.credential(null, resp.access_token));
        } catch (err) {
          loginError.textContent = showError(err);
        }
      },
      error_callback: () => { loginError.textContent = 'Окно входа Google закрыто, попробуйте ещё раз.'; },
    });
  }

  const warmGis = () => {
    if (tokenClient || gisLoading) return;
    loadGis().then(initGis).catch(() => {});
  };
  gisBtn.addEventListener('pointerenter', warmGis, { once: true });
  gisBtn.addEventListener('touchstart', warmGis, { once: true, passive: true });
  gisBtn.addEventListener('focus', warmGis, { once: true });
  gisBtn.addEventListener('click', (e) => {
    e.preventDefault();
    loginError.textContent = '';
    if (tokenClient) { tokenClient.requestAccessToken(); return; }
    loadGis()
      .then(() => { if (!tokenClient) initGis(); tokenClient.requestAccessToken(); })
      .catch(() => { loginError.textContent = 'Не загрузился вход через Google. Проверьте сеть.'; });
  });

  const yandexBtn = $('#yandexBtn');
  yandexBtn.addEventListener('click', (e) => {
    e.preventDefault();
    loginError.textContent = '';
    if (!YANDEX_CLIENT_ID || !API_BASE) { loginError.textContent = 'Вход через Яндекс пока не настроен.'; return; }
    const back = location.origin + location.pathname;
    location.href = 'https://oauth.yandex.ru/authorize?response_type=token&client_id=' + encodeURIComponent(YANDEX_CLIENT_ID) + '&redirect_uri=' + encodeURIComponent(back);
  });

  if (API_BASE) fetch(API_BASE + '/yandex-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {});
  const yaToken = new URLSearchParams(location.hash.slice(1)).get('access_token');
  if (yaToken) {
    history.replaceState(null, '', location.pathname + location.search);
    gisBtn.disabled = true;
    yandexBtn.disabled = true;
    fetch(API_BASE + '/yandex-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: yaToken }) })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Не удалось войти через Яндекс.');
        await signInWithCustomToken(auth, d.customToken);
      })
      .catch((err) => { loginError.textContent = err.message || 'Не удалось войти через Яндекс.'; })
      .finally(() => { gisBtn.disabled = false; yandexBtn.disabled = false; });
  }

  const ACCESS_DENIED = 'Вы не в разрешённом списке пользователей. Обратитесь к администратору.';
  let pendingLoginError = '';
  let checkingAccess = false;

  async function openAppIfAllowed(u) {
    if (!u || checkingAccess) return;
    if (user?.uid === u.uid && stopTasks) return;
    checkingAccess = true;
    login.classList.remove('hidden');
    appBox.classList.add('hidden');
    loginError.textContent = 'Проверяем доступ…';
    try {
      await get(query(ref(db, 'tasks'), limitToLast(1)));
    } catch (err) {
      login.classList.remove('hidden');
      appBox.classList.add('hidden');
      if (/permission[-_ ]denied/i.test(`${err?.code || ''} ${err?.message || ''}`)) {
        pendingLoginError = ACCESS_DENIED;
        loginError.textContent = ACCESS_DENIED;
        try { await signOut(auth); } catch {}
        return;
      }
      loginError.textContent = showError(err);
      return;
    } finally {
      checkingAccess = false;
    }
    if (auth.currentUser?.uid !== u.uid) return;
    user = u;
    loginError.textContent = '';
    login.classList.add('hidden');
    appBox.classList.remove('hidden');
    status.textContent = u.email || 'Вход выполнен';
    showPhoto(u.photoURL);
    listen();
  }

  onAuthStateChanged(auth, (u) => {
    if (!u) {
      stopAll();
      appBox.classList.add('hidden');
      login.classList.remove('hidden');
      loginError.textContent = pendingLoginError;
      pendingLoginError = '';
      return;
    }
    openAppIfAllowed(u);
  });
} else {
  $('#loginBtn').addEventListener('click', (e) => {
    e.preventDefault();
    loginError.textContent = 'Сначала укажите настройки Firebase в firebase-config.js.';
  });
}

$('#filterTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  currentFilter = btn.dataset.filter;
  renderTasks();
});

$('#searchInput').addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  renderTasks();
});

$('#clockMode').value = ['auto', '12', '24'].includes(clockMode()) ? clockMode() : 'auto';
$('#settingsBtn').onclick = () => $('#settingsPanel').classList.remove('hidden');
$('#settingsClose').onclick = closeSettings;
$('#settingsPanel').onclick = (e) => { if (e.target === $('#settingsPanel')) closeSettings(); };
$('#clockMode').onchange = (e) => {
  try { localStorage.setItem('chat-clock-mode', e.target.value); } catch {}
  renderTasks();
};

function themeMode() {
  try { return localStorage.getItem('chat-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}
function applyTheme(mode) {
  const theme = mode === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#121614' : '#f3f1ec';
}
applyTheme(themeMode());
$('#themeMode').value = themeMode();
$('#themeMode').onchange = (e) => {
  const mode = e.target.value === 'dark' ? 'dark' : 'light';
  try { localStorage.setItem('chat-theme', mode); } catch {}
  applyTheme(mode);
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSettings(); closeMenu(); }
});
feed.addEventListener('scroll', closeMenu, { passive: true });
window.addEventListener('resize', closeMenu);

document.addEventListener('click', async (e) => {
  if (!e.target.closest('#taskMenu')) {
    closeMenu();
    return;
  }
  const action = e.target.closest('button')?.dataset.action;
  const id = menu.dataset.id;
  const pinText = menuPin;
  const canDelete = menu.dataset.own === '1';
  if (!action || !safeId(id) || !user) return;
  closeMenu();
  try {
    if (action === 'hide-local') {
      rememberHidden(id);
      renderTasks();
      return;
    }
    if (action === 'delete') {
      if (!canDelete) return;
      if (!confirm('Удалить эту задачу у всех участников?')) return;
      await remove(ref(db, `tasks/${id}`));
      return;
    }
    if (action === 'pin') {
      if (!isOwner()) return;
      const text = pinText.trim().slice(0, 2000);
      if (!text) return;
      await set(ref(db, 'pinnedTask'), { text, by: user.email, createdAt: Date.now() });
    }
  } catch (err) {
    fail(err);
  }
});

$('#unpin').onclick = async () => {
  if (!isOwner()) return;
  try { await remove(ref(db, 'pinnedTask')); }
  catch (e) { fail(e); }
};
$('#logout').onclick = () => auth && signOut(auth);

let pendingFile = null;
let sending = false;
const fileInput = $('#file');
const attachBtn = $('#attachBtn');
const chip = $('#filechip');
const sendBtn = $('#send');
const textInput = $('#text');

function showChip(f) {
  $('#fcName').textContent = f.name;
  $('#fcSize').textContent = fmtSize(f.size) || 'Размер неизвестен';
  chip.classList.remove('hidden');
}
function clearFile() {
  pendingFile = null;
  fileInput.value = '';
  attachBtn.classList.remove('on');
  chip.classList.add('hidden');
  syncSend();
}
function syncSend() {
  const ready = Boolean(textInput.value.trim()) || Boolean(pendingFile);
  sendBtn.disabled = !ready || sending;
}
$('#fcRemove').onclick = clearFile;
textInput.addEventListener('input', syncSend);
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  chatError.textContent = '';
  if (!f) return;
  if (f.size > 20 * 1024 * 1024) { chatError.textContent = 'Файл больше 20 МБ.'; fileInput.value = ''; return; }
  pendingFile = f;
  attachBtn.classList.add('on');
  showChip(f);
  syncSend();
});

async function uploadFile(f) {
  const idToken = await user.getIdToken();
  const r = await fetch(API_BASE + '/upload-form', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, fileName: f.name, size: f.size, contentType: f.type || 'application/octet-stream' }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Не удалось загрузить файл.');
  const form = new FormData();
  Object.entries(d.post.fields).forEach(([name, value]) => form.append(name, value));
  form.append('file', f);
  const put = await fetch(d.post.url, { method: 'POST', body: form });
  if (!put.ok) throw new Error('Файл не загрузился, попробуйте ещё раз.');
  return { key: d.key, name: f.name, size: f.size, type: d.contentType };
}

tasksBox.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-key]');
  if (!btn || !user) return;
  btn.disabled = true;
  try {
    const idToken = await user.getIdToken();
    const r = await fetch(API_BASE + '/file-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, key: btn.dataset.key, name: btn.dataset.name }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Нет доступа к файлу.');
    const a = document.createElement('a');
    a.href = d.url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    chatError.textContent = err.message || 'Не удалось открыть файл.';
  } finally {
    btn.disabled = false;
  }
});

const pushBtn = $('#pushBtn');
const pushSupported = 'serviceWorker' in navigator && 'Notification' in window && 'PushManager' in window && Boolean(VAPID_KEY);
if (pushSupported) {
  pushBtn.classList.remove('hidden');
  navigator.serviceWorker.register('sw.js').then(async (reg) => {
    const sub = await reg.pushManager.getSubscription();
    setPushOn(Boolean(sub) && Notification.permission === 'granted');
  }).catch(() => {});
}
function setPushOn(on) {
  pushBtn.classList.toggle('on', on);
  pushBtn.querySelector('.lbl').textContent = on ? 'Уведомления вкл.' : 'Уведомления';
}
function vapidBytes(s) {
  const b64 = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
async function subKey(endpoint) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
pushBtn.onclick = async () => {
  if (!user || !fbApp) return;
  chatError.textContent = '';
  pushBtn.disabled = true;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('уведомления запрещены в настройках браузера.');
    const reg = await navigator.serviceWorker.register('sw.js');
    const want = vapidBytes(VAPID_KEY);
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      const have = sub.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
      if (!have || have.length !== want.length || have.some((b, i) => b !== want[i])) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
    const json = sub.toJSON();
    await set(ref(db, 'pushTokens/' + user.uid + '/' + await subKey(json.endpoint)), {
      endpoint: json.endpoint,
      keys: json.keys,
      email: user.email || '',
      updatedAt: Date.now(),
    });
    setPushOn(true);
  } catch (err) {
    chatError.textContent = 'Уведомления: ' + (err.message || err);
  } finally {
    pushBtn.disabled = false;
  }
};

async function notifyOthers(text, name) {
  try {
    if (!API_BASE || !user) return;
    const idToken = await user.getIdToken();
    fetch(API_BASE + '/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idToken,
        text: ('Новая задача: ' + String(text || '')).slice(0, 140),
        name: String(name || 'Участник').slice(0, 60),
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = textInput.value.trim().slice(0, 2000);
  const file = pendingFile;
  if ((!title && !file) || !user || !db) return;

  textInput.disabled = true;
  sending = true;
  sendBtn.disabled = true;
  attachBtn.disabled = true;
  if (file) $('#fcSize').textContent = 'Загружается…';

  try {
    const data = {
      uid: user.uid,
      name: user.displayName || user.email || 'Участник',
      email: user.email || '',
      title: title || (file ? file.name : ''),
      priority: $('#priority').value || 'medium',
      status: 'todo',
      deadline: $('#deadline').value || '',
      createdAt: serverTimestamp(),
      updatedAt: Date.now(),
    };
    if (file) data.file = await uploadFile(file);
    await push(ref(db, 'tasks'), data);
    notifyOthers(data.title, data.name);
    textInput.value = '';
    $('#deadline').value = '';
    clearFile();
    chatError.textContent = '';
  } catch (err) {
    fail(err);
  } finally {
    textInput.disabled = false;
    sending = false;
    attachBtn.disabled = false;
    syncSend();
    textInput.focus();
  }
});
