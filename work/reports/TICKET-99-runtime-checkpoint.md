# TICKET-99 — RUNTIME half checkpoint (fleet throttle stop)

**Status:** PAUSED mid-investigation on explicit fleet-wide throttle instruction (host load ~166/16 cores). Nothing broken, nothing lost — this is a deliberate stop, not a failure. All heavy processes killed, port freed, worktree left in place.

## What "done" means here
No script has been committed yet (`scripts/tv-runtime-check.mjs` does not exist in this worktree). What exists is a manual feasibility probe of the launch step, run directly in the shell against a scratch copy of the pinned Chromium build — not yet against boraoke itself.

## What was completed / verified

1. **Worktree created**: `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t99-runtime`, branch `ticket/99-runtime-check`, based on current `main` (`a576af0`, which already has PR #76 + #77 merged and live).
2. **Read the two existing gates** (`scripts/check-bundle-es-target.mjs`, `scripts/check-css-target.mjs`) to match conventions: constant-with-comment for the target version, collect-files-then-report-failures shape, `process.exit(1)` on empty scan or on failure, no piping through `tail`/`grep`.
3. **Read the /tv route and TvScreen component** to pick real assertion selectors (not guessed):
   - Route: `app/(patron)/[room]/tv/page.tsx` renders `<TvScreen>` inside a room-scoped `NextIntlClientProvider`. Also a legacy `app/tv/page.tsx` that redirects `/tv?room=X` → `/[room]/tv` (bare `/tv` → `default` room).
   - `components/tv/TvScreen.tsx` — stable `data-testid` attributes that are ALWAYS present regardless of queue state: `tv-root` (line ~875, outer container) and `tv-chrome` (line ~1010, bottom control bar). When the queue is empty (expected for a fresh `default` room) it renders `tv-idle` (~989) instead of `tv-hero`/`tv-singer`/`tv-mic-call`. **Plan: assert `tv-root` + `tv-chrome` always; assert `tv-idle` OR `tv-hero` present as the "meaningful DOM" check** — this covers both queue states without guessing which one a given `--url` will be in.
4. **Ports**: 3100 is already in use by another agent's process on this machine; 3040 is reserved for the TM. **Decision: use 3099** for any dev/preview server this ticket needs.
5. **Pre-fix commit identified**: `58b44f8` — parent of `3dc9a8d` (`TICKET-98: downlevel dependency syntax so the app can boot on a TV, and gate it at build time (#76)`). This is the commit to build for the "known-bad" negative control.
6. **Chromium 68 snapshot re-confirmed downloadable**: `https://commondatastorage.googleapis.com/chromium-browser-snapshots/Mac/561733/chrome-mac.zip` → HTTP 200, 83274257 bytes, downloaded successfully to a scratch dir (NOT committed, NOT in the repo). Unzipped to `chrome-mac/Chromium.app`. Binary confirmed `Mach-O 64-bit executable x86_64` (`file` output). `xattr -cr` clears quarantine cleanly (only `com.apple.provenance` was present, which is not a Gatekeeper blocker).
7. **Launch probe — INCONCLUSIVE, needs re-run once load clears.** Ran (outside the repo, in scratchpad, NOT the harness script):
   ```
   ./Chromium.app/Contents/MacOS/Chromium --headless --disable-gpu --no-sandbox \
     --remote-debugging-port=9333 --user-data-dir=<tmp> about:blank
   ```
   Observed over ~2+ minutes:
   - Process launched and stayed alive (PID present in `ps`), consuming near-zero CPU.
   - **Never bound port 9333** (`curl http://127.0.0.1:9333/json/version` refused every time).
   - **Zero log output** to stdout/stderr the entire time.
   - **No child processes** (`pgrep -P <pid>` empty) — a healthy Chromium launch forks a GPU process and at least one renderer/zygote almost immediately; this one never did.
   - `sample` on the process showed `libRosetta.dylib` loaded (confirms it's running under Rosetta translation as expected) but nothing indicating where it was stuck — the one-second sample landed in Apple system frameworks, not obviously actionable.
   - No entries appeared under `~/Library/Logs/DiagnosticReports/` for it (not a crash — more consistent with a hang/wedge than a crash).

   **This is NOT yet a verdict.** It's exactly as consistent with "this 2018 x86_64 build cannot complete startup under Rosetta on macOS 26.5" as it is with "it just needed more than ~2 minutes on a host that was already under heavy fleet load (~166/16 cores) at the time" — the host-load context makes the hang ambiguous. **Must be re-run on a quiet host before drawing the infeasibility conclusion the ticket asks for.**

## What was NOT done / still open

- `scripts/tv-runtime-check.mjs` — **not written yet**. No code changes exist in this worktree.
- No `npm install` completed in the worktree itself (a separate scratch build of the pre-fix commit was mid-`npm install` when killed — not needed once the CDP launch question is resolved first; feasibility gates everything else).
- Post-fix build/serve: not started.
- Discriminating negative-control run (pre-fix commit must FAIL, post-fix must PASS): not started — blocked on the launch feasibility question above.
- Gate runs (Jest, build): not run in this worktree.
- No commit has been made in the ticket worktree branch until this checkpoint.
- No PR opened.

## Exact next command to run (resume point)

On a quiet host, re-run the launch probe standalone first — cheapest way to answer feasibility before writing the harness:

```bash
mkdir -p /tmp/chromium-probe && cd /tmp/chromium-probe
curl -sS -o chrome-mac.zip "https://commondatastorage.googleapis.com/chromium-browser-snapshots/Mac/561733/chrome-mac.zip"
unzip -q chrome-mac.zip
xattr -cr chrome-mac/Chromium.app
mkdir -p udata
nohup ./chrome-mac/Chromium.app/Contents/MacOS/Chromium --headless --disable-gpu --no-sandbox \
  --remote-debugging-port=9333 --user-data-dir="$PWD/udata" about:blank > launch.log 2>&1 &
# then poll (Monitor tool or a bounded background loop), NOT a blocking sleep, up to ~2-3 min:
#   curl -sS --max-time 2 http://127.0.0.1:9333/json/version
# and check: pgrep -P <pid> for child processes (a healthy launch forks within seconds)
```

If it binds the port this time: proceed to write `scripts/tv-runtime-check.mjs` per the ticket spec (raw CDP over the global `WebSocket`, Node 22 has it — confirmed `node -v` = v26.5.0 in this session, well past 22), point it first at the pre-fix build (must FAIL — unparseable ES2022 syntax, app never boots) then the post-fix build (must PASS), and only then write the real script into the worktree and commit it.

If it does NOT bind the port on a quiet host either: that is the honest "infeasible on this machine" answer the ticket explicitly permits — write it up plainly with this evidence, and propose the fallback (Linux container with an old Chromium, e.g. `docker run` an x86_64 Debian image — no Rosetta translation layer to fight — or a pinned-Chromium ladder starting at whichever revision (856583 ≈ Chrome 87, 911515 ≈ Chrome 94) DOES launch cleanly on this Mac, clearly labeled as **not** proving the Chrome 68 floor).

## Scratch state left on disk (not committed, not in this worktree)

- `/private/tmp/claude-501/.../scratchpad/chromium-test/` — downloaded+unzipped Chromium 68 build, quarantine-cleared. Reusable as-is; safe to delete and re-fetch if the sandbox scratch dir gets reaped.
- `/private/tmp/claude-501/.../scratchpad/boraoke-prefix/` — a **detached-HEAD git worktree** of the boraoke repo at commit `58b44f8` (the pre-PR-76 state), registered against the real `.git`. `npm install` was killed mid-run there. This worktree is OUTSIDE `.worktrees/` and outside house convention (D-033 says worktrees live at `<repo>/.worktrees/<slug>`) — it was created as a throwaway probe target, not ticket work product. **It should be removed** (`git -C /Users/paulosalvatore/Documents/GitHub/boraoke worktree remove --force /private/tmp/.../scratchpad/boraoke-prefix`) once a resuming agent confirms nothing in it is needed — or just re-created fresh at commit `58b44f8` when the negative-control build step is actually run.

## Processes killed / ports freed at stop time

- Killed the scratch Chromium process (PID 87248 at time of kill) and any matching `chrome-mac/Chromium.app` process.
- Killed the scratch `npm install` in the detached pre-fix worktree.
- Verified via `ps`/`lsof`: no heavy process left running, port 9333 (probe) and 3099 (reserved-but-unused for this ticket) both free.
