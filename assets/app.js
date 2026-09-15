// 종이접기 — 유튜브 링크와 내가 올린 동영상을 분류별로 모아 두고,
// 앱 안에서 느리게·되풀이해 보며 따라 접는 PWA.
//
// 이 앱이 funfun 과 다른 점은 '앱 안에서 재생한다' 는 것이다. 종이접기는 어려운
// 대목을 느리게 돌려 봐야 하는데, 사이트로 보내 버리면 배속도 구간반복도 못 준다.
//   · 유튜브  → IFrame API (setPlaybackRate 를 열어 준다)
//   · 내 영상 → <video> (R2 에 두고 Range 로 받아온다)
// X·페이스북·네이버는 자기네 재생기만 허용하고 배속 조작을 안 열어 줘서 아예 안 받는다.
'use strict';

const APP_VER = 'v1';
const API_BASE = 'https://origami-api.junyoung-cha83.workers.dev';
const STORAGE_KEY = 'origami-state-v1';
const TOKEN_KEY = 'origami-edit-token';
const SAVE_DEBOUNCE_MS = 800;
const PART_SIZE = 8 * 1024 * 1024;     // 조각 하나 크기. R2 는 마지막 조각 말고는 5MiB 이상이어야 한다.
const POSTER_W = 360;                  // 목록에 쓸 미리보기 그림 가로폭

let state = { version: 1, cats: [], items: [] };
let activeCat = '';
let deleteMode = false;
let _saveTimer = null, _saveCtrl = null;

