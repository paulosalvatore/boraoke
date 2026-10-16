# TICKET-140 production verification

- **Date:** 2026-10-16
- **Merge:** PR #95 squash `423302152b2fb31da78958d9f30d2552f1957453`
- **Deploy:** GitHub deployment 7112306732 (Production), Vercel status `success` ("Deployment has completed").
- **Method:** headless Chromium (Playwright), phone viewport, pt-BR, never the TL's screen. Room reused: `t125-prod-verify-throwaway`. Harness: `work/evidence/TICKET-140/prod-verify/harness.cjs`. Raw log: `work/evidence/TICKET-140/prod-verify/run-log.txt`.
- **Live searches spent:** 0 (budget 1; extra live calls were route-blocked, none occurred).

## Results

| Check | Observed | Verdict |
|---|---|---|
| (a) paste `https://youtu.be/dQw4w9WgXcQ` | picker selects it and shows "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)" via `/api/video-meta` 200, no "Link do YouTube" placeholder (`a1-picker-title.png`). After "Adicionar à fila": `/api/queue` entry has title + channel "Rick Astley" + duration 3:34; patron queue shows the real title, no `youtu.be/…` label (`a2-queue-title.png`) | PASS |
| (b) type `Imagination`, no Enter | one index search (`q="Imagination karaoke"`, not live, 200, results) ; 0 "Link do YouTube" rows, nothing selected (`b-imagination-typed.png`) | PASS |
| (c) paste `olha essa https://youtu.be/dQw4w9WgXcQ kkk` | recognised: "Selecionada: dQw4w9WgXcQ" shown with the real title (`c-embedded-link.png`) | PASS |

Overall: **PASS**.

Cleanup: the patron UI has no self-remove, so the queued song (nickname `ProdVerify140`) stays in the throwaway room `t125-prod-verify-throwaway`.
