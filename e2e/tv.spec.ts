import { test, expect, type Locator, type Page } from "@playwright/test";
import { advanceOnce, drainQueue, warmTvRoutes } from "./helpers";

/**
 * E2E: /tv venue screen (TICKET-18) — 10-foot layout, idle poster,
 * fullscreen affordance, powered-by footer.
 *
 * Playback itself is NOT tested (YT IFrame, headless CI) — same posture as
 * submit-song.spec.ts. Fullscreen is stubbed via init script: headless
 * chromium fullscreen is flaky, and we assert OUR contract (the affordance
 * calls the API with a user gesture, then hides) rather than the browser's.
 */

test.use({ viewport: { width: 1920, height: 1080 } });

const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16)
  );


async function seed(page: Page, entry: Record<string, string>) {
  const res = await page.request.post("/api/queue", { data: entry });
  expect(res.ok()).toBe(true);
}

async function seedShow(page: Page) {
  await seed(page, { videoId: "dQw4w9WgXcQ", title: "Garota de Ipanema", nickname: "Beto", patronUuid: uuid(), table: "3", mode: "sing" });
  await seed(page, { videoId: "dQw4w9WgXcQ", title: "Como Nossos Pais", nickname: "Carla", patronUuid: uuid(), table: "5", mode: "sing" });
  await seed(page, { videoId: "dQw4w9WgXcQ", title: "Baile de Favela", nickname: "DJ Formiga", patronUuid: uuid(), mode: "listen-dance" });
  await seed(page, { videoId: "dQw4w9WgXcQ", title: "Evidências", nickname: "Marina", patronUuid: uuid(), table: "7", mode: "sing" });
}