// ── 자잘한 도구 ──────────────────────────────────
const $ = id => document.getElementById(id);
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function nowIso() { return new Date().toISOString(); }
function genId(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function canEdit() { return !!getToken(); }
function fmtSize(n) {
  if (!n) return '';
  return n >= 1073741824 ? (n / 1073741824).toFixed(1) + 'GB'
    : n >= 1048576 ? Math.round(n / 1048576) + 'MB' : Math.round(n / 1024) + 'KB';
}
function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
function ytId(u) {
  try {
    const url = new URL(u);
    const h = url.hostname.replace(/^www\./, '');
    if (h === 'youtu.be') return url.pathname.slice(1).split('/')[0] || '';
    if (h.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v') || '';
      const m = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
      if (m) return m[1];
    }
  } catch {}
  return '';
}
function videoUrl(key) { return `${API_BASE}/api/video/${key}`; }

// ── 저장 · 동기화 ────────────────────────────────
function setSync(s) {
  const el = $('syncStatus'); if (!el) return;
  el.className = 'sync-status ' + (s || '');
  el.textContent = s === 'saving' ? '저장 중…' : s === 'saved' ? '저장됨 ✓'
    : s === 'error' ? '동기화 실패' : s === 'readonly' ? '읽기전용' : '';
  if (s === 'saved') setTimeout(() => { if (el.textContent === '저장됨 ✓') el.textContent = ''; }, 1600);
}
function cacheLocal() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {} }
function migrate(d) {
  const cats = (d && Array.isArray(d.cats) ? d.cats : [])
    .map(c => ({ id: String(c.id || genId('c_')), label: String(c.label || '').slice(0, 12) }))
    .filter(c => c.label);
  const items = (d && Array.isArray(d.items) ? d.items : []).map(it => ({
    id: it.id || genId('o_'),
    cat: String(it.cat || ''),
    kind: it.kind === 'file' ? 'file' : 'youtube',
    url: String(it.url || ''), vid: String(it.vid || ''),
    key: String(it.key || ''), mime: String(it.mime || ''), size: Number(it.size) || 0,
    title: String(it.title || ''), poster: String(it.poster || ''),
    note: String(it.note || ''),
    added_at: it.added_at || nowIso(),
  }));
  return { version: 1, cats, items };
}
async function fetchFromServer() {
  try {
    const r = await fetch(`${API_BASE}/api/data`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    if (j && Array.isArray(j.items)) return j;
  } catch {}
  return null;
}
async function loadInitial() {
  try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) state = migrate(JSON.parse(raw)); } catch {}
  render();
  const remote = await fetchFromServer();
  if (remote) { state = migrate(remote); cacheLocal(); render(); }
}
function saveAndSync() {
  cacheLocal();
  if (!canEdit()) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(pushToServer, SAVE_DEBOUNCE_MS);
}
async function pushToServer() {
  const token = getToken(); if (!token) return;
  if (_saveCtrl) _saveCtrl.abort();
  _saveCtrl = new AbortController();
  setSync('saving');
  try {
    const r = await fetch(`${API_BASE}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Edit-Token': token },
      body: JSON.stringify(state), signal: _saveCtrl.signal,
    });
    if (r.ok) setSync('saved');
    else if (r.status === 401) { try { localStorage.removeItem(TOKEN_KEY); } catch {} updateLockUI(); setSync('error'); alert('편집 비밀번호가 맞지 않아요.'); }
    else if (r.status === 413) { setSync('error'); alert('목록이 너무 커요. 오래된 항목을 지워 주세요.'); }
    else setSync('error');
  } catch (e) { if (e.name !== 'AbortError') setSync('error'); }
}

// ── 편집 잠금 ────────────────────────────────────
function promptToken() {
  if (canEdit()) {
    if (!confirm('편집을 잠글까요? (읽기만 가능해집니다)')) return;
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
  } else {
    const v = prompt('편집 비밀번호를 넣어 주세요.');
    if (v == null) return;
    try { localStorage.setItem(TOKEN_KEY, v.trim()); } catch {}
  }
  if (deleteMode) toggleDeleteMode();
  updateLockUI(); render();
}
function updateLockUI() {
  const b = $('btnLock');
  b.textContent = canEdit() ? '🔓' : '🔒';
  b.title = canEdit() ? '편집 가능 — 눌러서 잠그기' : '읽기전용 — 눌러서 비밀번호 넣기';
  document.body.classList.toggle('readonly', !canEdit());
  setSync(canEdit() ? '' : 'readonly');
}
function toggleDeleteMode() {
  deleteMode = !deleteMode && canEdit();
  document.body.classList.toggle('deleting', deleteMode);
  $('btnDeleteMode').classList.toggle('on', deleteMode);
  render();
}

// ── 분류 ─────────────────────────────────────────
const catById = id => state.cats.find(c => c.id === id);
function addCat(label) {
  label = String(label || '').trim().slice(0, 12);
  if (!label) return null;
  const dup = state.cats.find(c => c.label === label);
  if (dup) return dup;
  const c = { id: genId('c_'), label };
  state.cats.push(c);
  saveAndSync();
  return c;
}
function renderTabs() {
  const box = $('tabs');
  if (!state.cats.length) {
    box.innerHTML = `<button class="tab tab-cat" id="tabCatMgr" title="분류 관리">＋ 분류 만들기</button>`;
    $('tabCatMgr').onclick = openCatDialog;
    activeCat = '';
    return;
  }
  if (!state.cats.some(c => c.id === activeCat)) activeCat = state.cats[0].id;
  box.innerHTML = state.cats.map(c => {
    const n = state.items.filter(i => i.cat === c.id).length;
    return `<button class="tab${c.id === activeCat ? ' active' : ''}" data-cat="${esc(c.id)}" role="tab">
      ${esc(c.label)}${n ? `<i>${n}</i>` : ''}</button>`;
  }).join('') + `<button class="tab tab-cat" id="tabCatMgr" title="분류 관리">⚙</button>`;
  box.querySelectorAll('.tab[data-cat]').forEach(t => t.onclick = () => { activeCat = t.dataset.cat; render(); });
  $('tabCatMgr').onclick = openCatDialog;
}

function openCatDialog() {
  if (!canEdit()) { alert('먼저 🔒 를 눌러 편집 비밀번호를 넣어 주세요.'); return; }
  renderCatList();
  $('catNew').value = '';
  $('catDialog').showModal();
}
function renderCatList() {
  const ul = $('catList');
  ul.innerHTML = state.cats.map(c => {
    const n = state.items.filter(i => i.cat === c.id).length;
    return `<li><span class="cat-name">${esc(c.label)}</span><span class="cat-n">${n}개</span>
      <button type="button" class="cat-del" data-del="${esc(c.id)}" ${n ? 'disabled' : ''}>지우기</button></li>`;
  }).join('') || '<li class="cat-empty">아직 분류가 없어요.</li>';
  ul.querySelectorAll('.cat-del').forEach(b => b.onclick = () => {
    state.cats = state.cats.filter(c => c.id !== b.dataset.del);
    saveAndSync(); renderCatList(); render();
  });
}

// ── 목록 ─────────────────────────────────────────
function render() {
  renderTabs();
  const box = $('cards');
  const list = state.items.filter(i => i.cat === activeCat)
    .sort((a, b) => (b.added_at || '').localeCompare(a.added_at || ''));
  if (!state.cats.length) {
    box.innerHTML = `<div class="empty"><p>먼저 <b>분류</b>를 하나 만들어 주세요.</p>
      <p class="sub">예: 동물 · 꽃 · 상자 · 비행기</p></div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="empty">
      <p>이 분류에 아직 영상이 없어요.</p>
      <p class="sub">${canEdit() ? '오른쪽 아래 ＋ 로 유튜브 링크나 동영상 파일을 넣어 보세요.'
        : '🔒 를 눌러 비밀번호를 넣으면 넣을 수 있어요.'}</p></div>`;
    return;
  }
  box.innerHTML = list.map(it => {
    const thumb = it.kind === 'youtube'
      ? (it.poster || `https://img.youtube.com/vi/${esc(it.vid)}/hqdefault.jpg`)
      : it.poster;
    return `<article class="card" data-id="${esc(it.id)}">
      <div class="thumb">${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" />` : '<span class="noimg">🎞</span>'}
        <span class="badge ${it.kind}">${it.kind === 'youtube' ? '유튜브' : '내 영상'}</span>
        <span class="play">▶</span></div>
      <div class="meta">
        <h3>${esc(it.title || '(제목 없음)')}</h3>
        ${it.note ? `<p class="note">${esc(it.note)}</p>` : ''}
        ${it.kind === 'file' && it.size ? `<p class="sub">${esc(fmtSize(it.size))}</p>` : ''}
      </div>
      <button type="button" class="card-del" data-del="${esc(it.id)}" aria-label="지우기">×</button>
    </article>`;
  }).join('');
  box.querySelectorAll('.card').forEach(c => c.onclick = () => openPlayer(c.dataset.id));
  box.querySelectorAll('.card-del').forEach(b => b.onclick = e => { e.stopPropagation(); removeItem(b.dataset.del); });
}

async function removeItem(id) {
  const it = state.items.find(x => x.id === id); if (!it) return;
  if (!confirm(`'${it.title || '이 영상'}'을(를) 지울까요?`)) return;
  // 올려 둔 파일은 R2 에서도 지운다 — 목록에서만 빼면 용량만 먹는다
  if (it.kind === 'file' && it.key) {
    try {
      await fetch(`${API_BASE}/api/video/${it.key}`, { method: 'DELETE', headers: { 'X-Edit-Token': getToken() } });
    } catch {}
  }
  state.items = state.items.filter(x => x.id !== id);
  saveAndSync(); render();
}

// ══ 등록 ════════════════════════════════════════
let addKind = 'youtube';
let pickedFile = null, pickedPoster = '', pickedDur = 0;

function fillCatSelect() {
  const sel = $('fCat');
  sel.innerHTML = state.cats.map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('')
    + `<option value="__new">＋ 새 분류 만들기…</option>`;
  sel.value = state.cats.some(c => c.id === activeCat) ? activeCat : (state.cats[0] || {}).id || '__new';
  toggleNewCatRow(sel.value === '__new');
}
// 분류 목록에 없으면 그 자리에서 만든다 — 등록을 멈추고 관리 화면으로 갈 일이 없게.
function toggleNewCatRow(on) {
  $('rowNewCat').classList.toggle('hidden', !on);
  if (on) setTimeout(() => $('fNewCat').focus(), 0);
}
function openAddDialog() {
  if (!canEdit()) { alert('먼저 🔒 를 눌러 편집 비밀번호를 넣어 주세요.'); return; }
  setKind('youtube');
  $('fUrl').value = ''; $('fTitle').value = ''; $('fNote').value = ''; $('fNewCat').value = '';
  pickedFile = null; pickedPoster = ''; pickedDur = 0;
  $('fileMeta').classList.add('hidden'); $('fileMeta').innerHTML = '';
  $('preview').classList.add('hidden'); $('preview').innerHTML = '';
  $('uploadBar').classList.add('hidden'); $('addStatus').textContent = '';
  $('addSave').disabled = false;
  fillCatSelect();
  $('addDialog').showModal();
}
function setKind(k) {
  addKind = k;
  document.querySelectorAll('#kindSeg button').forEach(b => b.classList.toggle('on', b.dataset.kind === k));
  $('rowUrl').classList.toggle('hidden', k !== 'youtube');
  $('rowFile').classList.toggle('hidden', k !== 'file');
  $('preview').classList.add('hidden');
}

// 고른 영상에서 첫 장면을 한 컷 떠 목록 그림으로 쓴다. 서버에 또 물어볼 것 없이
// 브라우저가 이미 파일을 갖고 있으니 여기서 만드는 편이 빠르고 확실하다.
function grabPoster(file) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (poster, dur) => {
      if (done) return; done = true;
      try { v.remove(); } catch {}
      URL.revokeObjectURL(url);
      resolve({ poster, dur });
    };
    // 화면 밖이라도 문서에 붙여 둔다. 떼어 놓은 video 는 브라우저가 뒤로 미뤄
    // 메타데이터조차 안 읽는 일이 있다(그러면 한 컷도 못 뜬다).
    v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0';
    v.preload = 'auto'; v.muted = true; v.playsInline = true; v.setAttribute('playsinline', '');
    document.body.appendChild(v);
    v.src = url;

    const shoot = () => {
      try { v.pause(); } catch {}
      try {
        const vw = v.videoWidth, vh = v.videoHeight;
        if (!vw || !vh) return finish('', v.duration || 0);
        const w = POSTER_W, h = Math.round(w * vh / vw);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        finish(c.toDataURL('image/jpeg', 0.6), v.duration || 0);
      } catch { finish('', v.duration || 0); }
    };
    // preload 만 걸어 두면 한 장면도 안 읽는 기기가 있다(헤드리스 크롬·iOS 사파리).
    // 소리를 끈 채 잠깐 재생을 걸어야 비로소 그림이 그려진다 — 떠낸 뒤 바로 멈춘다.
    v.onloadeddata = () => {
      try { v.currentTime = Math.min(1, (v.duration || 3) / 3); } catch { shoot(); }
    };
    v.onseeked = shoot;
    v.onerror = () => finish('', 0);
    v.load();
    const kick = v.play();
    if (kick && kick.catch) kick.catch(() => {});
    setTimeout(() => finish('', v.duration || 0), 8000);   // 못 뽑아도 등록은 되게
  });
}

async function onPickFile() {
  const f = $('fFile').files && $('fFile').files[0];
  if (!f) return;
  pickedFile = f;
  const meta = $('fileMeta');
  meta.classList.remove('hidden');
  meta.innerHTML = `<b>${esc(f.name)}</b><span>${esc(fmtSize(f.size))} · 미리보기 만드는 중…</span>`;
  const { poster, dur } = await grabPoster(f);
  pickedPoster = poster; pickedDur = dur;
  meta.innerHTML = `${poster ? `<img src="${poster}" alt="" />` : ''}
    <div><b>${esc(f.name)}</b><span>${esc(fmtSize(f.size))}${dur ? ' · ' + fmtTime(dur) : ''}</span></div>`;
  if (!$('fTitle').value.trim()) $('fTitle').value = f.name.replace(/\.[^.]+$/, '').slice(0, 120);
}

async function lookupYoutube() {
  const raw = $('fUrl').value.trim();
  const vid = ytId(raw);
  const pv = $('preview');
  if (!vid) { pv.classList.add('hidden'); return null; }
  pv.classList.remove('hidden');
  pv.innerHTML = '<span class="load">불러오는 중…</span>';
  let meta = { vid, title: '', image: `https://img.youtube.com/vi/${vid}/hqdefault.jpg` };
  try {
    const r = await fetch(`${API_BASE}/api/preview?url=${encodeURIComponent(raw)}`, { headers: { 'X-Edit-Token': getToken() } });
    if (r.ok) { const j = await r.json(); if (j && j.vid) meta = j; }
  } catch {}
  pv.innerHTML = `<img src="${esc(meta.image)}" alt="" /><div><b>${esc(meta.title || '유튜브 영상')}</b><span>youtube.com</span></div>`;
  if (!$('fTitle').value.trim()) $('fTitle').value = meta.title || '';
  return meta;
}

// 조각내어 올리기. 한 번에 다 보내면 워커가 받을 수 있는 크기를 넘는다.
async function uploadFile(file, onPct) {
  const token = getToken();
  const q = new URLSearchParams({ name: file.name, type: file.type || 'video/mp4', size: String(file.size) });
  const r0 = await fetch(`${API_BASE}/api/video/start?${q}`, { method: 'POST', headers: { 'X-Edit-Token': token } });
  if (!r0.ok) throw new Error('올리기를 시작하지 못했어요');
  const { key, uploadId } = await r0.json();

  const parts = [];
  const total = Math.max(1, Math.ceil(file.size / PART_SIZE));
  try {
    for (let i = 0; i < total; i++) {
      const blob = file.slice(i * PART_SIZE, Math.min(file.size, (i + 1) * PART_SIZE));
      const rp = await fetch(`${API_BASE}/api/video/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&part=${i + 1}`,
        { method: 'PUT', headers: { 'X-Edit-Token': token }, body: blob });
      if (!rp.ok) throw new Error(`${i + 1}번째 조각을 올리지 못했어요`);
      parts.push(await rp.json());
      onPct(Math.round(((i + 1) / total) * 100));
    }
    const rc = await fetch(`${API_BASE}/api/video/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edit-Token': token },
      body: JSON.stringify({ key, uploadId, parts }),
    });
    if (!rc.ok) throw new Error('조각을 합치지 못했어요');
    return key;
  } catch (e) {
    // 올리다 만 조각은 그냥 두면 R2 에 쌓인다
    try {
      await fetch(`${API_BASE}/api/video/abort`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Edit-Token': token },
        body: JSON.stringify({ key, uploadId }),
      });
    } catch {}
    throw e;
  }
}

async function saveAdd() {
  const status = $('addStatus');
  // 분류 — '＋ 새 분류' 를 고른 채로 등록을 누르면 옆 칸의 이름으로 그 자리에서 만든다
  let catId = $('fCat').value;
  if (catId === '__new') {
    const c = addCat($('fNewCat').value);
    if (!c) { status.textContent = '새 분류 이름을 넣어 주세요.'; $('fNewCat').focus(); return; }
    catId = c.id; fillCatSelect(); $('fCat').value = catId; toggleNewCatRow(false);
  }

  const title = $('fTitle').value.trim();
  const note = $('fNote').value.trim();
  $('addSave').disabled = true;

  try {
    if (addKind === 'youtube') {
      const raw = $('fUrl').value.trim();
      const vid = ytId(raw);
      if (!vid) { status.textContent = '유튜브 주소가 아니에요. youtu.be/… 또는 youtube.com/watch?v=… 를 넣어 주세요.'; return; }
      status.textContent = '제목을 불러오는 중…';
      const meta = await lookupYoutube();
      state.items.push({
        id: genId('o_'), cat: catId, kind: 'youtube',
        url: `https://www.youtube.com/watch?v=${vid}`, vid,
        title: title || (meta && meta.title) || '유튜브 영상',
        poster: (meta && meta.image) || '', note, added_at: nowIso(),
      });
    } else {
      if (!pickedFile) { status.textContent = '동영상 파일을 골라 주세요.'; return; }
      $('uploadBar').classList.remove('hidden');
      status.textContent = '올리는 중… 앱을 닫지 마세요.';
      const key = await uploadFile(pickedFile, pct => {
        $('uploadFill').style.width = pct + '%'; $('uploadPct').textContent = pct + '%';
      });
      state.items.push({
        id: genId('o_'), cat: catId, kind: 'file', key,
        mime: pickedFile.type || 'video/mp4', size: pickedFile.size,
        title: title || pickedFile.name.replace(/\.[^.]+$/, ''),
        poster: pickedPoster, note, added_at: nowIso(),
      });
    }
    activeCat = catId;
    saveAndSync(); render();
    $('addDialog').close();
  } catch (e) {
    status.textContent = (e && e.message) || '등록하지 못했어요.';
  } finally {
    $('addSave').disabled = false;
  }
}

