# boraoke backlog cleanup ledger, 2026-10-15 (APPLIED)

Status: **applied 2026-10-15** on the boraoke Product TM's decisions (see Apply record at the end). Evidence + dry-run were done by a subagent; the TM reviewed the draft and approved the apply.

## Header

- **Snapshot (Step 1):** `/Users/paulosalvatore/.local/state/house-backlog-cleanup/boraoke-20261015T161807/house-state.db.pre` (sha1 `8be991c68f3b420f11e75dbe85e30fade1e7315e`, identical to the live store at snapshot time and after the dry-runs).
- **Store:** `/Users/paulosalvatore/Documents/GitHub/agentic-software-house/.git/house-state.db`, schema_version 4, PK `(product, id)`. **0 boraoke rows before this pass.**
- **Product repo HEAD:** `4d1940eb5bb7fb20a3ff9665b143762269345db2` (main). `git status --short`: M `work/events/by-branch/ticket-125-enter-idle-search.jsonl`, M `work/status/MANAGER-LOG.md`, ?? `prompts/`, `work/evidence/TICKET-125/prod-verify/`, `work/heartbeats/`, `work/plans/EPIC-song-catalogue-plan.md`, `work/plans/SCOPE-search-cache-pagination.md`, `work/reports/testing/TICKET-125-prod-verify.md`, `work/tickets/TICKET-134..151` (18 files).
- **Foreman before-counts (boraoke filter):** 122 cards. Lanes: done 71, backlog 37, killed 10, todo 3, in_progress 1. Sources: git-pr 70, guess 37, store 11, markdown-unverified 4. Disagreements: 71.
- **Evidence limits:** `gh` was unreachable (DNS failure on api.github.com, 3 tries), so PR state comes from origin/main squash subjects `(#N)`, remote branches, and MANAGER-LOG. Open PR #90 is taken from MANAGER-LOG UPDATE 2026-10-15. No closed-unmerged PR could be checked; none of the outcomes below depends on one.
- **Corpus:** 130 ids = foreman board ∪ `work/tickets/*.md` ∪ the stray `boraoke/.git/house-state.db` ids, plus TICKET-126 (open PR #90; spec only on its branch). TICKET-127/131/132/133 exist only on the #90 branch and are left out of this pass.

## Apply notes (for the TM)

- **Run `scripts/ticket` with cwd = the framework checkout** (or `--repo /Users/paulosalvatore/Documents/GitHub/agentic-software-house`). It picks the store from the cwd's git-common-dir. Run from boraoke and it writes into the stray `boraoke/.git/house-state.db`.
- Main file: `/private/tmp/claude-501/-Users-paulosalvatore-Documents-GitHub-agentic-software-house/045d8d27-ae25-49af-8660-a80f0a1287b0/scratchpad/cleanup/cleanup-boraoke.json` (97 cards). Held: `/private/tmp/claude-501/-Users-paulosalvatore-Documents-GitHub-agentic-software-house/045d8d27-ae25-49af-8660-a80f0a1287b0/scratchpad/cleanup/cleanup-boraoke-collisions.json` (31 cards, see Collisions), `/private/tmp/claude-501/-Users-paulosalvatore-Documents-GitHub-agentic-software-house/045d8d27-ae25-49af-8660-a80f0a1287b0/scratchpad/cleanup/cleanup-boraoke-ticket2.json` (TICKET-2, frontmatter `product: cantai`).
- No ticket has a `type:` frontmatter, so every import lands as `type=framework`.
- **Reverse column:** "import → filed" means `echo '{"tickets":{"<id>":{"status":"filed","product":"boraoke"}}}' | bash scripts/ticket import --reduced -` (from the framework cwd). "snapshot restore (new row)" means the card was not in the store before, so the only true undo is restoring the Step 1 snapshot.

## Outcome tally

SHIPPED 88 · ACTIVE 36 · RESCOPE 2 (67, 111) · BLOCKED 2 (107, 110) · DROP 1 (59) · SUPERSEDED 0 · ASK 0 (cap 5) · TM-call 2 (24, 57, excluded from the JSON).

After-states proposed (main + collision files): done 87, filed/draft 32, planned 2, in_progress 2, in_review 2, blocked 2, killed 1. TICKET-2 (done) is held for its frontmatter.

## Rows

| id | before (lane/source[/D=disagreement]) | outcome | evidence | command | reverse |
|---|---|---|---|---|---|
| TICKET-0 | done/markdown-unverified | SHIPPED | bootstrap commit `4a55484` 2026-07-05; W9 definition in ticket; TICKET-1..5 merged on top | import → done | import → filed |
| TICKET-1 | done/git-pr/D | SHIPPED | merged PR #4 `12609dc` on origin/main | import → done | import → filed |
| TICKET-2 | done/git-pr/D | SHIPPED | merged PR #6 `a9df385` on origin/main | frontmatter `product: cantai` → `boraoke`, then import → done (ticket2 file) | import → filed |
| TICKET-3 | done/git-pr/D | SHIPPED | merged PR #3 `73b452d` on origin/main | import → done (collisions file) | import → filed |
| TICKET-4 | done/git-pr/D | SHIPPED | merged PR #2 `679145b` on origin/main | import → done (collisions file) | import → filed |
| TICKET-5 | done/git-pr/D | SHIPPED | merged PR #1 `a1db16b` on origin/main | import → done (collisions file) | import → filed |
| TICKET-6 | done/git-pr/D | SHIPPED | merged PR #7 `8e51e9b` on origin/main | import → done (collisions file) | import → filed |
| TICKET-7 | done/git-pr/D | SHIPPED | merged PR #10 `348ff84` on origin/main | import → done (collisions file) | import → filed |
| TICKET-8 | done/git-pr/D | SHIPPED | merged PR #8 `01c87ec` on origin/main | import → done (collisions file) | import → filed |
| TICKET-9 | done/git-pr/D | SHIPPED | merged PR #13 `1d08b0a` on origin/main | import → done (collisions file) | import → filed |
| TICKET-10 | killed/store/D | SHIPPED | merged PR #14 `bfeecd7` on origin/main; stray boraoke/.git store says killed — wrong, PR merged | import → done (collisions file) | import → filed |
| TICKET-11 | done/git-pr/D | SHIPPED | merged PR #11 `852ca86` on origin/main | import → done (collisions file) | import → filed |
| TICKET-12 | done/git-pr/D | SHIPPED | merged PR #12 `0c8a639` on origin/main | import → done | import → filed |
| TICKET-18 | killed/store/D | SHIPPED | merged PR #9 `6471301` on origin/main; stray boraoke/.git store says killed — wrong, PR merged | import → done (collisions file) | import → filed |
| TICKET-19 | done/git-pr/D | SHIPPED | merged PR #5 `18e8324` on origin/main | import → done (collisions file) | import → filed |
| TICKET-20 | done/git-pr/D | SHIPPED | merged PR #17 `da28d0a` on origin/main; md status line in_progress is stale | import → done (collisions file) | import → filed |
| TICKET-21 | killed/store/D | SHIPPED | merged PR #16 `b271d57` on origin/main; stray boraoke/.git store says killed — wrong, PR merged | import → done (collisions file) | import → filed |
| TICKET-22 | killed/store/D | SHIPPED | merged PR #15 `60448c9` on origin/main; stray boraoke/.git store says killed — wrong, PR merged | import → done (collisions file) | import → filed |
| TICKET-23 | done/git-pr/D | SHIPPED | merged PR #18 `e2977f4` on origin/main | import → done | import → filed |
| TICKET-24 | in_progress/store | TM-CALL | no spec anywhere; umbrella 'PR #14 hardening batch' (MANAGER-LOG:1073); known parts shipped: 24a #27 `c456c75`, merge=union `.gitattributes` | — (excluded) | — |
| TICKET-26 | done/git-pr/D | SHIPPED | merged PR #37 `dba1cbb` on origin/main | import → done (collisions file) | import → filed |
| TICKET-30 | off-board (stray-store or branch only) | SHIPPED | merged PR #23 `e798de5` on origin/main | import → done | import → filed |
| TICKET-31 | done/git-pr/D | SHIPPED | merged PR #38 `f9a1e3e` on origin/main | import → done (collisions file) | import → filed |
| TICKET-33 | done/git-pr/D | SHIPPED | merged PR #20 `a1129ed` on origin/main | import → done (collisions file) | import → filed |
| TICKET-40 | done/git-pr/D | SHIPPED | merged PR #21 `af156a7` on origin/main | import → done (collisions file) | import → filed |
| TICKET-41 | done/git-pr/D | SHIPPED | merged PR #24 `8fc47cc` on origin/main | import → done (collisions file) | import → filed |
| TICKET-43 | done/git-pr/D | SHIPPED | merged PR #22 `b97289e` on origin/main | import → done | import → filed |
| TICKET-44 | done/git-pr/D | SHIPPED | merged PR #25 `b06085d` on origin/main | import → done (collisions file) | import → filed |
| TICKET-45 | done/git-pr/D | SHIPPED | merged PR #26 `5ad54bb` on origin/main | import → done (collisions file) | import → filed |
| TICKET-46 | done/git-pr/D | SHIPPED | merged PR #28 `a9f1b7b` on origin/main | import → done (collisions file) | import → filed |
| TICKET-47 | done/git-pr/D | SHIPPED | merged PR #29 `9e90206` on origin/main | import → done (collisions file) | import → filed |
| TICKET-48 | done/git-pr/D | SHIPPED | merged PR #30 `4c6d124` on origin/main | import → done (collisions file) | import → filed |
| TICKET-49 | done/git-pr/D | SHIPPED | merged PR #31 `c6db4e6` on origin/main | import → done (collisions file) | import → filed |
| TICKET-50 | done/git-pr/D | SHIPPED | merged PR #32 `3160cc4` on origin/main | import → done | import → filed |
| TICKET-51 | done/git-pr/D | SHIPPED | merged PR #33 `c78ff5e` on origin/main | import → done | import → filed |
| TICKET-52 | done/git-pr/D | SHIPPED | merged PR #34 `870687c` on origin/main | import → done | import → filed |
| TICKET-53 | done/git-pr/D | SHIPPED | merged PR #35 `dc63227` on origin/main | import → done (collisions file) | import → filed |
| TICKET-54 | done/git-pr/D | SHIPPED | merged PR #36 `1f24e33` on origin/main | import → done | import → filed |
| TICKET-55 | done/git-pr/D | SHIPPED | merged PR #39 `3f5323c` on origin/main | import → done | import → filed |
| TICKET-56 | done/git-pr/D | SHIPPED | merged PR #40 `46d25cd` on origin/main | import → done (collisions file) | import → filed |
| TICKET-57 | off-board (stray-store or branch only) | TM-CALL | no spec; part (a) #41 `c7951c7`; part (b) de-cantai docs partly done by heartbeats (MANAGER-LOG:729,834) | — (excluded) | — |
| TICKET-58 | done/git-pr/D | SHIPPED | merged PR #42 `37a4035` on origin/main | import → done | import → filed |
| TICKET-59 | backlog/guess | DROP | decision: TL chose WON'T-DO 2026-08-06 (ticket line 3 + Resolution section) — main left unprotected deliberately | import → abandoned | import → filed |
| TICKET-60 | done/git-pr/D | SHIPPED | merged PR #44 `55edfa4` on origin/main | import → done (collisions file) | import → filed |
| TICKET-61 | killed/store/D | SHIPPED | merged PR #45 `9aa857c` on origin/main; stray boraoke/.git store says killed — wrong, PR merged | import → done | import → filed |
| TICKET-62 | killed/store/D | SHIPPED | merged PR #46 `3199fd9` on origin/main; stray boraoke/.git store says killed — wrong, PR merged | import → done | import → filed |
| TICKET-63 | done/git-pr/D | SHIPPED | merged PR #43 `c7d617c` on origin/main | import → done (collisions file) | import → filed |
| TICKET-64 | off-board (stray-store or branch only) | SHIPPED | merged PR #47 `47d1f89` on origin/main | import → done | import → filed |
| TICKET-65 | done/git-pr/D | SHIPPED | merged PR #48 `e5ab830` on origin/main | import → done | import → filed |
| TICKET-66 | done/git-pr/D | SHIPPED | merged PR #49 `118ad06` on origin/main; md says OPEN/needs TL — stale, merged | import → done (collisions file) | import → filed |
| TICKET-67 | todo/markdown-unverified | RESCOPE | MED-1 shipped (#74 `lib/embed-cache.ts`), MED-3 shipped (`lib/youtube.ts:102` timeout 800 ms); MED-2 OPEN: `lib/queue-rate-limit.ts:34` still in-memory `Map` (overlaps TICKET-140 item 8) | import → filed (collisions file), body rescoped | snapshot restore (new row) |
| TICKET-68 | todo/markdown-unverified | ACTIVE | unmet: bare default-timeout `waitFor()` still at `e2e/host-controls.spec.ts:36` and `e2e/rotation-modes.spec.ts:44` | import → filed | snapshot restore (new row) |
| TICKET-69 | done/git-pr/D | SHIPPED | merged PR #52 `cf1336e` on origin/main | import → done | import → filed |
| TICKET-70 | done/git-pr/D | SHIPPED | merged PR #50 `be59814` on origin/main | import → done | import → filed |
| TICKET-71 | done/git-pr/D | SHIPPED | merged PR #51 `de9e98c` on origin/main | import → done | import → filed |
| TICKET-72 | done/git-pr/D | SHIPPED | merged PR #57 `0f58c7b` on origin/main | import → done | import → filed |
| TICKET-73 | done/git-pr/D | SHIPPED | merged PR #55 `98721ab` on origin/main; `app/metadata.ts:63` viewportFit cover; real-device check residue carried by TICKET-81 | import → done | import → filed |
| TICKET-74 | done/git-pr/D | SHIPPED | merged PR #55 `98721ab` on origin/main | import → done | import → filed |
| TICKET-75 | done/git-pr/D | SHIPPED | merged PR #54 `e278106` on origin/main | import → done | import → filed |
| TICKET-76 | done/git-pr/D | SHIPPED | merged PR #53 `11b8b33` on origin/main | import → done | import → filed |
| TICKET-77 | done/git-pr/D | SHIPPED | merged PR #56 `d8f5fc1` on origin/main | import → done | import → filed |
| TICKET-78 | killed/store/D | SHIPPED | merged PR #59 `f9f648d` on origin/main; stray boraoke/.git store says killed — wrong, PR merged | import → done | import → filed |
| TICKET-79 | done/git-pr/D | SHIPPED | merged PR #67 `5a06b48` on origin/main | import → done | import → filed |
| TICKET-80 | backlog/guess | ACTIVE | unmet: only `app/api/host/analytics/route.ts` exists, site-wide `requireHost`; no room-scoped endpoint | import → filed | snapshot restore (new row) |
| TICKET-81 | backlog/guess | ACTIVE | unmet: no `safe-area-inset-top` anywhere in app/ or components/ (only -bottom) | import → filed | snapshot restore (new row) |
| TICKET-82 | off-board (stray-store or branch only) | SHIPPED | merged PR #61 `ec09dfb` on origin/main | import → done | import → filed |
| TICKET-83 | done/git-pr/D | SHIPPED | merged PR #63 `0677c16` on origin/main | import → done | import → filed |
| TICKET-84 | off-board (stray-store or branch only) | SHIPPED | merged PR #60 `cc67822` on origin/main | import → done | import → filed |
| TICKET-85 | off-board (stray-store or branch only) | SHIPPED | merged PR #58 `b57b7fa` on origin/main | import → done | import → filed |
| TICKET-86 | done/git-pr/D | SHIPPED | merged PR #62 `f9c905b` on origin/main | import → done | import → filed |
| TICKET-87 | done/git-pr/D | SHIPPED | merged PR #65 `d2068aa` on origin/main | import → done | import → filed |
| TICKET-88 | done/git-pr/D | SHIPPED | merged PR #68 `965f3c0` on origin/main | import → done | import → filed |
| TICKET-89 | done/git-pr/D | SHIPPED | merged PR #66 `ea50d01` on origin/main | import → done | import → filed |
| TICKET-90 | done/git-pr/D | SHIPPED | merged PR #64 `3d8d501` on origin/main; + follow-up #71 `0343328` | import → done | import → filed |
| TICKET-91 | done/git-pr | SHIPPED | merged PR #69 `6f4987d` on origin/main | import → done | import → filed |
| TICKET-92 | done/git-pr | SHIPPED | merged PR #70 `5fe5c20` on origin/main | import → done | import → filed |
| TICKET-93 | killed/store/D | SHIPPED | merged PR #72 `6e51795` on origin/main; stray boraoke/.git store says killed — wrong, PR merged | import → done | import → filed |
| TICKET-94 | killed/store/D | SHIPPED | merged PR #78 `1233443` on origin/main; stray boraoke/.git store says killed — wrong, PR merged | import → done | import → filed |
| TICKET-95 | off-board (stray-store or branch only) | SHIPPED | merged PR #74 `4966e5a` on origin/main | import → done | import → filed |
| TICKET-96 | off-board (stray-store or branch only) | SHIPPED | merged PR #73 `da1baaa` on origin/main | import → done | import → filed |
| TICKET-97 | backlog/guess | ACTIVE | unmet: `components/tv/TvScreen.tsx:414` handles only 401; 429 falls through and returns the unchanged head | import → filed | snapshot restore (new row) |
| TICKET-98 | killed/store/D | SHIPPED | merged PR #76 `3dc9a8d` on origin/main; stray boraoke/.git store says killed — wrong, PR merged | import → done | import → filed |
| TICKET-99 | done/git-pr | SHIPPED | merged PR #80 `61a3c06` on origin/main | import → done | import → filed |
| TICKET-100 | backlog/guess | ACTIVE | unmet AC1: no written design with TL decisions (only refs: BOARD, MANAGER-LOG, TL-REAL-TEST); ADVANCE_AUTH=enforce still deferred as entangled (MANAGER-LOG:299) | import → filed | snapshot restore (new row) |
| TICKET-101 | done/git-pr | SHIPPED | merged PR #79 `98f876e` on origin/main; + #77 `4092d49`; TL-approved, prod-verified per MANAGER-LOG 10-09 | import → done | import → filed |
| TICKET-102 | backlog/guess | SHIPPED | fix in #80 `61a3c06`: globalThis shim `app/layout.tsx:65`; harness proven both ways (MANAGER-LOG 10-09 PR #80 entry). Optional class-gate was 'proposed, not built', not an AC | import → done | import → filed |
| TICKET-103 | done/git-pr/D | SHIPPED | merged PR #83 `9aab6b0` on origin/main | import → done | import → filed |
| TICKET-104 | done/git-pr/D | SHIPPED | merged PR #81 `efb90b2` on origin/main | import → done | import → filed |
| TICKET-105 | backlog/guess | ACTIVE | unmet: no commit to `PatronRoom.tsx` since filing 09-27; form not redesigned | import → filed | snapshot restore (new row) |
| TICKET-106 | done/git-pr/D | SHIPPED | merged PR #82 `f5fc2fa` on origin/main | import → done | import → filed |
| TICKET-107 | backlog/guess | BLOCKED | blocker: TL must supply a SEPARATE test YouTube key + pick key tiers (MANAGER-LOG:191); clears when the key exists. `vault/tiers.conf` has no boraoke entry | import → blocked | import → filed |
| TICKET-108 | done/git-pr/D | SHIPPED | merged PR #84 `6658fb9` on origin/main | import → done | import → filed |
| TICKET-109 | done/git-pr/D | SHIPPED | merged PR #85 `32e58cb` on origin/main | import → done | import → filed |
| TICKET-110 | backlog/guess | BLOCKED | blocker: real LG webOS hardware in the TL's hands (MANAGER-LOG:191); clears when TL runs the device check | import → blocked | import → filed |
| TICKET-111 | backlog/guess | RESCOPE | item 1 shipped (#88 `c8de70e`: `search_performed` carries source cache/index/live, `app/api/search/route.ts:170,191,273`); item 2 OPEN (planSearch decision reason untracked, `components/SongSearch.tsx:223,542`); item 3 → TICKET-107 | import → filed, body rescoped to item 2 | snapshot restore (new row) |
| TICKET-112 | done/git-pr | ACTIVE | TL decided 2026-10-15 (ticket 'TL decision' section): logout = this device only; queued after 125/126; nothing on main yet. foreman 'done' is a false match on #92 which only recorded the decision | import → planned | import → filed |
| TICKET-113 | backlog/guess | ACTIVE | unmet: TV specs only at 1920x1080 (`e2e/tv.spec.ts:14`, `e2e/tv-watchdog.spec.ts:15`) | import → filed | snapshot restore (new row) |
| TICKET-114 | backlog/guess | ACTIVE | unmet: investigation report not written (no commit/report referencing it beyond filing `9268202`) | import → filed | snapshot restore (new row) |
| TICKET-115 | backlog/guess | SHIPPED | #81 `efb90b2`: `app/api/host/session/route.ts` POST refuses `isCrossSiteRequest // !requireHost`; tests in `__tests__/host-claim.test.ts`, `e2e/creator-reentry.spec.ts` | import → done | import → filed |
| TICKET-116 | done/git-pr/D | SHIPPED | merged PR #86 `c0e10cb` on origin/main | import → done | import → filed |
| TICKET-117 | backlog/guess | ACTIVE | unmet: non-placeholder literal still at `work/reports/testing/TICKET-11-app-test.md:8`; question answered (benign), body already reduced to 'Remaining work' | import → filed | snapshot restore (new row) |
| TICKET-118 | backlog/guess | ACTIVE | worktree `t118-session-revocation` @33006c9, branch pushed, no PR (MANAGER-LOG UPDATE 10-15) | import → in_progress | import → filed |
| TICKET-119 | backlog/guess | ACTIVE | carried by open PR #90 (TICKET-126, 'trusted IP/119'); closes after post-deploy zero-data claim probe (MANAGER-LOG UPDATE 10-15) | import → in_review | import → filed |
| TICKET-120 | done/git-pr | SHIPPED | merged PR #91 `b249326` on origin/main | import → done | import → filed |
| TICKET-121 | todo/markdown-unverified | ACTIVE | unmet: `playwright.config.ts:66` workers: 1. TWO spec files shared this id; kept `shared-default-room-blocks-parallel-e2e`, deleted `e2e-parallel-safety-shared-default-room` | import → filed | snapshot restore (new row) |
| TICKET-122 | off-board (stray-store or branch only) | SHIPPED | #87 `2d16c1d` (branch ticket/122-vercel-deploy-gate): `vercel.json` git.deploymentEnabled main-only on origin/main | import → done | import → filed |
| TICKET-123 | backlog/guess | ACTIVE | unmet: `.github/workflows/ci.yml` triggers only `on: pull_request` | import → filed | snapshot restore (new row) |
| TICKET-124 | done/git-pr | SHIPPED | merged PR #88 `c8de70e` on origin/main | import → done | import → filed |
| TICKET-125 | done/git-pr | SHIPPED | merged PR #89 `4d1940e` on origin/main | import → done | import → filed |
| TICKET-128 | done/git-pr | ACTIVE | unmet: `components/SongSearch.tsx:406` only `daily-limit` hides load-more. foreman 'done' = false match on #92 (it filed the ticket) | import → filed | snapshot restore (new row) |
| TICKET-129 | backlog/guess | ACTIVE | unmet: no 1280x720 TV layout check exists | import → filed | snapshot restore (new row) |
| TICKET-130 | backlog/guess | ACTIVE | unmet: `lib/karaoke-index/store.ts:143-152` short retry only on FAILED load, not empty | import → filed | snapshot restore (new row) |
| TICKET-134 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-135 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-136 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-137 | backlog/guess | ACTIVE | new 2026-10-15; TL promoted to wanted (MANAGER-LOG prompt 021); needs rewiring onto 144 | import → planned | import → filed |
| TICKET-138 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-139 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-140 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-141 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-142 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-143 | backlog/guess | ACTIVE | Dev building now, worktree `t143-title-parser` @4d1940e | import → in_progress | import → filed |
| TICKET-144 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-145 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-146 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-147 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-148 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-149 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-150 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-151 | backlog/guess | ACTIVE | new 2026-10-15, uncommitted on main; no code yet | import → filed | snapshot restore (new row) |
| TICKET-126 | off-board (stray-store or branch only) | ACTIVE | open PR #90, worktree t126-search-limits (MANAGER-LOG UPDATE 10-15); spec file only on branch | import → in_review | import → filed |

## Collisions (Step 3)

31 boraoke ids also exist in the house store under another product. framework: 10, 11, 21, 22, 33, 44, 46, 47, 48, 53, 56, 60, 63, 66, 67. atek-gerenciamento: 3, 4, 5, 6, 7, 8, 9, 26, 40, 45, 49. quiz-ilp: 18, 19, 20. rachei: 41. deixapronto: 31.

The skill says a store collision silently overwrites, because `id` alone is the PK. **That is no longer true of the live store.** It is schema v4, `PRIMARY KEY (product, id)` (migration v2 ran 2026-07-30), and `cmd_import` reads and writes `WHERE product=? AND id=?`. The collision dry-run confirms it: every row lands as `boraoke/<id>` and does not touch the other product's row. What still bites: (a) foreman fuses rachei TICKET-41 into the boraoke card, because the git-pr match is by id; (b) any bare-id `ticket move/kill/block` on these ids exits 2 as ambiguous, so pass `--product boraoke`. They are held in a separate file until the TM decides (TM-call 1).

## ASK list (0 of cap 5)

None. Everything left over is a TM call, below.

## TM-call list (with recommendation)

1. **Enroll the 31 collision ids?** Rec: **yes**, apply `cleanup-boraoke-collisions.json`. The PK is `(product,id)` and the dry-run proves rows stay separate. Always pass `--product boraoke` on later verbs. Also send a framework inbox note that the backlog-cleanup Step 3 premise is stale.
2. **TICKET-2 frontmatter says `product: cantai`** (`work/tickets/TICKET-2-deploy-pipeline.md`). `cantai` is not in `scripts/product-aliases.tsv`, and the dry-run shows `IMPORT cantai/TICKET-2`. Rec: change the frontmatter to `product: boraoke`, then import the ticket2 file. Also file a framework inbox note to add the alias `cantai → boraoke`.
3. **Stray store `boraoke/.git/house-state.db`** holds 63 boraoke + 19 cantai + 26 framework rows, all stamped 2026-10-14T15:18:01Z. Someone ran `ticket` from the boraoke cwd. Foreman reads it and it is where the false `killed` states come from (10, 18, 21, 22, 61, 62, 78, 93, 94, 98 were all merged). Rec: after the apply, archive and remove it (it is machine-local, untracked), and file a framework inbox note: `scripts/ticket` should refuse to create a store outside the framework checkout.
4. **TICKET-24 and TICKET-57** have no spec anywhere and exist only in the stray store. Rec: leave them unenrolled. They disappear from the board when the stray store goes. If you want a record, import 24 as `done` (24a #27, `.gitattributes` union driver) and 57 as `done` (#41 plus the heartbeat H1 fixes).
5. **TICKET-121 has two spec files** (`TICKET-121-e2e-parallel-safety-shared-default-room.md`, `TICKET-121-shared-default-room-blocks-parallel-e2e.md`). Rec: keep `shared-default-room-blocks-parallel-e2e` (it has the acceptance criteria and filing provenance), merge in anything unique, and delete the other in a PR.
6. **TICKET-137 state.** Enrolled as `planned` because the TL promoted it to wanted. The brief's wording ("enroll at filed, except 137, which is wanted and filed") is ambiguous. Rec: `planned`. Flip it to `filed` in the JSON if you meant that.
7. **TICKET-67 residue (MED-2, cross-instance submit limiter)** overlaps TICKET-140 item 8, but 140's acceptance criteria do not require fixing it. Rec: RESCOPE 67 to MED-2 only. The alternative is to add a MED-2 criterion to 140 and kill 67 as `superseded-by:TICKET-140`.
8. **`type` field.** No ticket has `type:` frontmatter, so every row imports as `framework`. Rec: accept it for now and file a framework inbox note to default to `feature` for non-framework products.
9. **Rewrite bodies for RESCOPE 67 and 111** down to the residue, and add machine-readable `status:` frontmatter to the remaining ACTIVE cards (Step 5 metadata fix). Both are TM apply-step work.

## Apply record (2026-10-15)

### TM decisions taken

1. TICKET-2 frontmatter `product: cantai` → `product: boraoke`; re-run dry-run showed `IMPORT boraoke/TICKET-2 -> done (9 gate_facts)` (was `IMPORT cantai/TICKET-2`).
2. All three files imported (main, collisions, ticket2). The collision ids enroll as `boraoke/<id>`; the other products' rows are untouched (spot-check below).
3. TICKET-137 enrolled as `planned`. TICKET-24 and TICKET-57 left out (they vanish with the stray store). `type=framework` accepted for all 129 rows.
4. RESCOPE bodies rewritten: TICKET-67 down to MED-2 (the submit rate limiter is per-instance, `lib/queue-rate-limit.ts:34`); TICKET-111 down to item 2 (record the `planSearch` decision reason). TICKET-121: kept `TICKET-121-shared-default-room-blocks-parallel-e2e.md` (has Constraints, Acceptance and filing provenance), folded in the four facts only the duplicate had (advance-route 12/room/60s cap, nine seeding specs, `ROOM_CREATE_LIMIT`/`served-lang.spec.ts` note, the `cold-run.sh` harness, the Out-of-scope line), deleted `TICKET-121-e2e-parallel-safety-shared-default-room.md`.
5. Machine-readable frontmatter (`ticket`, `product`, `status`) added to every ACTIVE card with a spec on main (34 cards plus 67, 111, 121). The `status:` value is the store token (`filed` = store `draft`, `planned`, `in_progress`, `in_review`). TICKET-126 has no spec on main (it lives on the PR #90 branch), so it has no frontmatter yet.
6. Stray store retired: `boraoke/.git/house-state.db` (sha1 `c3a4fb28c555d0e9be72412f234f3fbdfa56f45d`; 63 boraoke + 19 cantai + 26 framework rows) and its `-shm`/`-wal` sidecars renamed to `house-state.db.retired-2026-10-15{,-shm,-wal}`. WAL was empty, nothing held the file open. Renamed, not deleted.

### Commands run (cwd = `/Users/paulosalvatore/Documents/GitHub/agentic-software-house`)

- Fresh snapshot before apply: `/Users/paulosalvatore/.local/state/house-backlog-cleanup/boraoke-20261015T163736/house-state.db.pre` (sha1 `8be991c68f3b420f11e75dbe85e30fade1e7315e`, same as the earlier snapshot; 0 boraoke rows).
- Dry-runs re-run and diffed against the draft dry-runs: main and collisions identical (97 and 31 `IMPORT boraoke/` lines); ticket2 changed only `cantai` → `boraoke`.
- `bash scripts/ticket import --reduced <scratch>/cleanup-boraoke.json --tickets-dir /Users/paulosalvatore/Documents/GitHub/boraoke/work/tickets` → rc 0, reconcile complete
- `bash scripts/ticket import --reduced <scratch>/cleanup-boraoke-collisions.json --tickets-dir …/boraoke/work/tickets` → rc 0
- `bash scripts/ticket import --reduced <scratch>/cleanup-boraoke-ticket2.json --tickets-dir …/boraoke/work/tickets` → rc 0
- `mv boraoke/.git/house-state.db{,-shm,-wal} boraoke/.git/house-state.db.retired-2026-10-15{,-shm,-wal}`

### After-counts (`bash scripts/ticket list --product boraoke`, 129 rows)

done 88 · draft 32 · planned 2 · in_progress 2 · in_review 2 · blocked 2 · killed 1. Matches the tally: SHIPPED 88 = done; DROP 1 = killed; BLOCKED 2 = blocked; ACTIVE 36 + RESCOPE 2 = draft 32 + planned 2 + in_progress 2 + in_review 2. All 129 rows `type=framework`.

### Collision spot-check (other product's row, before vs after, byte-identical)

framework/TICKET-10 (draft), atek-gerenciamento/TICKET-3 (killed), quiz-ilp/TICKET-18 (draft), rachei/TICKET-41 (draft), deixapronto/TICKET-31 (draft): all unchanged. Store totals for other products unchanged (framework 321, rachei 25, atek-gerenciamento 21, quiz-ilp 6, deixapronto 1, …).

### Reverse commands

- One card: `echo '{"tickets":{"<id>":{"status":"filed","product":"boraoke"}}}' | bash scripts/ticket import --reduced -` from the framework cwd (adds a corrective event; the audit survives).
- Whole pass: restore `/Users/paulosalvatore/.local/state/house-backlog-cleanup/boraoke-20261015T163736/house-state.db.pre` over `agentic-software-house/.git/house-state.db` (discards every event of this pass; this ledger is the surviving record).
- Stray store: `cd boraoke/.git && for x in "" -shm -wal; do mv "house-state.db.retired-2026-10-15$x" "house-state.db$x"; done`.
- Ticket-file edits: `git checkout -- work/tickets/` in the boraoke checkout (before they are committed).

### Framework inbox notes filed

- `work/self-improvement/inbox/2026-10-15-ticket-cwd-local-store.md`
- `work/self-improvement/inbox/2026-10-15-backlog-cleanup-step3-stale.md`
- `work/self-improvement/inbox/2026-10-15-product-alias-cantai.md`
- `work/self-improvement/inbox/2026-10-15-ticket-import-default-type.md`

### Left for the TM

- This ledger and the ticket-file edits are uncommitted in the boraoke main checkout on purpose; they ride the next main push.
- TICKET-63 and TICKET-77 frontmatter still say `in-review` while the store says `done` (import logged "event log wins"). Cosmetic, not touched.
