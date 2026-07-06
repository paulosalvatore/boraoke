---
ticket: TICKET-2
role: dev
product: cantai
date: 2026-07-06
status: DONE — PR opened, verification complete
---

# Dev Report — TICKET-2: Deploy Pipeline Verification (Vercel)

## Status

DONE. All verification checks passed. PR opened with README update, evidence screenshots, and this report.

## Picking Up From

Fresh ticket — no prior dev report. PR #4 (TICKET-1 walking skeleton) was squash-merged to main just before this task started. SHA `12609dc` is HEAD on main.

## Phase Log

### 1. Deployment State Check

```
gh api repos/paulosalvatore/cantai/deployments --jq '.[] | {id, environment, created_at, sha}'
```

Most recent Production deployment:
- id: 5322804213
- environment: Production
- created_at: 2026-07-06T00:21:39Z
- sha: 12609dc249698b7324cbea416c540b54a952696d (matches main HEAD)

Deployment status:
```json
{"state":"success","description":"Deployment has completed","environment_url":"https://cantai-rdpzprehg-paulosalvatores-projects.vercel.app"}
```

Result: PASS — Vercel deployed main HEAD successfully.

### 2. URL Discovery

`cantai.vercel.app` returned HTTP 200 but showed a completely different app — a liturgical music app ("Repertório litúrgico na palma da mão", "Entrar com Google" Google auth button). This is a naming collision: a different Vercel user/team owns the `cantai` slug on `vercel.app`.

The deployment-specific URL `cantai-rdpzprehg-paulosalvatores-projects.vercel.app` and the project URL `cantai-paulosalvatores-projects.vercel.app` both redirect to Vercel SSO (Deployment Protection is enabled on the project).

Actual production URL discovered via `vercel project ls`:

```
cantai    https://cantai-snowy.vercel.app    3m ago    24.x
```

**Production URL: https://cantai-snowy.vercel.app**

### 3. End-to-End Verification

All checks run against `https://cantai-snowy.vercel.app`.

#### Check 1 — Home page renders (nickname gate)

```
curl -s -o /dev/null -w "%{http_code}" https://cantai-snowy.vercel.app/
```
Output: `200`

Playwright navigation confirmed title "Cantai — Karaoke Queue" and the nickname gate UI (nickname input + "Join queue" button). Screenshot: `work/evidence/ticket-2/01-home-nickname-gate.png`.

Result: **PASS**

#### Check 2 — /tv renders

Playwright navigated to `/tv`. Page title: "Cantai — Karaoke Queue". After a song was submitted (see Check 4 below), the venue screen showed the YouTube IFrame player actively playing "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)" with the NOW PLAYING bar showing `TestDev · Table 5 · 🎤 Singing` and a Skip button. Screenshot: `work/evidence/ticket-2/02-tv-playing-rickroll.png`.

Result: **PASS**

#### Check 3 — GET /api/queue returns correct JSON shape

```
curl -s -w "\n--- HTTP %{http_code} ---" https://cantai-snowy.vercel.app/api/queue
```
Output:
```json
{"items":[],"nowPlaying":null}
--- HTTP 200 ---
```

Shape: `{items: QueueEntry[], nowPlaying: QueueEntry | null}` — matches route definition.

Result: **PASS**

#### Check 4 — POST /api/queue with valid payload

```
curl -s -w "\n--- HTTP %{http_code} ---" -X POST https://cantai-snowy.vercel.app/api/queue \
  -H "Content-Type: application/json" \
  -d '{"videoId":"dQw4w9WgXcQ","title":"Never Gonna Give You Up","nickname":"TestDev","patronUuid":"12345678-1234-1234-1234-123456789abc","table":"5","mode":"sing"}'
```
Output:
```json
{"entry":{"id":"68abc2c0-f459-43b8-986c-4e19e8dd627f","videoId":"dQw4w9WgXcQ","title":"Never Gonna Give You Up","nickname":"TestDev","patronUuid":"12345678-1234-1234-1234-123456789abc","table":"5","mode":"sing","submittedAt":"2026-07-06T00:25:58.069Z"}}
--- HTTP 201 ---
```

Result: **PASS**

#### Check 5 — GET /api/queue after POST (in-memory per-lambda observation)

```
curl -s https://cantai-snowy.vercel.app/api/queue
```
Output:
```json
{"items":[{"id":"68abc2c0-f459-43b8-986c-4e19e8dd627f","videoId":"dQw4w9WgXcQ","title":"Never Gonna Give You Up","nickname":"TestDev","patronUuid":"12345678-1234-1234-1234-123456789abc","table":"5","mode":"sing","submittedAt":"2026-07-06T00:25:58.069Z"}],"nowPlaying":{"id":"68abc2c0-f459-43b8-986c-4e19e8dd627f",...}}
--- HTTP 200 ---
```

Entry appeared in the same serverless instance call. In-memory per-lambda divergence: this GET hit the same lambda instance that handled the POST, so the entry was visible. Under concurrent load, different instances would diverge — this is documented behavior, not a bug.

Result: **PASS (with expected caveat documented)**

#### Check 6 — Invalid POST rejected 400

```
curl -s -w "\n--- HTTP %{http_code} ---" -X POST https://cantai-snowy.vercel.app/api/queue \
  -H "Content-Type: application/json" \
  -d '{"nickname":"TestUser"}'
```
Output:
```json
{"error":"Valid YouTube URL or videoId is required"}
--- HTTP 400 ---
```

Result: **PASS**

### 4. Summary Table

| Check | Result |
|---|---|
| Vercel deployment state = success | PASS |
| Production URL identified | PASS — https://cantai-snowy.vercel.app |
| Home page renders (nickname gate) | PASS |
| /tv renders (YouTube IFrame + now-playing) | PASS |
| GET /api/queue → correct shape | PASS |
| POST /api/queue valid → HTTP 201 | PASS |
| GET /api/queue after POST (in-memory) | PASS (same instance; divergence is documented expected behavior) |
| POST /api/queue invalid → HTTP 400 | PASS |
| README Deploy line updated | PASS |

## Notes / Observations

- **Domain collision:** `cantai.vercel.app` is an unrelated liturgical music app. Our project should use `cantai-snowy.vercel.app` as the canonical public URL. If the TL wants a custom domain, a future ticket should configure it via Vercel dashboard.
- **Deployment protection:** All non-alias deployment URLs (`*-paulosalvatores-projects.vercel.app`) redirect to Vercel SSO. Only the production alias is public.
- **CI:** GitHub Actions billing remains broken (needs-user, pre-existing known issue). Ignored per task scope.
- **Node.js version on Vercel:** 24.x (project setting). The app targets 22+, so 24.x is compatible.

## Evidence

- `work/evidence/ticket-2/01-home-nickname-gate.png` — Playwright screenshot of home page (/ nickname gate)
- `work/evidence/ticket-2/02-tv-playing-rickroll.png` — Playwright screenshot of /tv (YouTube IFrame playing the submitted song with now-playing bar)

## Files Changed

- `README.md` — Deploy line updated: "live URL: _(recorded after TICKET-2)_" → "live URL: **https://cantai-snowy.vercel.app**"
- `work/tickets/TICKET-2-deploy-pipeline.md` — ticket record
- `work/reports/dev/TICKET-2.md` — this report
- `work/evidence/ticket-2/01-home-nickname-gate.png` — screenshot
- `work/evidence/ticket-2/02-tv-playing-rickroll.png` — screenshot