// ══ 재생기 ══════════════════════════════════════
// 유튜브와 내 파일은 다루는 방법이 달라도 조작 막대는 하나다. 그래서 둘을 같은
// 모양(현재시각·길이·재생·배속…)으로 감싸 두고, 막대는 이 껍데기만 상대한다.
let cur = null;            // 지금 재생 중인 항목
let ctl = null;            // 재생기 껍데기
let abA = null, abB = null;
let loopOn = false, rate = 1;
let abTimer = null, tickTimer = null;
let ytApiReady = null, ytPlayer = null;

function loadYtApi() {
  if (ytApiReady) return ytApiReady;
  ytApiReady = new Promise(resolve => {
    if (window.YT && window.YT.Player) return resolve();
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  });
  return ytApiReady;
}

function ytAdapter(player) {
  return {
    play: () => player.playVideo(),
    pause: () => player.pauseVideo(),
    paused: () => player.getPlayerState() !== 1,
    time: () => player.getCurrentTime() || 0,
    duration: () => player.getDuration() || 0,
    seek: t => player.seekTo(Math.max(0, t), true),
    setRate: r => player.setPlaybackRate(r),
    destroy: () => { try { player.destroy(); } catch {} },
  };
}
function videoAdapter(el) {
  return {
    play: () => el.play().catch(() => {}),
    pause: () => el.pause(),
    paused: () => el.paused,
    time: () => el.currentTime || 0,
    duration: () => el.duration || 0,
    seek: t => { el.currentTime = Math.max(0, t); },
    setRate: r => { el.playbackRate = r; },
    destroy: () => { el.pause(); el.removeAttribute('src'); el.load(); },
  };
}

