// 종이접기 — 앱 껍데기 오프라인 캐시. CACHE 이름을 바꾸면 옛 캐시가 자동으로 버려진다.
// 동영상(R2)과 목록(KV)은 캐시하지 않는다 — 영상은 너무 크고, 목록은 늘 최신이어야 한다.
const CACHE = 'origami-v9';
const ASSETS = ['./', './index.html', './assets/app.css?v=9', './assets/app.js?v=9',
  './manifest.webmanifest', './assets/icon.svg', './assets/icon-maskable.svg'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(ASSETS.map(u => c.add(u).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;   // 워커·유튜브는 그냥 통과
  e.respondWith(
    fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); return res; })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
