// 종이접기 — 목록 동기화 + 동영상 보관 API
//
//   GET    /api/data              누구나 읽기 (목록 JSON)
//   PUT    /api/data              X-Edit-Token — 목록 저장
//   GET    /api/preview?url=      X-Edit-Token — 유튜브 제목·썸네일
//   POST   /api/video/start       X-Edit-Token — 올리기 시작 → { key, uploadId }
//   PUT    /api/video/part        X-Edit-Token — 조각 올리기 → { part, etag }
//   POST   /api/video/complete    X-Edit-Token — 조각 합치기
//   POST   /api/video/abort       X-Edit-Token — 올리다 만 것 치우기
//   GET    /api/video/<key>       누구나 — 재생(Range 지원)
//   DELETE /api/video/<key>       X-Edit-Token — 지우기
//
// KV: ORIGAMI (단일 키 "origami-data")  ·  R2: VIDEOS  ·  Secret: EDIT_TOKEN
//
// 동영상을 한 번의 요청으로 올리지 않고 조각내어 올리는 까닭:
// 워커가 받을 수 있는 요청 본문에 한도가 있어서, 폰으로 찍은 몇 분짜리 영상(수백 MB)은
// 통째로는 못 올린다. R2 의 멀티파트 올리기로 8MB 씩 나눠 보내고 마지막에 합친다.

const KEY = 'origami-data';
const MAX_BYTES = 8 * 1024 * 1024;        // 목록 JSON (썸네일이 들어 있어 넉넉히)
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;   // 영상 하나 2GB 까지
const UA = 'Mozilla/5.0 (compatible; OrigamiBot/1.0)';

const ALLOWED_ORIGINS = [
  'https://junyoungcha83.github.io',
  'http://localhost:8000',
  'http://localhost:8080',
  'http://localhost:8899',
  'http://127.0.0.1:8000',
];

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}
function authed(req, env) {
  const t = req.headers.get('X-Edit-Token') || '';
  return !!env.EDIT_TOKEN && t === env.EDIT_TOKEN;
}
function isValidShape(p) {
  return p && typeof p === 'object' && Array.isArray(p.items) && Array.isArray(p.cats);
}

// ── 유튜브 미리보기 ───────────────────────────────
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
async function preview(rawUrl) {
  const vid = ytId(rawUrl);
  if (!vid) return { error: 'not_youtube' };
  let title = '';
  try {
    const o = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + vid)}&format=json`,
      { headers: { 'User-Agent': UA }, cf: { cacheTtl: 600 } });
    if (o.ok) { const j = await o.json(); title = (j && j.title) || ''; }
  } catch {}
  return {
    vid,
    title: (title || '유튜브 영상').replace(/\s+/g, ' ').slice(0, 200),
    image: `https://img.youtube.com/vi/${vid}/hqdefault.jpg`,
  };
}