async function openPlayer(id) {
  const it = state.items.find(x => x.id === id); if (!it) return;
  cur = it;
  abA = abB = null; loopOn = false; rate = 1;
  $('playerTitle').textContent = it.title || '';
  $('player').classList.remove('hidden');
  document.body.classList.add('playing');
  // 뒤로가기로 닫히게 — 폰에서 재생 중 뒤로가기를 누르면 앱이 꺼지는 게 아니라 목록으로
  try { history.pushState({ player: 1 }, ''); } catch {}

  const open = $('playerOpen');
  open.classList.toggle('hidden', it.kind !== 'youtube');
  if (it.kind === 'youtube') open.href = it.url;

  const vidEl = $('vid'), ytHost = $('ytHost');
  if (it.kind === 'youtube') {
    vidEl.classList.add('hidden'); ytHost.classList.remove('hidden');
    ytHost.innerHTML = '<div id="ytMount"></div>';
    await loadYtApi();
    ytPlayer = new YT.Player('ytMount', {
      videoId: it.vid,
      playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
      events: {
        onReady: e => { ctl = ytAdapter(e.target); e.target.playVideo(); applyRate(); startTick(); },
        // 끝까지 갔을 때의 되풀이는 여기서 잡는다(구간반복은 따로 시계를 돌린다)
        onStateChange: e => {
          if (e.data === YT.PlayerState.ENDED && loopOn) { ctl.seek(abA ?? 0); ctl.play(); }
          syncPlayBtn();
        },
      },
    });
  } else {
    ytHost.classList.add('hidden'); ytHost.innerHTML = '';
    vidEl.classList.remove('hidden');
    vidEl.src = videoUrl(it.key);
    vidEl.loop = false;
    ctl = videoAdapter(vidEl);
    vidEl.onended = () => { if (loopOn) { ctl.seek(abA ?? 0); ctl.play(); } };
    vidEl.onplay = vidEl.onpause = syncPlayBtn;
    vidEl.play().catch(() => {});
    applyRate(); startTick();
  }
  updateAbView(); syncPlayBtn();
  document.querySelectorAll('#rateSeg button').forEach(b => b.classList.toggle('on', Number(b.dataset.rate) === rate));
  $('btnLoop').classList.remove('on');
}

