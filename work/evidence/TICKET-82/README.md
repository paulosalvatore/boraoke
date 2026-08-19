## TICKET-82 evidence — TV player remount black screen

Captured with a standalone Playwright script (chromium, 1920x1080) driving `/[room]/tv` against the running dev server (port 3190, `ADVANCE_AUTH=enforce`), with a faithful `YT.Player` stub injected via `page.addInitScript`. The stub replaces the host `<div>` with an `<iframe>` exactly like the real IFrame API, and paints a bright green "PLAYING" panel for a live player or leaves a black panel for a dead/orphaned one, so the difference is visible in a plain screenshot.

Same scenario run twice, on two states of `components/tv/TvScreen.tsx` + `components/tv/tv.module.css`:

- **fixed-\*** — current working tree (the always-mounted player host fix).
- **broken-\*** — the pre-fix version restored from commit `93fc367` (player host lived inside the `nowPlaying ? ... : idle` branch).

### Scenario steps

1. Seed "Song A", open `/<room>/tv`, wait for the live iframe → `01-playing.png`.
2. Add a page-level "SIMULATED FULLSCREEN ACTIVE" marker (stands in for the venue's real fullscreen), then drain the queue to empty → wait for the idle screen → `02-idle.png`.
3. Seed "Song B" (`oHg5SJYRHA0`) — the reported action — wait for the hero to read "Song B", wait 2s → `03-after-adding-song.png` (the money shot).

### Screenshots

| File | What it shows |
|---|---|
| `fixed-01-playing.png` / `broken-01-playing.png` | Identical starting point: Song A playing, green panel, `data-yt-instance` iframe present. |
| `fixed-02-idle.png` / `broken-02-idle.png` | Identical idle state after the queue drains: recruitment poster, fullscreen marker visible, no now-playing panel. |
| `fixed-03-after-adding-song.png` | **FIXED**: after adding Song B the video panel is still green/PLAYING with `oHg5SJYRHA0` — the same iframe instance survived the idle round-trip and loaded the new video. |
| `broken-03-after-adding-song.png` | **BROKEN**: after adding Song B the sidebar correctly reads "Song B" / "Bob · Mesa 5", but the video panel is solid **black** — no iframe at all. This is the reported venue-TV failure: the UI looks like it's playing but the embed is dead. |

### JSON diagnostics at step 3

**Fixed state** (`fixed-diagnostics.json`):
```json
{
  "created": 1,
  "destroyed": 0,
  "loaded": ["oHg5SJYRHA0"],
  "iframePresent": true,
  "sameNodeAsStep1": true
}
```
One player ever created, never destroyed, `loadVideoById` called cleanly with the new id, iframe present and it's the SAME DOM node captured at step 1 — the always-mounted host kept the player alive across the idle round-trip.

**Broken state** (`broken-diagnostics.json`):
```json
{
  "created": 1,
  "destroyed": 0,
  "loaded": ["ORPHANED:oHg5SJYRHA0"],
  "iframePresent": false,
  "sameNodeAsStep1": false
}
```
The player was created once and never destroyed (nothing ever called `.destroy()`), but React unmounted the `nowPlaying` branch when the queue emptied, tearing the iframe out of the DOM while `playerRef` still pointed at the (now nodeless) player object. `loadVideoById("oHg5SJYRHA0")` fired against that orphaned node (`isConnected === false`) — recorded as `ORPHANED:oHg5SJYRHA0` — so no iframe is present at all after adding the new song. Matches the reported bug exactly: only a manual refresh recovers it.

### Tree restore

The broken-state capture required temporarily reverting `components/tv/TvScreen.tsx` and `components/tv/tv.module.css` to `93fc367`. Both files were restored via `git checkout HEAD -- <files>` immediately after capture; `git status --short` showed a clean tree (only the new evidence files and the now-deleted scratch script remained untracked) before this evidence was committed.
