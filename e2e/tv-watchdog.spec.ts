import { test, expect, type Page } from "@playwright/test";
import { drainQueue, warmTvRoutes } from "./helpers";

/**
 * E2E: /tv player watchdog (TICKET-41) — an unplayable video (onError
 * 2/5/100/101/150) must show the pt-BR skip notice and auto-advance with NO
 * human action. The TV must never require a mid-night refresh.
 *
 * Same stub posture as the TICKET-18 fullscreen tests: the real YT IFrame is
 * unusable headless, so we stub `window.YT` via init script (the app's
 * bootstrap sees the API as already loaded) and assert OUR contract — the
 * component's reaction to the error event — not YouTube's behavior.
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

/** Stub the YT IFrame API before any app code runs. */
async function stubYouTube(page: Page) {
  await page.addInitScript(() => {
    type Handler = (e: { data: number; target?: unknown }) => void;
    interface StubGlobals {
      __ytLast?: unknown;
      __ytCreated: number;
      __ytLoaded: string[];
      __ytClock: number;
      YT: unknown;
    }
    const w = window as unknown as StubGlobals;
    w.__ytCreated = 0;
    w.__ytLoaded = [];
    w.__ytClock = 0;
    class FakePlayer {
      events: { onReady?: Handler; onStateChange?: Handler; onError?: Handler };
      constructor(
        _el: unknown,
        opts: { videoId?: string; events?: FakePlayer["events"] }
      ) {
        this.events = opts.events ?? {};
        w.__ytCreated += 1;
        w.__ytLast = this;
        setTimeout(() => this.events.onReady?.({ data: -1, target: this }), 0);
      }
      loadVideoById(id: string) {
        w.__ytLoaded.push(id);
      }
      stopVideo() {}
      destroy() {}
      playVideo() {}
      seekTo() {}
      getPlayerState() {
        return 1; // PLAYING
      }
      getCurrentTime() {
        // Always progressing → the stall ladder stays quiet in these tests
        // (stall behavior is unit-tested in __tests__/tv-watchdog.test.ts).
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

const fireError = (page: Page, code: number) =>
  page.evaluate((c) => {
    const w = window as unknown as {
      __ytLast?: { events: { onError?: (e: { data: number }) => void } };
    };
    w.__ytLast?.events.onError?.({ data: c });
  }, code);

test.describe("/tv watchdog (TICKET-41)", () => {
  test.beforeEach(async ({ page }) => {
    // TICKET-65: warm-compile /default/tv + the queue routes it polls BEFORE
    // any seeding — see helpers.ts warmTvRoutes for the confirmed mechanism.
    await warmTvRoutes(page.request);
  });

  test.afterEach(async ({ page }) => {
    await drainQueue(page.request); // leave the shared in-memory store clean
  });

  test("onError 150 (embedding disabled): pt-BR notice + auto-advance, no human action", async ({ page }) => {
    await stubYouTube(page);
    await drainQueue(page.request);
    await seed(page, { videoId: "dQw4w9WgXcQ", title: "Vídeo Bloqueado", nickname: "Beto", patronUuid: uuid(), mode: "sing" });
    await seed(page, { videoId: "aaaaaaaaaaa", title: "Próxima da Fila", nickname: "Carla", patronUuid: uuid(), mode: "sing" });

    const advanceCalls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/queue/advance") && r.method() === "POST") {
        advanceCalls.push(r.url());
      }
    });

    await page.goto("/default/tv");
    // Bounded-longer wait: first post-goto assertion depending on the seeded
    // queue surviving the page render — headroom over the 5s default for slow
    // CI runners (TICKET-65).
    await expect(page.getByTestId("tv-hero")).toHaveText("Vídeo Bloqueado", { timeout: 10_000 });
    // Player was created by the stubbed API.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __ytCreated: number }).__ytCreated))
      .toBeGreaterThan(0);

    await fireError(page, 150);

    // pt-BR skip notice appears…
    await expect(page.getByTestId("tv-skip-notice")).toBeVisible();
    await expect(page.getByTestId("tv-skip-notice")).toHaveText("Pulando vídeo indisponível…");
    // …the queue auto-advances (server call carried the watchdog reason)…
    await expect.poll(() => advanceCalls.length).toBeGreaterThan(0);
    expect(advanceCalls.some((u) => u.includes("reason=unplayable"))).toBe(true);
    // …and the NEXT song takes the stage with zero human action.
    await expect(page.getByTestId("tv-hero")).toHaveText("Próxima da Fila");
    const loaded = await page.evaluate(
      () => (window as unknown as { __ytLoaded: string[] }).__ytLoaded
    );
    expect(loaded).toContain("aaaaaaaaaaa");
    // Notice is brief — it clears on its own.
    await expect(page.getByTestId("tv-skip-notice")).toHaveCount(0, { timeout: 6000 });
  });

  test("onError 100 (video removed) also skips; non-fatal codes do not", async ({ page }) => {
    await stubYouTube(page);
    await drainQueue(page.request);
    await seed(page, { videoId: "dQw4w9WgXcQ", title: "Sumiu do YouTube", nickname: "Ana", patronUuid: uuid(), mode: "sing" });
    await seed(page, { videoId: "bbbbbbbbbbb", title: "Sobrevivente", nickname: "Duda", patronUuid: uuid(), mode: "sing" });

    await page.goto("/default/tv");
    await expect(page.getByTestId("tv-hero")).toHaveText("Sumiu do YouTube", { timeout: 10_000 });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __ytCreated: number }).__ytCreated))
      .toBeGreaterThan(0);

    // A non-fatal/unknown code is left alone (stall ladder territory).
    await fireError(page, 1);
    await page.waitForTimeout(500);
    await expect(page.getByTestId("tv-hero")).toHaveText("Sumiu do YouTube");
    await expect(page.getByTestId("tv-skip-notice")).toHaveCount(0);

    // A fatal one skips.
    await fireError(page, 100);
    await expect(page.getByTestId("tv-skip-notice")).toBeVisible();
    await expect(page.getByTestId("tv-hero")).toHaveText("Sobrevivente");
  });

  /**
   * TICKET-82 — the `recreate` rung must heal into a player that actually WORKS.
   *
   * This is the gap the opus review flagged (N2), and it is the same defect
   * class as the reported black screen rather than a different one. At base,
   * the ladder's last-resort rung called `destroy()` and then handed the
   * constructor the SAME React-owned div every time — a node the IFrame API had
   * already replaced (and thus detached) on the first creation. So every
   * "self-heal" built the new player into a node that was not in the document:
   * the rung reported success while leaving a permanently black kiosk. Nothing
   * in the suite noticed, because the existing stub above renders nothing and
   * ignores the element it is passed, so "a player was constructed" was the
   * only thing that could be asserted.
   *
   * This test therefore uses a stub that REPLACES the passed element (as the
   * real API does) and asserts the rebuilt player's iframe is genuinely
   * CONNECTED and inside the player host — not merely that a second player
   * object exists.
   */
  test("the stall ladder's recreate rung rebuilds a player that is actually in the document (TICKET-82)", async ({ page }) => {
    // The ladder climbs one rung per 12s no-progress window
    // (STALL_WINDOW_MS), so replay → reload → recreate takes ~36s of frozen
    // playback. Deliberately slow: this rung only ever runs on a wedged venue
    // TV, and the whole point is that it is exercised end-to-end for real.
    test.setTimeout(120_000);

    // Faithful stub: the real API REPLACES the element it is given.
    await page.addInitScript(() => {
      type Handler = (e: { data: number; target?: unknown }) => void;
      const w = window as unknown as {
        __ytCreated: number;
        __ytDestroyed: number;
        __ytLoaded: string[];
        YT: unknown;
      };
      w.__ytCreated = 0;
      w.__ytDestroyed = 0;
      w.__ytLoaded = [];
      class FrozenPlayer {
        events: { onReady?: Handler; onStateChange?: Handler; onError?: Handler };
        node: HTMLIFrameElement;
        constructor(el: HTMLElement, opts: { videoId?: string; events?: FrozenPlayer["events"] }) {
          this.events = opts.events ?? {};
          w.__ytCreated += 1;
          const iframe = document.createElement("iframe");
          iframe.id = el.id;
          iframe.className = el.className;
          iframe.src = "about:blank";
          iframe.setAttribute("data-yt-instance", String(w.__ytCreated));
          el.parentNode!.replaceChild(iframe, el);
          this.node = iframe;
          setTimeout(() => this.events.onReady?.({ data: -1, target: this }), 0);
        }
        getIframe() {
          return this.node;
        }
        loadVideoById(id: string) {
          w.__ytLoaded.push(this.node.isConnected ? id : `ORPHANED:${id}`);
        }
        stopVideo() {}
        destroy() {
          w.__ytDestroyed += 1;
          this.node.remove();
        }
        playVideo() {}
        seekTo() {}
        getPlayerState() {
          return 1; // PLAYING — so a frozen clock reads as a genuine stall
        }
        getCurrentTime() {
          return 7; // FROZEN: never progresses → the ladder climbs
        }
      }
      w.YT = {
        Player: FrozenPlayer,
        PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
      };
    });

    await drainQueue(page.request);
    await seed(page, { videoId: "dQw4w9WgXcQ", title: "Travou na Tela", nickname: "Ana", patronUuid: uuid(), mode: "sing" });

    await page.goto("/default/tv");
    await expect(page.getByTestId("tv-hero")).toHaveText("Travou na Tela", { timeout: 10_000 });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __ytCreated: number }).__ytCreated))
      .toBe(1);

    // Climb: replay (12s) → reload (24s) → recreate (36s). The recreate rung
    // destroys the wedged player and rebuilds, so a SECOND construction is the
    // observable signal that the rung fired.
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __ytCreated: number }).__ytCreated),
        { timeout: 75_000, intervals: [2000] }
      )
      .toBe(2);

    // THE assertion. Pre-fix this is where the rung was silently useless: the
    // rebuilt iframe existed as an object but sat in a detached node, so the
    // venue TV stayed black no matter how many times the watchdog "healed" it.
    const healed = await page.evaluate(() => {
      const node = document.querySelector("iframe[data-yt-instance]");
      const host = document.querySelector('[class*="tv_video"]');
      return {
        present: Boolean(node),
        connected: Boolean(node?.isConnected),
        insideHost: Boolean(node && host && host.contains(node)),
        instance: node?.getAttribute("data-yt-instance") ?? null,
        destroyed: (window as unknown as { __ytDestroyed: number }).__ytDestroyed,
        loaded: [...(window as unknown as { __ytLoaded: string[] }).__ytLoaded],
      };
    });
    expect(healed.present).toBe(true);
    expect(healed.connected).toBe(true);
    expect(healed.insideHost).toBe(true);
    // It is the REBUILT player (instance 2), and the wedged one was destroyed.
    expect(healed.instance).toBe("2");
    expect(healed.destroyed).toBe(1);
    // Nothing was ever loaded into a detached player along the way.
    expect(healed.loaded.filter((id) => id.startsWith("ORPHANED:"))).toEqual([]);

    // The screen still shows the song — the rung healed rather than skipped.
    await expect(page.getByTestId("tv-hero")).toHaveText("Travou na Tela");
  });
});