test.describe("/tv", () => {
  test.beforeEach(async ({ page }) => {
    // TICKET-65: warm-compile /default/tv + the queue routes it polls BEFORE
    // any seeding — see warmTvRoutes' doc comment for the confirmed mechanism
    // (a route's first compile resets the in-memory store singleton).
    await warmTvRoutes(page.request);
  });

  test.afterEach(async ({ page }) => {
    await drainQueue(page.request); // leave the shared in-memory store clean
  });

  test("idle state renders the recruitment poster without errors (AC3, AC6)", async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    await drainQueue(page.request);
    await page.goto("/default/tv");

    await expect(page.getByTestId("tv-idle")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Escaneia e canta! 🎤")).toBeVisible();
    // no dead video panel in idle
    await expect(page.locator("#yt-player")).toHaveCount(0);
    // powered-by footer default ON (AC5)
    await expect(page.getByTestId("tv-powered-by")).toBeVisible();
    // wake lock / fullscreen wiring never throws (AC6)
    await page.waitForTimeout(1000);
    expect(pageErrors).toEqual([]);
  });

  test("playing state: hero scale, max-3 rail, nothing under 28px (AC1)", async ({ page }) => {
    await drainQueue(page.request);
    await seedShow(page);
    await page.goto("/default/tv");

    const hero = page.getByTestId("tv-hero");
    // Bounded-longer wait (not a masked timeout): right after goto, this is the
    // FIRST assertion that depends on the seeded queue surviving the page's
    // render — give slow CI runners headroom over Playwright's 5s default.
    await expect(hero).toHaveText("Garota de Ipanema", { timeout: 10_000 });

    // tv-hero: 4.4vw @1920 = ~84.5px, weight 800
    const heroStyle = await hero.evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontSize: parseFloat(s.fontSize), fontWeight: s.fontWeight };
    });
    expect(heroStyle.fontSize).toBeGreaterThanOrEqual(80);
    expect(heroStyle.fontWeight).toBe("800");

    // singer line with table (scope to the singer element — the TICKET-10 30s
    // "get to the mic" call also renders the nickname, so a bare getByText is
    // ambiguous)
    await expect(page.getByTestId("tv-singer")).toContainText("Beto");
    await expect(page.getByTestId("tv-singer")).toContainText("· Mesa 3");

    // up-next rail: exactly 3 cards even with a deeper queue
    await expect(page.getByText("A SEGUIR")).toBeVisible();
    await expect(page.getByText("Carla")).toBeVisible();
    await expect(page.getByText("DJ Formiga 🎶")).toBeVisible();
    await expect(page.getByText("Marina")).toBeVisible();

    // powered-by/join footer present by default (AC5)
    await expect(page.getByTestId("tv-powered-by")).toBeVisible();
    await expect(page.getByText("powered by")).toBeVisible();

    // AC1 sweep: no rendered text on /tv under 28px @1080p (excludes the
    // cross-origin YT iframe internals, which we don't control)
    const minFont = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="tv-root"]');
      if (!root) return 0;
      let min = Infinity;
      const walk = (el: Element) => {
        for (const node of Array.from(el.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
            const size = parseFloat(getComputedStyle(el).fontSize);
            if (size < min) min = size;
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            walk(node as Element);
          }
        }
      };
      walk(root);
      return min;
    });
    expect(minFont).toBeGreaterThanOrEqual(28);
  });

  // Shared TICKET-70 seeding helpers — a long, realistic multi-word room slug
  // (the default room used by every other test in this file has a short slug
  // and never reproduces the bug: `.join`'s width scales with the slug, and a
  // short slug never grows it enough to starve the rail).
  const upnextRoom = (suffix: string) => `tv-upnext-e2e-check-${suffix}`;
  const uid = () =>
    "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
      Math.floor(Math.random() * 16).toString(16)
    );
  const seedRoom = async (page: Page, room: string, entry: Record<string, string>) => {
    const res = await page.request.post("/api/queue", {
      data: { ...entry, patronUuid: uid(), room },
    });
    expect(res.ok()).toBe(true);
  };
  /**
   * A short nickname's rendered box must be wide enough to show ALL of its
   * text with zero CSS-ellipsis clipping. `scrollWidth <= clientWidth` is the
   * right test (it's exactly what "not clipped" means for a `nowrap` +
   * `overflow: hidden` box) — a `getByText(name, { exact: true })` assertion
   * alone is NOT sufficient, because `text-overflow: ellipsis` is purely
   * visual and never changes `textContent`, so it would match identically
   * whether the box shows "Bruno" or "B…". That gap was caught in review on
   * the first version of this test and is why this helper exists at all.
   */
  const assertNameNotClipped = async (page: Page, name: string) => {
    const who = page.locator('[class*="who"]', { hasText: name }).first();
    await expect(who).toBeVisible({ timeout: 10_000 });
    const { scrollWidth, clientWidth, text } = await who.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      text: el.textContent,
    }));
    expect(text).toBe(name);
    // Tolerance, not a bare +1px rounding fudge (TICKET-70 re-review, opus
    // Finding 3): the rail budget was widened specifically so this has real
    // margin at 1920×1080 (canvas `measureText` against `.who`'s own computed
    // font: "Bruno" 107px glyphs in a 231px box = 124px/54% headroom,
    // "Fernanda" 168px in 229px = 61px/27%) — but at the narrower 1440×900
    // width an 11-char name like "Rodriguinho" measured only ~5% headroom
    // (164px glyphs in a 173px box). `tv.module.css`'s font stack leads with
    // `-apple-system`/`BlinkMacSystemFont`, which falls through to a wider
    // default sans on a Linux CI runner — a 5% margin could flake there on a
    // name near the box's real limit, even though the product itself is
    // correct on the venue's actual macOS/iOS-family font stack. A 12%
    // relative tolerance absorbs realistic cross-platform font-substitution
    // width variance while staying nowhere near what the ORIGINAL bug did —
    // it collapsed the box by >90% (a 231px box down to ~5-24px), so a
    // regression of that shape still fails hard.
    expect(scrollWidth).toBeLessThanOrEqual(Math.ceil(clientWidth * 1.12) + 1);
  };

  test("up-next: realistic Brazilian nicknames render in full on a long room slug (TICKET-70)", async ({ page }) => {
    // TICKET-70 root cause: `.join` (the QR "powered by" card) was
    // `flex: none` with NO width cap, sized purely by its content —
    // including the room's join URL, which grows with the room slug. A
    // realistic multi-word venue slug pushed `.join` wide enough to crowd
    // the up-next `.nextCard`s (`flex: 1 1 0%`) down to a sliver, so
    // `text-overflow: ellipsis` on `.who` fired almost immediately ("Br…"
    // instead of "Bruno") even though most of the screen sat empty.
    //
    // TICKET-70 follow-up (TL + Reviewer review pass): the `.join` cap alone
    // only moved the truncation threshold from ~2 characters to ~6 — common
    // Brazilian first names (Estêvão, Fernanda, Gabriel) still clipped,
    // because the `.mesa` table badge sat beside the FULL `.info` column as a
    // permanent cost. The rail card was reflowed so `.mesa` shares a row with
    // the (already secondary) song title instead of the name's own line —
    // this test seeds exactly the names the follow-up named to pin that fix.
    const room = upnextRoom("brnames");
    await drainQueue(page.request, room);
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Garota de Ipanema", nickname: "Ana", table: "1", mode: "sing" });
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Como Nossos Pais", nickname: "Bruno", table: "2", mode: "sing" });
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Evidências", nickname: "Estêvão", table: "12", mode: "sing" });
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Baile", nickname: "Fernanda", table: "5", mode: "sing" });

    await page.goto(`/${room}/tv`);

    await expect(page.getByText("Bruno", { exact: true })).toBeVisible({ timeout: 10_000 });
    await assertNameNotClipped(page, "Bruno");
    await assertNameNotClipped(page, "Estêvão");
    // "Fernanda" is the longest of the set (8 chars) — the tightest margin,
    // so it's the name that would fail first if the rail budget regressed.
    await assertNameNotClipped(page, "Fernanda");

    // Table badges still render (moved rows, not removed) — same assertion
    // style as the file's other tests (`toContainText`), scoped per card so
    // a stray "Mesa 5" elsewhere on the page can't false-match.
    await expect(page.locator('[class*="nextCard"]', { hasText: "Estêvão" })).toContainText("Mesa 12");
    await expect(page.locator('[class*="nextCard"]', { hasText: "Fernanda" })).toContainText("Mesa 5");

    await drainQueue(page.request, room);
  });

  test("up-next: an 11-char Brazilian nickname still fits at the narrower 1440x900 width (TICKET-70)", async ({ page }) => {
    // Pins the follow-up's explicit target — "common Brazilian first names up
    // to ~12 characters render in full at both 1920x1080 and 1440x900" — at
    // the narrower of the two evidence widths, where the rail has the least
    // room to work with. "Rodriguinho" (11 chars) is a real, ordinary
    // nickname, not a constructed edge case.
    await page.setViewportSize({ width: 1440, height: 900 });
    const room = upnextRoom("narrow11char");
    await drainQueue(page.request, room);
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Garota de Ipanema", nickname: "Ana", table: "1", mode: "sing" });
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Como Nossos Pais", nickname: "Leonardo", table: "12", mode: "sing" });
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Evidências", nickname: "Rodriguinho", table: "7", mode: "sing" });
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Baile", nickname: "Mariana", table: "5", mode: "sing" });

    await page.goto(`/${room}/tv`);

    await expect(page.getByText("Rodriguinho", { exact: true })).toBeVisible({ timeout: 10_000 });
    await assertNameNotClipped(page, "Leonardo");
    await assertNameNotClipped(page, "Rodriguinho");
    await assertNameNotClipped(page, "Mariana");

    await drainQueue(page.request, room);
  });

  test("up-next: a pathologically long nickname degrades gracefully without breaking the layout (TICKET-70)", async ({ page }) => {
    // The rail budget was widened for realistic names above, but free-text
    // nicknames are still user input — a genuinely long one (near the
    // server's 30-char cap) must still clip via ellipsis rather than blow out
    // the card or run the layout off-screen. Seeded alongside two normal
    // names so this exercises the SAME 3-slot rail the fix above does, not an
    // artificially uncontested single-card layout.
    const room = upnextRoom("pathological");
    await drainQueue(page.request, room);
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Garota de Ipanema", nickname: "Ana", table: "1", mode: "sing" });
    // 27 chars — pathologically long but under the 30-char nickname cap.
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Como Nossos Pais", nickname: "ZeMuitoLongoDoBairroInteiro", table: "2", mode: "sing" });
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Evidências", nickname: "Carla", table: "7", mode: "sing" });
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Baile", nickname: "Diego", table: "5", mode: "sing" });

    await page.goto(`/${room}/tv`);

    await expect(page.getByText("Carla", { exact: true })).toBeVisible({ timeout: 10_000 });
    // The short names sharing the rail with the pathological one must still
    // render in full — proves the long name doesn't steal space from its
    // siblings (each `.nextCard` is independently sized, not competing for a
    // shared pool the way `.join` used to compete with all three).
    await assertNameNotClipped(page, "Carla");
    await assertNameNotClipped(page, "Diego");

    // The pathological name MUST clip (there isn't room, and that's fine —
    // ellipsis is correct here): assert the box IS narrower than its content,
    // proving this is graceful degradation, not a broken/vacuous test.
    const longWho = page.locator('[class*="who"]', { hasText: "ZeMuitoLongoDoBairroInteiro" }).first();
    await expect(longWho).toBeVisible();
    const longMetrics = await longWho.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(longMetrics.scrollWidth).toBeGreaterThan(longMetrics.clientWidth);

    // ...but its CARD must stay fully inside the viewport — clipping the TEXT
    // is fine, overflowing the LAYOUT is not (the whole point of "degrades
    // gracefully"). This is a real regression risk independent of the
    // ellipsis check above: a flex item can still blow out its container.
    const longNameCard = page
      .locator('[class*="nextCard"]')
      .filter({ hasText: /Mesa 2/ });
    await expect(longNameCard).toBeVisible();
    const box = await longNameCard.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    if (box && viewport) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    }

    // The join/QR card itself must also stay on-screen — it used to run its
    // URL text off the right edge together with the rail truncation.
    const joinCard = page.getByTestId("tv-powered-by");
    const joinBox = await joinCard.boundingBox();
    if (joinBox && viewport) {
      expect(joinBox.x + joinBox.width).toBeLessThanOrEqual(viewport.width + 1);
    }

    await drainQueue(page.request, room);
  });

  test("fullscreen affordance enters fullscreen and hides after (AC2)", async ({ page }) => {
    // Stub the Fullscreen API: record the call and simulate the state change.
    await page.addInitScript(() => {
      const w = window as unknown as { __fsCalls: number };
      w.__fsCalls = 0;
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () =>
          (window as unknown as { __fs?: boolean }).__fs
            ? document.documentElement
            : null,
      });
      // document.documentElement does not exist yet at init-script time —
      // stub the prototype so the app's call lands on the stub.
      Element.prototype.requestFullscreen = function () {
        (window as unknown as { __fsCalls: number }).__fsCalls += 1;
        (window as unknown as { __fs?: boolean }).__fs = true;
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      };
    });

    await drainQueue(page.request);
    await page.goto("/default/tv");

    // Affordance is visible on load (chrome shown, re-shows after reloads)
    const btn = page.getByTestId("tv-fullscreen");
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await expect(btn).toHaveText(/Tela cheia/);

    await btn.click();
    expect(await page.evaluate(() => (window as unknown as { __fsCalls: number }).__fsCalls)).toBe(1);

    // After entering fullscreen the affordance hides; exit hint appears
    await expect(btn).toHaveCount(0);
    await expect(page.getByText("Esc para sair")).toBeVisible();

    // `F` key does not re-request while already fullscreen
    await page.keyboard.press("f");
    expect(await page.evaluate(() => (window as unknown as { __fsCalls: number }).__fsCalls)).toBe(1);

    // Simulate native Esc exit → affordance returns
    await page.evaluate(() => {
      (window as unknown as { __fs?: boolean }).__fs = false;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    await expect(page.getByTestId("tv-fullscreen")).toBeVisible();

    // `F` key re-enters
    await page.keyboard.press("f");
    expect(await page.evaluate(() => (window as unknown as { __fsCalls: number }).__fsCalls)).toBe(2);
  });

  /**
   * TICKET-82 — the player must OUTLIVE every queue change.
   *
   * Reported from a live venue: "I was on fullscreen for the YT player, when I
   * added a new song and the page updated, the embed got black screened. I had
   * to refresh the page." Root cause: `new YT.Player(el)` does not render into
   * `el` — the IFrame API REPLACES `el` with its own `<iframe>`. The player host
   * used to live inside the `nowPlaying ? ... : idle` branch, so an empty queue
   * unmounted that subtree and took the iframe with it while `playerRef` kept
   * holding the (now nodeless) player object. Adding a song re-mounted an empty
   * host and the effect took its "player already exists" branch, calling
   * `loadVideoById` on that corpse — a permanently dead black embed.
   *
   * These tests therefore assert NODE IDENTITY, not just "an iframe exists":
   * a fresh-but-empty host would satisfy a presence check while being exactly
   * the broken state. The stub below is deliberately FAITHFUL about the one
   * behaviour that causes the bug (element replacement) — the tv-watchdog stub
   * renders nothing and so cannot catch this class at all.
   */
  const YT_MARK = "data-yt-instance";

  /** Stub the YT IFrame API, faithfully REPLACING the target node (as YT does). */
  async function stubYouTubeReplacingNode(page: Page) {
    await page.addInitScript(() => {
      type Handler = (e: { data: number; target?: unknown }) => void;
      const w = window as unknown as {
        __ytCreated: number;
        __ytLoaded: string[];
        __ytDestroyed: number;
        __ytClock: number;
        // TICKET-89 additions — audio state + the playerVars actually used.
        __ytPlaying: boolean;
        __ytStopped: number;
        __ytVars: Record<string, number | string>;
        YT: unknown;
      };
      w.__ytCreated = 0;
      w.__ytLoaded = [];
      w.__ytDestroyed = 0;
      w.__ytClock = 0;
      w.__ytPlaying = false;
      w.__ytStopped = 0;
      w.__ytVars = {};
      class FakePlayer {
        events: { onReady?: Handler; onStateChange?: Handler; onError?: Handler };
        node: HTMLIFrameElement;
        constructor(
          el: HTMLElement,
          opts: {
            videoId?: string;
            playerVars?: Record<string, number | string>;
            events?: FakePlayer["events"];
          }
        ) {
          this.events = opts.events ?? {};
          w.__ytCreated += 1;
          // The real API swaps the passed element for an <iframe> it owns.
          const iframe = document.createElement("iframe");
          iframe.id = el.id;
          iframe.className = el.className;
          iframe.src = "about:blank";
          iframe.setAttribute("data-yt-instance", String(w.__ytCreated));
          el.parentNode!.replaceChild(iframe, el);
          this.node = iframe;
          // TICKET-89: record the playerVars the component asked for, so a test
          // can assert the embed is built without YouTube's own fullscreen
          // control (`fs: 0`) rather than trusting the source.
          w.__ytVars = { ...(opts.playerVars ?? {}) };
          setTimeout(() => this.events.onReady?.({ data: -1, target: this }), 0);
        }
        loadVideoById(id: string) {
          // A player whose iframe has left the document can never show video —
          // record the load as dead so a test can tell "loaded" from "played".
          w.__ytLoaded.push(this.node.isConnected ? id : `ORPHANED:${id}`);
          w.__ytPlaying = true; // a load autoplays — sound is ON from here
        }
        stopVideo() {
          // TICKET-89: the ONLY thing that actually silences the parked player.
          // Hiding an element does NOT pause media inside it (proved in real
          // Chromium — work/evidence/TICKET-89/fullscreen-probe-*.json, probe
          // G), so an idle screen is silent purely because this is called.
          w.__ytStopped += 1;
          w.__ytPlaying = false;
        }
        destroy() {
          w.__ytDestroyed += 1;
          w.__ytPlaying = false;
          this.node.remove();
        }
        playVideo() {
          w.__ytPlaying = true;
        }
        seekTo() {}
        getPlayerState() {
          return 1; // PLAYING — keep the stall ladder quiet
        }
        getCurrentTime() {
          w.__ytClock += 5;
          return w.__ytClock;
        }
      }
      w.YT = {
        Player: FakePlayer,
        PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
      };
    });
  }

  /** Snapshot of everything the regression cares about. */
  const playerSnapshot = (page: Page) =>
    page.evaluate((mark) => {
      const w = window as unknown as {
        __ytCreated: number;
        __ytLoaded: string[];
        __ytDestroyed: number;
        __tracked?: Element | null;
      };
      const node = document.querySelector(`iframe[${mark}]`);
      return {
        present: Boolean(node),
        instance: node?.getAttribute(mark) ?? null,
        sameNode: node !== null && node === w.__tracked,
        created: w.__ytCreated,
        destroyed: w.__ytDestroyed,
        loaded: [...w.__ytLoaded],
        isFullscreenElement: document.fullscreenElement === node,
        rail: document.querySelectorAll('[class*="nextCard"]').length,
      };
    }, YT_MARK);

  const trackPlayerNode = (page: Page) =>
    page.evaluate((mark) => {
      (window as unknown as { __tracked?: Element | null }).__tracked =
        document.querySelector(`iframe[${mark}]`);
    }, YT_MARK);

  test("player survives a queue update while fullscreen — no remount, no black screen (TICKET-82)", async ({ page }) => {
    await stubYouTubeReplacingNode(page);
    // Simulate the venue's fullscreen: the YT player's own fullscreen button
    // makes the IFRAME the fullscreen element, which is exactly the state the
    // reported bug destroyed. Stubbed (headless fullscreen is flaky) with the
    // same posture as the AC2 test above.
    await page.addInitScript(() => {
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => document.querySelector("iframe[data-yt-instance]"),
      });
    });

    const room = upnextRoom("t82-fullscreen");
    await drainQueue(page.request, room);
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Song A", nickname: "Ana", table: "1", mode: "sing" });
    await page.goto(`/${room}/tv`);

    await expect(page.locator(`iframe[${YT_MARK}]`)).toHaveCount(1, { timeout: 15_000 });
    await trackPlayerNode(page);
    const before = await playerSnapshot(page);
    expect(before).toMatchObject({ present: true, created: 1, destroyed: 0, isFullscreenElement: true, rail: 0 });

    // The reported action: a patron adds a song mid-playback.
    await seedRoom(page, room, { videoId: "oHg5SJYRHA0", title: "Song B", nickname: "Bruno", table: "2", mode: "sing" });

    // The rail must still update promptly (the queue change is legitimate).
    await expect(page.locator('[class*="nextCard"]')).toHaveCount(1, { timeout: 15_000 });
    await page.waitForTimeout(1000);

    const after = await playerSnapshot(page);
    // Same DOM node, same player instance, still the fullscreen element, and
    // NO video reload (the head of the queue did not change).
    expect(after.sameNode).toBe(true);
    expect(after.instance).toBe(before.instance);
    expect(after.created).toBe(1);
    expect(after.destroyed).toBe(0);
    expect(after.loaded).toEqual([]);
    expect(after.isFullscreenElement).toBe(true);

    await drainQueue(page.request, room);
  });

  test("player survives the queue emptying and refilling — the reported black screen (TICKET-82)", async ({ page }) => {
    // THE reproduction. Pre-fix this test fails at `sameNode` / `loaded`: the
    // idle transition unmounted the iframe, and the refill logged
    // "ORPHANED:<id>" — a load into a player with no node on the page, which is
    // precisely the dead embed the Tech Lead had to refresh away.
    await stubYouTubeReplacingNode(page);

    const room = upnextRoom("t82-idle-refill");
    await drainQueue(page.request, room);
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Song A", nickname: "Ana", table: "1", mode: "sing" });
    await page.goto(`/${room}/tv`);

    await expect(page.locator(`iframe[${YT_MARK}]`)).toHaveCount(1, { timeout: 15_000 });
    await trackPlayerNode(page);
    const before = await playerSnapshot(page);
    expect(before.created).toBe(1);

    // The show runs dry — last song ends, the TV falls back to the idle poster.
    await drainQueue(page.request, room);
    await expect(page.getByTestId("tv-idle")).toBeVisible({ timeout: 15_000 });
    const idle = await playerSnapshot(page);
    // The player is PARKED (hidden), never torn out of the document. Soft so
    // the run continues to the refill assertions below — the two failure modes
    // (node torn out at idle; load into an orphan on refill) are separate
    // symptoms of the same defect and both are worth reporting in one run.
    expect.soft(idle.sameNode).toBe(true);
    expect.soft(idle.destroyed).toBe(0);
    await expect.soft(page.locator(`iframe[${YT_MARK}]`)).toBeHidden();

    // A patron adds a song — the exact moment the TV used to black-screen.
    await seedRoom(page, room, { videoId: "oHg5SJYRHA0", title: "Song B", nickname: "Bruno", table: "2", mode: "sing" });
    await expect(page.getByTestId("tv-hero")).toHaveText("Song B", { timeout: 15_000 });
    await page.waitForTimeout(1000);

    const after = await playerSnapshot(page);
    expect(after.sameNode).toBe(true);
    expect(after.instance).toBe(before.instance);
    expect(after.created).toBe(1);
    // The new video was loaded into a LIVE player — never an orphaned one.
    expect(after.loaded).toEqual(["oHg5SJYRHA0"]);
    await expect(page.locator(`iframe[${YT_MARK}]`)).toBeVisible();

    await drainQueue(page.request, room);
  });

  test("a real track change loads the new video in the SAME player (TICKET-82)", async ({ page }) => {
    // The other half of the contract: queue churn must not touch the player,
    // but a genuine track change must still reach it. Note the player node is
    // deliberately preserved here too — `loadVideoById` on the live instance is
    // what swaps the video, and recreating the iframe would reintroduce exactly
    // the flicker/fullscreen-loss this ticket removes.
    await stubYouTubeReplacingNode(page);

    const room = upnextRoom("t82-trackchange");
    await drainQueue(page.request, room);
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Song A", nickname: "Ana", table: "1", mode: "sing" });
    await seedRoom(page, room, { videoId: "oHg5SJYRHA0", title: "Song B", nickname: "Bruno", table: "2", mode: "sing" });
    await page.goto(`/${room}/tv`);

    await expect(page.getByTestId("tv-hero")).toHaveText("Song A", { timeout: 15_000 });
    await expect(page.locator(`iframe[${YT_MARK}]`)).toHaveCount(1);
    await trackPlayerNode(page);
    expect((await playerSnapshot(page)).loaded).toEqual([]);

    // Advance (host skip / song ended) — a REAL track change.
    expect((await advanceOnce(page.request, room)).ok()).toBe(true);
    await expect(page.getByTestId("tv-hero")).toHaveText("Song B", { timeout: 15_000 });
    await page.waitForTimeout(1000);

    const after = await playerSnapshot(page);
    expect(after.sameNode).toBe(true);
    expect(after.created).toBe(1);
    expect(after.loaded).toEqual(["oHg5SJYRHA0"]);

    await drainQueue(page.request, room);
  });

  /**
   * ---- TICKET-89: fullscreen across the idle gap -------------------------
   *
   * TICKET-82 parks the player with `display: none` on `.main` while the queue
   * is empty, and its review recorded (N4) that this would make a fullscreen
   * player "drop out of fullscreen". Real Chromium — headless AND headed — says
   * otherwise, and the truth is worse than the assumption:
   *
   *   `display: none` on the fullscreen element, or on ANY ANCESTOR of it,
   *   does NOT exit fullscreen. The element simply collapses to a 0x0 box.
   *
   * So a venue that used YouTube's own fullscreen button (which makes the
   * IFRAME the fullscreen element, and the iframe lives inside `.main`) does
   * not fall back to the windowed idle poster when the show runs dry — it sits
   * in fullscreen rendering NOTHING: a black screen for the whole gap between
   * singers, with the recruitment QR unreachable behind it. That is a kiosk
   * defect, not a cosmetic annoyance.
   *
   * Evidence: work/evidence/TICKET-89/fullscreen-probe-{chromium,headed}.json,
   * probes A (element itself) and B (ancestor) — `exited: false`, box 0x0.
   *
   * The fix has two parts, neither of which requests fullscreen programmatically
   * (the harness grants `requestFullscreen()` on a never-clicked page — see
   * activation-probe-headed.json H0 — so a gesture-dependent fix could not be
   * validated here, and would fail silently on a real kiosk):
   *
   *   1. `fs: 0` — the embed is built WITHOUT YouTube's own fullscreen control,
   *      so the iframe cannot become the fullscreen element through the UI.
   *      The app's own affordance fullscreens `document.documentElement`, which
   *      probe D proves is completely immune to a descendant being hidden.
   *   2. A defensive exit: if the fullscreen element is nevertheless inside the
   *      player host when the queue empties, leave fullscreen deliberately.
   *      `exitFullscreen()` needs no user gesture, so this always works, and it
   *      turns the black-limbo state into a visible idle poster.
   */
  const fullscreenSnapshot = (page: Page) =>
    page.evaluate(() => {
      const fs = document.fullscreenElement;
      const rect = fs?.getBoundingClientRect();
      const w = window as unknown as { __ytPlaying: boolean; __ytStopped: number; __ytVars: Record<string, unknown> };
      return {
        // "HTML" = documentElement (the app's own affordance), "IFRAME" = the
        // YouTube embed itself (YouTube's own control), null = not fullscreen.
        kind: fs === null ? null : fs === document.documentElement ? "HTML" : fs.tagName,
        // A fullscreen element with a 0x0 box is the black-screen state.
        box: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
        playing: w.__ytPlaying,
        stopped: w.__ytStopped,
        vars: w.__ytVars,
      };
    });

  test("the venue's fullscreen survives the queue emptying and refilling (TICKET-89)", async ({ page }) => {
    // THE acceptance criterion, on the affordance the app actually ships: the
    // bar hits "Tela cheia" (or F), which fullscreens documentElement.
    await stubYouTubeReplacingNode(page);

    const room = upnextRoom("t89-survives");
    await drainQueue(page.request, room);
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Song A", nickname: "Ana", table: "1", mode: "sing" });
    await page.goto(`/${room}/tv`);

    await expect(page.locator(`iframe[${YT_MARK}]`)).toHaveCount(1, { timeout: 15_000 });
    await trackPlayerNode(page);

    // Enter fullscreen exactly the way the chrome button does.
    await page.evaluate(() => document.documentElement.requestFullscreen());
    await expect
      .poll(async () => (await fullscreenSnapshot(page)).kind, { timeout: 10_000 })
      .toBe("HTML");

    // The show runs dry.
    await drainQueue(page.request, room);
    await expect(page.getByTestId("tv-idle")).toBeVisible({ timeout: 15_000 });

    const idle = await fullscreenSnapshot(page);
    // Still fullscreen — the whole point of this ticket.
    expect(idle.kind).toBe("HTML");
    // And genuinely PAINTING, not a collapsed 0x0 black screen.
    expect(idle.box!.w).toBeGreaterThan(0);
    expect(idle.box!.h).toBeGreaterThan(0);
    // The recruitment poster is visible IN fullscreen, which is what idle is for.
    await expect(page.getByTestId("tv-idle")).toBeVisible();

    // A patron adds a song — fullscreen must carry straight through.
    await seedRoom(page, room, { videoId: "oHg5SJYRHA0", title: "Song B", nickname: "Bruno", table: "2", mode: "sing" });
    await expect(page.getByTestId("tv-hero")).toHaveText("Song B", { timeout: 15_000 });

    const after = await fullscreenSnapshot(page);
    expect(after.kind).toBe("HTML");
    // Same player throughout (the TICKET-82 contract, re-asserted here).
    expect((await playerSnapshot(page)).sameNode).toBe(true);
    await expect(page.locator(`iframe[${YT_MARK}]`)).toBeVisible();

    await drainQueue(page.request, room);
  });

  test("an idle screen is SILENT — the player is stopped, not merely hidden (TICKET-89)", async ({ page }) => {
    // Hiding an element does not pause media inside it (probe G, real Chromium:
    // `HIDING DOES NOT STOP AUDIO`). A parked-but-present player would keep the
    // venue's speakers going over an empty room, which is far worse than losing
    // fullscreen — so the explicit `stopVideo()` is asserted, not assumed.
    await stubYouTubeReplacingNode(page);

    const room = upnextRoom("t89-silence");
    await drainQueue(page.request, room);
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Song A", nickname: "Ana", table: "1", mode: "sing" });
    await page.goto(`/${room}/tv`);

    await expect(page.locator(`iframe[${YT_MARK}]`)).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(async () => (await fullscreenSnapshot(page)).playing, { timeout: 10_000 }).toBe(true);

    // Fullscreen it first — the parked-while-fullscreen case is the one where a
    // "keep it visible so fullscreen survives" fix would leak sound.
    await page.evaluate(() => document.documentElement.requestFullscreen());

    await drainQueue(page.request, room);
    await expect(page.getByTestId("tv-idle")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1000);

    const idle = await fullscreenSnapshot(page);
    expect(idle.playing).toBe(false); // NO audio while idle
    expect(idle.stopped).toBeGreaterThanOrEqual(1); // and it was silenced explicitly
    // Still the same live player — silenced, not destroyed (TICKET-82).
    expect((await playerSnapshot(page)).destroyed).toBe(0);

    await drainQueue(page.request, room);
  });

  test("a YouTube-fullscreened player never leaves a black 0x0 fullscreen while idle (TICKET-89)", async ({ page }) => {
    // The negative-controlled test. Revert the fix and this FAILS with
    // `kind: "IFRAME", box: {w:0,h:0}` — the black screen described above.
    await stubYouTubeReplacingNode(page);

    const room = upnextRoom("t89-blackfs");
    await drainQueue(page.request, room);
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Song A", nickname: "Ana", table: "1", mode: "sing" });
    await page.goto(`/${room}/tv`);

    const frame = page.locator(`iframe[${YT_MARK}]`);
    await expect(frame).toHaveCount(1, { timeout: 15_000 });
    await trackPlayerNode(page);

    // Part 1 of the fix, asserted directly: the embed is built without
    // YouTube's own fullscreen control, so this state is unreachable via the UI.
    // SOFT deliberately — a hard assert here would abort the test before the
    // behavioural check below, and the behavioural check is the one that
    // encodes the actual defect. Both are symptoms of the same missing fix and
    // both should be reported in a single run (same posture as TICKET-82's
    // empty-then-refill test).
    expect.soft((await fullscreenSnapshot(page)).vars).toMatchObject({ fs: 0 });

    // Part 2, asserted behaviourally: force the bad state anyway (a stale
    // embed, a double-click, a browser that ignores `fs`) and require the
    // component to leave it rather than sit in a black fullscreen.
    await frame.evaluate((el) => el.requestFullscreen());
    await expect
      .poll(async () => (await fullscreenSnapshot(page)).kind, { timeout: 10_000 })
      .toBe("IFRAME");

    // The show runs dry — the exact moment `.mainHidden` lands on the ancestor.
    await drainQueue(page.request, room);
    await expect(page.getByTestId("tv-idle")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1000);

    const idle = await fullscreenSnapshot(page);
    // The forbidden state: still fullscreen on an element that paints nothing.
    const blackFullscreen =
      idle.kind !== null && idle.box !== null && idle.box.w === 0 && idle.box.h === 0;
    expect(blackFullscreen).toBe(false);
    // The idle poster is on screen and has real size — the venue sees the QR.
    const posterBox = await page.getByTestId("tv-idle").boundingBox();
    expect(posterBox!.width).toBeGreaterThan(0);
    expect(posterBox!.height).toBeGreaterThan(0);
    // Silent throughout (the same trap as the test above).
    expect(idle.playing).toBe(false);
    // And TICKET-82 is intact: the player was parked, never destroyed.
    expect((await playerSnapshot(page)).destroyed).toBe(0);

    // Refill still works — no black screen on the way back either.
    await seedRoom(page, room, { videoId: "oHg5SJYRHA0", title: "Song B", nickname: "Bruno", table: "2", mode: "sing" });
    await expect(page.getByTestId("tv-hero")).toHaveText("Song B", { timeout: 15_000 });
    const after = await playerSnapshot(page);
    expect(after.sameNode).toBe(true);
    expect(after.loaded).toEqual(["oHg5SJYRHA0"]);

    await drainQueue(page.request, room);
  });

  test("chrome auto-hides and the cursor goes with it", async ({ page }) => {
    await drainQueue(page.request);
    await page.goto("/default/tv");

    const chrome = page.getByTestId("tv-chrome");
    await expect(chrome).toBeVisible({ timeout: 10_000 });

    // After the idle window (~4s, CHROME_HIDE_MS) the chrome fades and the
    // cursor is hidden. Deterministic wait: poll the class via Playwright's
    // web-first `toHaveClass` (bounded to 8s) instead of a fixed
    // `waitForTimeout` immediately followed by a one-shot assert — the fixed
    // sleep raced the component's own timer on slow CI runners and was one of
    // the two flaky assertions TICKET-65 diagnosed.
    await expect(chrome).toHaveClass(/chromeHidden/, { timeout: 8000 });
    const cursor = await page
      .getByTestId("tv-root")
      .evaluate((el) => getComputedStyle(el).cursor);
    expect(cursor).toBe("none");

    // activity brings it back
    await page.mouse.move(960, 540);
    await expect(chrome).not.toHaveClass(/chromeHidden/);
  });

  /**
   * ---- TICKET-103: the app-owned focus state ------------------------------
   *
   * The Tech Lead liked a state where "the screen goes black with only the video
   * playing", and reported the join QR disappearing in it. Step 0
   * (work/reports/testing/TICKET-103-test-report.md) measured what that state
   * actually was: YouTube's OWN fullscreen, reached by a keyboard shortcut that
   * `fs: 0` does not suppress. The IFRAME becomes the fullscreen element, so the
   * video fills the viewport and NOTHING of ours composites — which is both why
   * he liked it and exactly why the QR vanished. A DOM overlay on a fullscreen
   * cross-origin iframe is impossible, so the QR cannot be rescued in that state.
   *
   * These tests cover the replacement: an app-owned focus state in our own DOM
   * (big video, QR always painted, queue on a timer), plus the redirect that
   * makes the accidental iframe-fullscreen unreachable-for-long.
   */

  /**
   * Effective PAINTED opacity — the element's own times every ancestor's, and 0
   * for anything hidden outright.
   *
   * `toBeVisible()` is not the right instrument for this ticket: Playwright calls
   * an `opacity: 0` element visible (it has a box), and "does the venue see it"
   * is precisely the question. Step 0's measurements were made this way too, so
   * these assertions are directly comparable to the numbers in that report.
   */
  const paintedOpacity = (locator: Locator) =>
    locator.evaluate((el) => {
      let effective = 1;
      let node: Element | null = el;
      while (node) {
        const s = getComputedStyle(node);
        if (s.visibility === "hidden" || s.display === "none") return 0;
        effective *= Number(s.opacity);
        node = node.parentElement;
      }
      return effective;
    });

  const videoLocator = (page: Page) => page.locator('[class*="video"]').first();

  const videoArea = async (page: Page) => {
    const box = await videoLocator(page).boundingBox();
    return box ? box.width * box.height : 0;
  };

  /**
   * Read `.video`'s area once it has stopped moving.
   *
   * The focus state animates `max-width`/`max-height` over ~0.4s, so a single
   * measurement taken the instant the class lands catches a mid-transition
   * number. Polling until two consecutive readings agree is the web-first way to
   * wait for that (the alternative — `waitForTimeout(500)` then one assert — is
   * the exact pattern TICKET-65 removed from this file).
   */
  const settledVideoArea = async (page: Page, opts: { keepAwake: boolean }) => {
    let last = -1;
    await expect
      .poll(
        async () => {
          if (opts.keepAwake) {
            // Baseline measurement only: keep poking the chrome so the 4s idle
            // timer never flips us into the focus state mid-measurement.
            //
            // A KEY press, not a mouse move. The first version moved the mouse to
            // the middle of the screen, which is INSIDE the player iframe — a
            // pointer event there goes to the cross-origin iframe and never
            // reaches the app, so the poke did nothing and the baseline was
            // silently measured in the focus state instead. It passed when run
            // alone and failed in the full suite, purely on machine speed. An
            // arrow key reaches the window listener regardless of geometry.
            await page.keyboard.press("ArrowDown");
          }
          const area = await videoArea(page);
          const stable = area > 0 && area === last;
          last = area;
          return stable;
        },
        { timeout: 15_000 }
      )
      .toBe(true);
    return last;
  };

  test("focus state: the video grows, the meta panel collapses, and the QR stays painted ON the video (TICKET-103 items 1-3)", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // Stub the player, like every other long test in this file. Not cosmetic:
    // the real embed's `onError` auto-skip fires on these video ids within ~10s
    // (Step 0's friction note recorded the same thing), which drains the queue
    // out from under a test that has to sit idle for the 4s chrome-hide window.
    // A drained queue leaves the focus state — so an unstubbed version of this
    // test measures the wrong layout and fails for a reason unrelated to it.
    await stubYouTubeReplacingNode(page);
    const room = upnextRoom("t103-focus");
    await drainQueue(page.request, room);
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Garota de Ipanema", nickname: "Ana", table: "1", mode: "sing" });
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Evidências", nickname: "Bruno", table: "2", mode: "sing" });
    await page.goto(`/${room}/tv`);

    const root = page.getByTestId("tv-root");
    const hero = page.getByTestId("tv-hero");
    await expect(hero).toHaveText("Garota de Ipanema", { timeout: 15_000 });

    // ---- baseline: the NORMAL state, with the chrome kept awake -------------
    await expect(root).not.toHaveClass(/focus/);
    const normalArea = await settledVideoArea(page, { keepAwake: true });
    expect(normalArea).toBeGreaterThan(0);
    // The baseline is only a baseline if the screen was still in the NORMAL state
    // when it was taken — see settledVideoArea for how that went wrong once.
    await expect(root).not.toHaveClass(/focus/);
    // Step 0 measured this as 35.6% of a 1920x1080 viewport. Pin the baseline
    // loosely so this test reports a REAL comparison rather than trusting a
    // number from a prior report.
    expect(normalArea / (1920 * 1080)).toBeLessThan(0.45);

    // ---- idle for the chrome-hide window -> the focus state ----------------
    await expect(root).toHaveClass(/focus/, { timeout: 8000 });
    const focusArea = await settledVideoArea(page, { keepAwake: false });

    // Item 2, "the video should be bigger", as a measurement. Step 0 established
    // that NO state in the pre-change code gave `.video` more room — normal,
    // chrome-hidden and app-fullscreen were pixel-identical — so any ratio above
    // 1 is new behaviour. The bar is set at 2x because the reclaimed space (meta
    // column + top bar + rail + most of the page padding) is most of the screen;
    // a regression that only nudged the video would be a failure, not a partial
    // pass.
    expect(focusArea / normalArea).toBeGreaterThan(2);
    expect(focusArea / (1920 * 1080)).toBeGreaterThan(0.75);

    // The meta panel is genuinely gone from the venue's view (not just moved).
    await expect.poll(() => paintedOpacity(hero), { timeout: 5000 }).toBe(0);

    // ---- item 1: the QR is STILL PAINTED, and is over the video ------------
    const qr = page.getByTestId("qr-img");
    expect(await paintedOpacity(qr)).toBe(1);
    const qrBox = (await qr.boundingBox())!;
    expect(qrBox.width).toBeGreaterThan(0);
    expect(qrBox.height).toBeGreaterThan(0);
    // There is exactly ONE QR node on a playing screen — the focus state
    // repositions the existing join card rather than rendering a second copy, so
    // there is no state where one copy paints and the other does not.
    await expect(page.getByTestId("qr-img")).toHaveCount(1);
    // Item 3: the placement under test is on-video. Assert it really is inside
    // the video's box, so the committed screenshots are showing the overlay this
    // test measured and not some other layout.
    const videoBox = (await videoLocator(page).boundingBox())!;
    expect(qrBox.x).toBeGreaterThanOrEqual(videoBox.x);
    expect(qrBox.y).toBeGreaterThanOrEqual(videoBox.y);
    expect(qrBox.x + qrBox.width).toBeLessThanOrEqual(videoBox.x + videoBox.width + 1);
    expect(qrBox.y + qrBox.height).toBeLessThanOrEqual(videoBox.y + videoBox.height + 1);

    // ---- activity restores the full UI (the TL's own described cycle) ------
    //
    // A KEY press, not a mouse move over the video. In the focus state the player
    // iframe covers ~97% of the screen, and a pointer event over a cross-origin
    // iframe is delivered to that iframe — it never reaches our window listener.
    // Moving the mouse to the centre of the screen here therefore woke nothing,
    // which is how this gap was found; a remote's D-pad is a key event and does
    // reach us. (The first version of this test asserted the mouse path and
    // failed for that reason, not because the focus state was wrong.)
    await page.keyboard.press("ArrowRight");
    await expect(root).not.toHaveClass(/focus/);
    await expect.poll(() => paintedOpacity(hero), { timeout: 5000 }).toBe(1);
    // ...and the QR never stopped being painted across the whole round trip.
    expect(await paintedOpacity(qr)).toBe(1);

    await drainQueue(page.request, room);
  });

  test("focus state: the up-next queue reveals on a timer, hides again, and comes back (TICKET-103 item 4)", async ({
    page,
  }) => {
    // Deliberately long: item 4 is a PERIODIC behaviour, and the only honest
    // proof that the cycle re-arms (rather than firing once) is observing a
    // second reveal a full period later. Raising this test's own budget is the
    // right trade — trimming the product's timings to suit the harness would
    // mean the shipped cadence is not the one under test.
    test.setTimeout(120_000);
    // Mandatory here, not merely prudent: this test idles for over a minute, and
    // the real embed's auto-skip empties the queue in ~10s — which drops the
    // focus state and returns the up-next cards to their normal opacity 1. That
    // is exactly how the first version of this test failed: `not.toHaveClass(peek)`
    // passed because the whole focus state had gone, not because the overlay hid.
    await stubYouTubeReplacingNode(page);
    const room = upnextRoom("t103-peek");
    await drainQueue(page.request, room);
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Garota de Ipanema", nickname: "Ana", table: "1", mode: "sing" });
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Evidências", nickname: "Bruno", table: "2", mode: "sing" });
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Como Nossos Pais", nickname: "Carla", table: "3", mode: "sing" });
    await page.goto(`/${room}/tv`);

    const root = page.getByTestId("tv-root");
    await expect(page.getByTestId("tv-hero")).toHaveText("Garota de Ipanema", { timeout: 15_000 });
    await expect(page.getByTestId("tv-rail")).toBeVisible();
    // 3 seeded entries -> 1 playing + 2 on the rail.
    await expect(page.locator('[class*="nextCard"]')).toHaveCount(2);
    const card = page.locator('[class*="nextCard"]').first();

    await expect(root).toHaveClass(/focus/, { timeout: 8000 });

    // First reveal (after the short lead-in).
    await expect(root).toHaveClass(/peek/, { timeout: 15_000 });
    await expect.poll(() => paintedOpacity(card), { timeout: 5000 }).toBeGreaterThan(0.9);

    // ...then it hides again — item 4 is explicit that it must NOT be permanent.
    await expect(root).not.toHaveClass(/peek/, { timeout: 15_000 });
    // Guard, and a diagnostic for whoever reads the next failure: losing the
    // FOCUS state also removes the peek class and returns the cards to their
    // normal opacity 1, so without this the assertion below could pass-then-fail
    // for a reason that has nothing to do with the peek timer.
    await expect(root).toHaveClass(/focus/);
    await expect.poll(() => paintedOpacity(card), { timeout: 5000 }).toBeLessThan(0.1);

    // ...and it comes BACK, which is what makes it periodic rather than a
    // one-shot reveal that happened to fire once on entering the focus state.
    await expect(root).toHaveClass(/peek/, { timeout: 40_000 });
    await expect.poll(() => paintedOpacity(card), { timeout: 5000 }).toBeGreaterThan(0.9);

    // Throughout every phase of the cycle, the QR stayed painted.
    expect(await paintedOpacity(page.getByTestId("qr-img"))).toBe(1);

    await drainQueue(page.request, room);
  });

  test("YouTube's own fullscreen is caught and redirected out of, so our overlays are never un-paintable (TICKET-103)", async ({
    page,
  }) => {
    await stubYouTubeReplacingNode(page);
    /**
     * Reproduce the Step 0 hazard as OUR contract rather than as YouTube's.
     *
     * Step 0 reached the real thing by clicking inside the live embed and
     * pressing `F`; that needs the real cross-origin player and real keyboard
     * focus, neither of which belongs in a deterministic suite (and the file's
     * existing fullscreen tests are stubbed for the same reason). What we own,
     * and what this asserts, is the response: when the fullscreen element turns
     * out to be inside the player host, we leave it — immediately, on any path
     * that produced it.
     */
    await page.addInitScript(() => {
      const w = window as unknown as { __exitCalls: number; __fsOn: boolean };
      w.__exitCalls = 0;
      w.__fsOn = false;
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => (w.__fsOn ? document.querySelector("iframe[data-yt-instance]") : null),
      });
      document.exitFullscreen = function () {
        w.__exitCalls += 1;
        w.__fsOn = false;
        // The real API fires this on the way out; firing it keeps the app's own
        // listener on the same code path it takes in a browser.
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      };
    });

    const room = upnextRoom("t103-ytfs");
    await drainQueue(page.request, room);
    await seedRoom(page, room, { videoId: "dQw4w9WgXcQ", title: "Garota de Ipanema", nickname: "Ana", table: "1", mode: "sing" });
    await page.goto(`/${room}/tv`);

    const root = page.getByTestId("tv-root");
    await expect(page.locator(`iframe[${YT_MARK}]`)).toHaveCount(1, { timeout: 15_000 });
    await expect(root).toHaveAttribute("data-native-fs-redirects", "0");

    // The hazard: YouTube's keyboard shortcut makes the IFRAME the fullscreen
    // element. `fs: 0` removes the button, not the shortcut.
    await page.evaluate(() => {
      (window as unknown as { __fsOn: boolean }).__fsOn = true;
      document.dispatchEvent(new Event("fullscreenchange"));
    });

    // We notice and pull the screen straight back out of it.
    await expect(root).toHaveAttribute("data-native-fs-redirects", "1", { timeout: 5000 });
    expect(await page.evaluate(() => (window as unknown as { __exitCalls: number }).__exitCalls)).toBe(1);
    expect(await page.evaluate(() => document.fullscreenElement === null)).toBe(true);

    // And it is not a one-shot: a venue that keeps hitting the shortcut keeps
    // getting pulled back, which is the difference between a guard and a fuse.
    await page.evaluate(() => {
      (window as unknown as { __fsOn: boolean }).__fsOn = true;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    await expect(root).toHaveAttribute("data-native-fs-redirects", "2", { timeout: 5000 });
    expect(await page.evaluate(() => document.fullscreenElement === null)).toBe(true);

    // The player itself was never disturbed — a remount would kill playback
    // (TICKET-82), so the redirect must not cost what it is protecting.
    const snap = await playerSnapshot(page);
    expect(snap.created).toBe(1);
    expect(snap.destroyed).toBe(0);
    expect(snap.present).toBe(true);

    // Our own DOM is paintable again, which is the whole point of the redirect:
    // in iframe-fullscreen the QR has a box but is not composited (Step 0).
    expect(await paintedOpacity(page.getByTestId("qr-img"))).toBe(1);

    await drainQueue(page.request, room);
  });
});
