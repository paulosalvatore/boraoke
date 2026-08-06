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
});