function closePlayer(fromPop) {
  if ($('player').classList.contains('hidden')) return;
  stopTick(); stopAb();
  if (ctl) { ctl.destroy(); ctl = null; }
  ytPlayer = null;
  $('ytHost').innerHTML = '';
  $('player').classList.add('hidden');
  document.body.classList.remove('playing');
  cur = null;
  if (!fromPop) { try { if (history.state && history.state.player) history.back(); } catch {} }
}

function applyRate() { if (ctl) { try { ctl.setRate(rate); } catch {} } }
function setRate(r) {
  rate = r; applyRate();
  document.querySelectorAll('#rateSeg button').forEach(b => b.classList.toggle('on', Number(b.dataset.rate) === r));
}
function syncPlayBtn() {
  if (!ctl) return;
  const p = ctl.paused();
  $('btnPlay').textContent = p ? '▶ 재생' : '⏸ 멈춤';
}
function startTick() { stopTick(); tickTimer = setInterval(syncPlayBtn, 500); }
function stopTick() { clearInterval(tickTimer); tickTimer = null; }

// 구간반복 — B 를 지나면 A 로 되돌린다. 0.25초마다 보는 것으로 충분하고,
// 더 자주 보면 유튜브 쪽 시각 조회가 잦아져 폰이 더워진다.
function startAb() {
  stopAb();
  abTimer = setInterval(() => {
    if (!ctl || abA == null || abB == null) return;
    const t = ctl.time();
    if (t >= abB - 0.05 || t < abA - 0.5) ctl.seek(abA);
  }, 250);
}
function stopAb() { clearInterval(abTimer); abTimer = null; }
function updateAbView() {
  const v = $('abView');
  if (abA != null && abB != null) v.textContent = `${fmtTime(abA)} ~ ${fmtTime(abB)} 되풀이 중`;
  else if (abA != null) v.textContent = `A = ${fmtTime(abA)} · 이제 B 를 정해 주세요`;
  else v.textContent = '어려운 대목만 되풀이해서 볼 수 있어요';
  $('btnA').classList.toggle('on', abA != null);
  $('btnB').classList.toggle('on', abB != null);
}