// ── 동영상 보관(R2) ───────────────────────────────
// 키에 원본 파일명을 그대로 쓰면 한글·공백·/ 때문에 주소가 깨진다. 날짜+무작위로 짓고
// 확장자만 남긴다. 보여 줄 이름은 목록 JSON 쪽에 따로 둔다.
function newKey(name) {
  const ext = (String(name || '').match(/\.([a-zA-Z0-9]{1,5})$/) || [, 'mp4'])[1].toLowerCase();
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `v/${d}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
}
// 주소에 들어온 키가 우리가 지은 모양인지 본다 — 딴 데를 긁지 못하게.
function safeKey(k) { return /^v\/[0-9]{8}-[a-z0-9]{8}\.[a-z0-9]{1,5}$/.test(k); }

// Range 요청을 받아 그 부분만 내려준다. 이게 없으면 <video> 에서 앞뒤로 못 건너뛴다.
async function serveVideo(req, env, key, cors) {
  if (!safeKey(key)) return new Response('Not Found', { status: 404, headers: cors });
  const range = req.headers.get('Range');
  const common = {
    ...cors,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',   // 키가 한 번 정해지면 내용이 안 바뀐다
  };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      const head = await env.VIDEOS.head(key);
      if (!head) return new Response('Not Found', { status: 404, headers: cors });
      const size = head.size;
      let start, end;
      if (m[1] === '') {                       // bytes=-500 → 마지막 500바이트
        const n = Number(m[2] || 0);
        start = Math.max(0, size - n); end = size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      }
      if (!(start >= 0 && end >= start && start < size)) {
        return new Response(null, { status: 416, headers: { ...common, 'Content-Range': `bytes */${size}` } });
      }
      const obj = await env.VIDEOS.get(key, { range: { offset: start, length: end - start + 1 } });
      if (!obj) return new Response('Not Found', { status: 404, headers: cors });
      return new Response(obj.body, {
        status: 206,
        headers: {
          ...common,
          'Content-Type': obj.httpMetadata?.contentType || 'video/mp4',
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
        },
      });
    }
  }
  const obj = await env.VIDEOS.get(key);
  if (!obj) return new Response('Not Found', { status: 404, headers: cors });
  return new Response(obj.body, {
    headers: {
      ...common,
      'Content-Type': obj.httpMetadata?.contentType || 'video/mp4',
      'Content-Length': String(obj.size),
    },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req);
    const p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    // ── 목록 ──
    if (p === '/api/data') {
      if (req.method === 'GET') {
        const raw = await env.ORIGAMI.get(KEY);
        return new Response(raw || JSON.stringify({ version: 1, cats: [], items: [] }), {
          headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      if (req.method === 'PUT') {
        if (!authed(req, env)) return json({ error: 'unauthorized' }, 401, cors);
        const body = await req.text();
        if (body.length > MAX_BYTES) return json({ error: 'too_large' }, 413, cors);
        let parsed;
        try { parsed = JSON.parse(body); } catch { return json({ error: 'invalid_json' }, 400, cors); }
        if (!isValidShape(parsed)) return json({ error: 'invalid_shape' }, 400, cors);
        await env.ORIGAMI.put(KEY, body);
        return json({ ok: true, bytes: body.length }, 200, cors);
      }
      return json({ error: 'method_not_allowed' }, 405, cors);
    }

    // 비밀번호가 맞는지만 알려 준다. 앱이 비밀번호를 받은 그 자리에서 확인할 수 있게
    // 둔 것 — 없으면 나중에 뭔가 저장할 때에야 틀린 줄 알게 된다.
    // 값이 얼마나 긴지도 함께 보낸다. 껍데기에 눈에 안 보이는 공백이나 줄바꿈이 섞여
    // 들어간 경우(파이프로 넣다 보면 생긴다) 길이만 견줘 봐도 바로 드러난다.
    if (p === '/api/check') {
      const ok = authed(req, env);
      return json({
        ok,
        sent: (req.headers.get('X-Edit-Token') || '').length,
        stored: env.EDIT_TOKEN ? env.EDIT_TOKEN.length : 0,
      }, ok ? 200 : 401, cors);
    }

    if (p === '/api/preview' && req.method === 'GET') {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401, cors);
      const target = url.searchParams.get('url') || '';
      if (!target) return json({ error: 'missing_url' }, 400, cors);
      const meta = await preview(target);
      return json(meta, meta.error ? 400 : 200, cors);
    }

    // ── 동영상 올리기(조각내어) ──
    if (p === '/api/video/start' && req.method === 'POST') {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401, cors);
      const size = Number(url.searchParams.get('size') || 0);
      if (size > MAX_VIDEO_BYTES) return json({ error: 'too_large' }, 413, cors);
      const key = newKey(url.searchParams.get('name'));
      const type = url.searchParams.get('type') || 'video/mp4';
      const up = await env.VIDEOS.createMultipartUpload(key, { httpMetadata: { contentType: type } });
      return json({ key, uploadId: up.uploadId }, 200, cors);
    }
    if (p === '/api/video/part' && req.method === 'PUT') {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401, cors);
      const key = url.searchParams.get('key') || '';
      const uploadId = url.searchParams.get('uploadId') || '';
      const part = Number(url.searchParams.get('part') || 0);
      if (!safeKey(key) || !uploadId || !(part >= 1)) return json({ error: 'bad_request' }, 400, cors);
      const up = env.VIDEOS.resumeMultipartUpload(key, uploadId);
      const done = await up.uploadPart(part, req.body);
      return json({ part: done.partNumber, etag: done.etag }, 200, cors);
    }
    if (p === '/api/video/complete' && req.method === 'POST') {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401, cors);
      const { key, uploadId, parts } = await req.json().catch(() => ({}));
      if (!safeKey(key) || !uploadId || !Array.isArray(parts)) return json({ error: 'bad_request' }, 400, cors);
      const up = env.VIDEOS.resumeMultipartUpload(key, uploadId);
      const obj = await up.complete(parts.map(x => ({ partNumber: Number(x.part), etag: String(x.etag) })));
      return json({ ok: true, key, size: obj.size }, 200, cors);
    }
    if (p === '/api/video/abort' && req.method === 'POST') {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401, cors);
      const { key, uploadId } = await req.json().catch(() => ({}));
      if (!safeKey(key) || !uploadId) return json({ error: 'bad_request' }, 400, cors);
      try { await env.VIDEOS.resumeMultipartUpload(key, uploadId).abort(); } catch {}
      return json({ ok: true }, 200, cors);
    }

    // ── 동영상 내려주기 / 지우기 ──
    if (p.startsWith('/api/video/')) {
      const key = decodeURIComponent(p.slice('/api/video/'.length));
      if (req.method === 'GET') {
        // <video src> 는 헤더를 못 붙이므로 공개. 키를 알아야만 닿을 수 있다.
        return serveVideo(req, env, key, { 'Access-Control-Allow-Origin': '*' });
      }
      if (req.method === 'DELETE') {
        if (!authed(req, env)) return json({ error: 'unauthorized' }, 401, cors);
        if (!safeKey(key)) return json({ error: 'bad_request' }, 400, cors);
        await env.VIDEOS.delete(key);
        return json({ ok: true }, 200, cors);
      }
      return json({ error: 'method_not_allowed' }, 405, cors);
    }

    if (p === '/' || p === '/api/health') return json({ ok: true, service: 'origami-api' }, 200, cors);
    return new Response('Not Found', { status: 404, headers: cors });
  },
};
