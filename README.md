# 종이접기

유튜브 영상과 내가 찍은 동영상을 분류별로 모아 두고, **앱 안에서** 느리게·되풀이해 보며
따라 접는 개인용 PWA.

## 왜 앱 안에서 재생하나

종이접기는 어려운 대목을 **느리게, 몇 번이고** 돌려 봐야 한다. 링크를 눌러 유튜브 앱으로
보내 버리면 배속도 구간반복도 줄 수 없다. 그래서 재생기를 앱 안에 둔다.

| 종류 | 재생 | 배속·반복 |
|---|---|---|
| 유튜브 | IFrame Player API | ✅ (`setPlaybackRate`) |
| 내가 올린 동영상 | `<video>` + R2(Range) | ✅ |
| X · 페이스북 · 네이버 | — | ❌ 자기네 재생기만 허용하고 배속을 안 열어 준다 |

세 번째 줄 때문에 **이 앱은 유튜브와 동영상 파일만 받는다.** 받아 봤자 이 앱의 존재 이유인
느리게 보기가 안 되기 때문이다.

## 재생기

- **빠르기** 0.5x · 0.75x · 보통 · 1.25x
- **🔁 반복** 끝까지 가면 처음(또는 A 지점)으로
- **구간반복(A–B)** `A 여기` → `B 여기` 로 두 점을 찍으면 그 사이만 되풀이한다.
  0.25초마다 현재 시각을 보고 B 를 넘으면 A 로 되돌린다. 종이접기에서 제일 쓸모 있는 기능.
- ⏪ 5초 / 5초 ⏩

## 분류

분류는 미리 정해 두지 않는다. **등록할 때 목록에 없으면 `＋ 새 분류 만들기…` 를 골라
그 자리에서 만든다.** 등록을 멈추고 관리 화면으로 나갈 일이 없다.
탭의 `⚙` 로 이름을 한꺼번에 손볼 수도 있다(안에 영상이 있는 분류는 지워지지 않는다).

## 구조

```
index.html
assets/app.js      목록·등록·분류·재생기
assets/app.css     크림 종이 바탕 + 학의 산호빛
assets/icon.svg    종이학 로고(면만으로 접힌 결을 낸다)
sw.js              앱 껍데기 오프라인 캐시 — 영상·목록은 캐시하지 않는다
api/src/index.js   Cloudflare Worker
```

```
[PWA: GitHub Pages]
   │
   ▼
[Worker]  /api/data (KV)  ·  /api/preview (유튜브 제목)  ·  /api/video/* (R2)
   ▼
[KV origami-data]  목록 JSON      [R2 origami-videos]  동영상 파일
```

## 동영상 올리기

폰으로 찍은 영상은 수백 MB 라 한 번의 요청으로는 못 올린다(워커가 받을 수 있는 본문에
한도가 있다). R2 의 멀티파트 올리기로 **8MB 씩 조각내어** 보내고 마지막에 합친다.
올리다 실패하면 남은 조각을 지운다(`/api/video/abort`).

목록에 쓸 미리보기 그림은 **브라우저에서** 만든다 — 고른 파일의 한 장면을 캔버스로 떠
360px JPEG 로 줄여 목록 JSON 에 함께 둔다. 서버에 또 물어볼 것이 없다.

## API

| 엔드포인트 | 인증 | 용도 |
|---|---|---|
| `GET /api/data` | (없음) | 목록 읽기 |
| `PUT /api/data` | `X-Edit-Token` | 목록 저장 |
| `GET /api/preview?url=` | `X-Edit-Token` | 유튜브 제목·썸네일 |
| `POST /api/video/start` | `X-Edit-Token` | 올리기 시작 → key, uploadId |
| `PUT /api/video/part` | `X-Edit-Token` | 조각 올리기 |
| `POST /api/video/complete` · `abort` | `X-Edit-Token` | 합치기 · 치우기 |
| `GET /api/video/<key>` | (없음) | 재생 — Range 지원(없으면 건너뛰기가 안 된다) |
| `DELETE /api/video/<key>` | `X-Edit-Token` | 지우기 |

## 서버 준비(최초 1회)

```sh
cd api
npx wrangler kv namespace create ORIGAMI      # id 를 wrangler.toml 에
npx wrangler r2 bucket create origami-videos
echo "편집비밀번호" | npx wrangler secret put EDIT_TOKEN
npx wrangler deploy
```

## 로컬 실행

```sh
python3 -m http.server 8080
open http://localhost:8080/
```
(워커의 `ALLOWED_ORIGINS` 에 들어 있는 포트여야 서버와 이야기할 수 있다)