// ── 배선 ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  $('appVer').textContent = APP_VER;
  updateLockUI();
  loadInitial();

  $('btnLock').onclick = promptToken;
  $('btnDeleteMode').onclick = () => { if (!canEdit()) { alert('먼저 🔒 를 눌러 비밀번호를 넣어 주세요.'); return; } toggleDeleteMode(); };
  $('btnAdd').onclick = openAddDialog;

  // 등록 다이얼로그
  document.querySelectorAll('#kindSeg button').forEach(b => b.onclick = () => setKind(b.dataset.kind));
  $('btnPickFile').onclick = () => $('fFile').click();
  $('fFile').onchange = onPickFile;
  $('fUrl').addEventListener('change', lookupYoutube);
  $('fUrl').addEventListener('blur', lookupYoutube);
  $('fCat').onchange = () => toggleNewCatRow($('fCat').value === '__new');
  $('btnNewCatOk').onclick = () => {
    const c = addCat($('fNewCat').value);
    if (!c) { $('fNewCat').focus(); return; }
    fillCatSelect(); $('fCat').value = c.id; toggleNewCatRow(false); renderTabs();
  };
  $('btnNewCatCancel').onclick = () => { $('fCat').value = (state.cats[0] || {}).id || '__new'; toggleNewCatRow($('fCat').value === '__new'); };
  $('addCancel').onclick = () => $('addDialog').close();
  $('addSave').onclick = saveAdd;

  // 분류 관리
  $('catAdd').onclick = () => { if (addCat($('catNew').value)) { $('catNew').value = ''; renderCatList(); render(); } };
  $('catClose').onclick = () => $('catDialog').close();

  // 재생기
  $('playerClose').onclick = () => closePlayer();
  document.querySelectorAll('#rateSeg button').forEach(b => b.onclick = () => setRate(Number(b.dataset.rate)));
  $('btnPlay').onclick = () => { if (!ctl) return; ctl.paused() ? ctl.play() : ctl.pause(); setTimeout(syncPlayBtn, 100); };
  $('btnBack5').onclick = () => ctl && ctl.seek(ctl.time() - 5);
  $('btnFwd5').onclick = () => ctl && ctl.seek(ctl.time() + 5);
  $('btnLoop').onclick = () => { loopOn = !loopOn; $('btnLoop').classList.toggle('on', loopOn); };
  $('btnA').onclick = () => { if (!ctl) return; abA = ctl.time(); if (abB != null && abB <= abA) abB = null; updateAbView(); if (abB != null) startAb(); };
  $('btnB').onclick = () => {
    if (!ctl) return;
    const t = ctl.time();
    if (abA == null) { alert('먼저 A 를 정해 주세요.'); return; }
    if (t <= abA + 0.3) { alert('B 는 A 보다 뒤여야 해요.'); return; }
    abB = t; updateAbView(); startAb();
  };
  $('btnABoff').onclick = () => { abA = abB = null; stopAb(); updateAbView(); };

  addEventListener('popstate', () => closePlayer(true));
  addEventListener('keydown', e => { if (e.key === 'Escape') closePlayer(); });
});
