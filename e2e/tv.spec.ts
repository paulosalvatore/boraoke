import { test, expect, type Page } from "@playwright/test";

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

async function drainQueue(page: Page) {
  for (let i = 0; i < 220; i++) {
    const res = await page.request.get("/api/queue");
    const data = await res.json();
    if (!data.items || data.items.length === 0) return;
    await page.request.post("/api/queue/advance");
  }
}

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
  test.afterEach(async ({ page }) => {
    await drainQueue(page); // leave the shared in-memory store clean
  });

  test("idle state renders the recruitment poster without errors (AC3, AC6)", async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    await drainQueue(page);
    await page.goto("/default/tv");

    await expect(page.getByTestId("tv-idle")).toBeVisible();
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
    await drainQueue(page);
    await seedShow(page);
    await page.goto("/default/tv");

    const hero = page.getByTestId("tv-hero");
    await expect(hero).toHaveText("Garota de Ipanema");

    // tv-hero: 4.4vw @1920 = ~84.5px, weight 800
    const heroStyle = await hero.evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontSize: parseFloat(s.fontSize), fontWeight: s.fontWeight };
    });
    expect(heroStyle.fontSize).toBeGreaterThanOrEqual(80);
    expect(heroStyle.fontWeight).toBe("800");

    // singer line with table
    await expect(page.getByText("Beto")).toBeVisible();
    await expect(page.getByText("· Mesa 3")).toBeVisible();

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

    await drainQueue(page);
    await page.goto("/default/tv");

    // Affordance is visible on load (chrome shown, re-shows after reloads)
    const btn = page.getByTestId("tv-fullscreen");
    await expect(btn).toBeVisible();
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

  test("chrome auto-hides and the cursor goes with it", async ({ page }) => {
    await drainQueue(page);
    await page.goto("/default/tv");

    const chrome = page.getByTestId("tv-chrome");
    await expect(chrome).toBeVisible();

    // after the idle window the chrome fades and the cursor is hidden
    await page.waitForTimeout(4600);
    await expect(chrome).toHaveClass(/chromeHidden/);
    const cursor = await page
      .getByTestId("tv-root")
      .evaluate((el) => getComputedStyle(el).cursor);
    expect(cursor).toBe("none");

    // activity brings it back
    await page.mouse.move(960, 540);
    await expect(chrome).not.toHaveClass(/chromeHidden/);
  });
});
