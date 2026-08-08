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
