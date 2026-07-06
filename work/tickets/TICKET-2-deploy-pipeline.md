---
ticket: TICKET-2
title: Deploy pipeline verification (Vercel)
product: cantai
status: DONE
actor: dev
date: 2026-07-06
---

# TICKET-2 — Deploy pipeline verification (Vercel)

## Objective

Verify that the Vercel production deployment of main (SHA `12609dc`, the TICKET-1 walking skeleton merged via PR #4) is live and working end-to-end. Update the README Deploy line with the live production URL. Record findings in the dev report.

## Scope

- Confirm production deployment state via GitHub Deployments API
- Identify the actual production URL (the `cantai.vercel.app` domain was a naming collision with an unrelated app)
- Verify all routes and API endpoints against the live URL
- Capture screenshots
- Update README
- Deliver via draft PR

## Acceptance Criteria

- [x] Production Vercel deployment state = `success` for main HEAD SHA
- [x] Live URL serves the karaoke patron page with nickname gate
- [x] `/tv` renders the venue screen with YouTube IFrame player
- [x] `GET /api/queue` returns `{"items":[],"nowPlaying":null}` shape
- [x] `POST /api/queue` with valid payload returns HTTP 201 with entry
- [x] `POST /api/queue` with invalid payload returns HTTP 400
- [x] README Deploy line updated with live URL
- [x] Evidence screenshots committed

## Findings / Notes

- **Naming collision:** `cantai.vercel.app` is owned by an unrelated app (liturgical music, "Repertório litúrgico na palma da mão"). Our Vercel project is `paulosalvatores-projects/cantai`.
- **Actual production URL:** `https://cantai-snowy.vercel.app` (discovered via `vercel project ls`).
- **Deployment protection:** All `*-paulosalvatores-projects.vercel.app` deployment-specific URLs redirect to Vercel SSO. Only the production domain alias (`cantai-snowy.vercel.app`) is publicly accessible.
- **In-memory per-lambda behavior:** The GET after POST correctly returned the entry in the same serverless instance. Divergence across concurrent instances remains expected per documented prototype limitations.
- **CI:** GitHub Actions billing-broken (known, needs-user) — ignored per task scope.
