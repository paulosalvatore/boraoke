import { test, expect, type Page } from "@playwright/test";
import { drainQueue, warmTvRoutes } from "./helpers";

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

  test("up-next names stay fully readable on a long room slug, and a pathological nickname degrades gracefully (TICKET-70)", async ({ page }) => {
    // TICKET-70: the "A SEGUIR" up-next rail truncated nicknames to ~2
    // characters ("Br…" instead of "Bruno") on the live venue TV. Root cause:
    // `.join` (the QR "powered by" card) was `flex: none` with NO width cap,
    // sized purely by its content — including the room's join URL, which
    // grows with the room slug. A realistic multi-word venue slug pushed
    // `.join` wide enough to crowd the up-next `.nextCard`s (`flex: 1 1 0%`)
    // down to a sliver, so `text-overflow: ellipsis` on `.who` fired almost
    // immediately even though most of the screen sat empty. The default room
    // used by every other test in this file has a short slug ("default") and
    // never reproduced it — this test deliberately uses a long, realistic
    // slug (the shape that broke production) so the regression can't hide
    // behind a short test-only room id again.
    const room = "tv-upnext-longslug-e2e-check";
    const uid = () =>
      "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
        Math.floor(Math.random() * 16).toString(16)
      );
    const seedRoom = async (entry: Record<string, string>) => {
      const res = await page.request.post("/api/queue", {
        data: { ...entry, patronUuid: uid(), room },
      });
      expect(res.ok()).toBe(true);
    };

    await drainQueue(page.request, room);
    await seedRoom({ videoId: "dQw4w9WgXcQ", title: "Garota de Ipanema", nickname: "Ana", table: "1", mode: "sing" });
    await seedRoom({ videoId: "dQw4w9WgXcQ", title: "Como Nossos Pais", nickname: "Bruno", table: "2", mode: "sing" });
    await seedRoom({ videoId: "dQw4w9WgXcQ", title: "Evidências", nickname: "João", table: "7", mode: "sing" });
    // 27 chars — pathologically long but under the 30-char nickname cap; must
    // degrade via ellipsis, not break the layout (AC: no overflow, no crash).
    await seedRoom({ videoId: "dQw4w9WgXcQ", title: "Baile", nickname: "ZeMuitoLongoDoBairroInteiro", table: "5", mode: "sing" });

    await page.goto(`/${room}/tv`);

    // Rendered TEXT is present (a getByText match alone is NOT proof the name
    // isn't clipped: `text-overflow: ellipsis` is purely visual and never
    // changes `textContent`, so `getByText("Bruno", { exact: true })` would
    // match even while the box showing it renders only "Br…" — that gap was
    // caught in review. The real assertion is the scrollWidth/clientWidth
    // check below, which fails exactly when the box is too narrow to show
    // its own text, regardless of what the DOM's textContent says.
    await expect(page.getByText("Bruno", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("João", { exact: true })).toBeVisible();

    // The actual regression check: a short name's own text box must be wide
    // enough to show ALL of its text with no CSS-ellipsis clipping —
    // `scrollWidth` (content's natural width) vs `clientWidth` (the box's
    // rendered width). Before the fix this box collapsed to a few px while
    // `.who`'s textContent still read "Bruno"/"João" in full — a getByText
    // assertion alone can't see that, only this can.
    const assertNameNotClipped = async (name: string) => {
      const who = page.locator('[class*="who"]', { hasText: name }).first();
      await expect(who).toBeVisible();
      const { scrollWidth, clientWidth, text } = await who.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        text: el.textContent,
      }));
      expect(text).toBe(name);
      // +1px tolerance for sub-pixel layout rounding.
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    };
    await assertNameNotClipped("Bruno");
    await assertNameNotClipped("João");

    // The pathological name MUST clip (there isn't room, and that's fine —
    // ellipsis is correct here): assert the box IS narrower than its content
    // the same way, proving this is graceful degradation, not a broken test.
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
      .filter({ hasText: /Mesa 5/ });
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
});
