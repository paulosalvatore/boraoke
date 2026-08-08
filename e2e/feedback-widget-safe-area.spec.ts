import { test, expect, type Page } from "@playwright/test";
import { drainQueue, warmModerationRoutes } from "./helpers";

/**
 * E2E (TICKET-71): the floating "Enviar feedback" pill must never cover
 * interactive queue content, at any scroll position, on any page that mounts
 * it, including on a home-indicator (safe-area-inset) phone.
 *
 * These assertions are on REAL GEOMETRY — bounding-box comparisons between the
 * pill and a queue row's title/badge — not on a CSS class name. A live
 * regression here was the pill sitting directly on top of a queue row's song
 * title and "CANTAR" badge (see the ticket's evidence screenshots); a
 * class-name assertion would not have caught it.
 *
 * HISTORY THIS SPEC ENCODES (why the coverage below looks the way it does):
 * an earlier version of the fix kept the mobile pill `position: fixed` and
 * added a live JS "collision avoidance" nudge that measured the pill against
 * on-screen rows and lifted it clear of whichever one it currently
 * overlapped. That passed a 5-row smoke test (checking only the LAST visible
 * row, and only at scroll fraction 0.0 and 1.0) and even passed an opus
 * review — but an independent verifier swept a 25-song queue across scroll
 * fractions 0.0–1.0 and found it net-negative: from roughly frac 0.2 to 0.9
 * the required lift saturated a sane cap and the pill still overlapped 1–2
 * rows, with the SAME overlap count whether the JS nudge was on or off. It
 * never removed an overlap at mid-scroll — it only relocated the same
 * overlap from the bottom-right corner into the screen's vertical center,
 * where it kept moving as the guest scrolled. The gap that let that ship was
 * exactly this file only ever seeding 5 rows and only ever checking the two
 * scroll extremes. The fix that replaced the nudge (see FeedbackWidget.tsx
 * and its CSS module) drops `position: fixed` on mobile entirely — the pill
 * renders in normal document flow there, so it cannot spatially coincide
 * with a queue row at ANY scroll position, by construction, regardless of
 * queue length. The "25-row sweep across mid-scroll fractions" test below is
 * the one that would have caught the original defect, and is the one a
 * regression here would have to pass.
 */

const MOBILE_VIEWPORT = { width: 390, height: 844 };

function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Assert the pill's bounding box does not intersect ANY of the given rows'
 * title/badge, right now (no polling — the mobile pill is a plain in-flow
 * element with no animation/measurement lag to wait out; if it's wrong, it's
 * wrong immediately).
 */
async function expectRowsClearOfPill(page: Page, rows: ReturnType<Page["getByTestId"]>[]) {
  const fab = page.getByRole("button", { name: /enviar feedback/i });
  const pillBox = await fab.boundingBox();
  // The fab is only ever intersecting-relevant while it's actually
  // rendered on screen; if it isn't currently visible at all (scrolled well
  // past it, or well before it), there's nothing to check.
  if (!pillBox) return;

  for (let i = 0; i < rows.length; i++) {
    const titleBox = await rows[i].getByTestId("queue-row-title").boundingBox();
    const badgeBox = await rows[i].getByTestId("queue-row-badge").boundingBox();
    if (!titleBox || !badgeBox) continue; // row not currently rendered on screen either
    expect(rectsIntersect(pillBox, titleBox), `row ${i} title overlaps the pill`).toBe(false);
    expect(rectsIntersect(pillBox, badgeBox), `row ${i} badge overlaps the pill`).toBe(false);
  }
}

async function seedQueue(page: Page, roomId: string, count: number, prefix = "Musica de teste") {
  for (let i = 0; i < count; i++) {
    await page.request.post("/api/queue", {
      data: {
        room: roomId,
        videoId: "dQw4w9WgXcQ",
        title: `${prefix} ${i + 1}`,
        nickname: `Patrono${i + 1}`,
        patronUuid: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        mode: "sing",
      },
    });
  }
}

/** Warm every route the flow touches so a first-compile mid-test never resets
 * the in-memory store singleton and wipes seeded state (documented caveat,
 * mirrored from moderation.spec.ts / host-controls.spec.ts). */
async function warmUp(page: Page) {
  await page.request.get("/api/queue?room=default");
  await warmModerationRoutes(page.request);
  await page.request.post("/api/rooms", { data: { name: "warmup-71" } });
  await page.request.post("/api/host/login", { data: { token: "cantai-dev-host" } });
  await page.request.get("/api/host/session?room=default");
  await page.goto("/default");
  await page.goto("/default/admin");
  await page.goto("/new");
}

test.describe("feedback pill never covers queue content (TICKET-71)", () => {
  test.beforeEach(async ({ page }) => {
    await warmUp(page);
    await drainQueue(page.request).catch(() => {});
  });

  test("25-row queue: no overlap swept across scroll fractions 0.0 / 0.2 / 0.5 / 0.8 / 1.0", async ({
    page,
  }) => {
    // This is the decisive test: it reproduces exactly the sweep an
    // independent verifier used to refute the earlier fixed-pill + JS-nudge
    // approach (see the file-level doc comment). A 5-row queue is too short
    // to ever put a row at mid-scroll fractions in the first place — 25
    // rows comfortably overflows a 844px viewport many times over.
    //
    // Uses its OWN room rather than "default": the per-room advance
    // rate-limit (12/60s, the deliberate anti-grief singer-skip throttle —
    // see lib/advance-rate-limit.ts) means `drainQueue` cannot fully clear
    // 25 seeded entries from "default" before the next test's beforeEach
    // runs, leaking rows into later tests. A dedicated, never-drained room
    // sidesteps that entirely — nothing else in this file touches it.
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/new");
    await page.getByLabel("Nome do bar").fill("Bar TICKET-71 Sweep");
    await page.getByRole("button", { name: /^criar sala$/i }).click();
    await page.getByTestId("join-url").waitFor();
    const joinUrl = (await page.getByTestId("join-url").textContent())!.trim();
    const roomId = joinUrl.split("/").pop()!;
    await seedQueue(page, roomId, 25);

    await page.goto(`/${roomId}`);
    await page.getByLabel("Seu apelido").fill("Verificador25");
    await page.getByRole("button", { name: /entrar na fila/i }).click();
    await page.getByRole("heading", { name: /adicionar música/i }).waitFor();

    const rows = page.getByTestId("queue-row");
    await expect(rows).toHaveCount(25, { timeout: 8000 });
    const allRows = await rows.all();

    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    const viewportHeight = MOBILE_VIEWPORT.height;
    const maxScroll = Math.max(0, scrollHeight - viewportHeight);

    for (const frac of [0, 0.2, 0.5, 0.8, 1]) {
      await page.evaluate((y) => window.scrollTo(0, y), Math.round(maxScroll * frac));
      await page.waitForTimeout(50);
      await expectRowsClearOfPill(page, allRows);
    }
  });

  test("populated queue (short, 5 rows): pill does not cover the queue, unscrolled AND scrolled to bottom", async ({
    page,
  }) => {
    // Smaller companion smoke test — kept for fast, cheap coverage of the
    // ticket's own original evidence scenario (a short queue on first
    // paint), now trivially satisfied since the mobile pill is no longer
    // fixed. The 25-row sweep above is what actually proves the fix.
    await page.setViewportSize(MOBILE_VIEWPORT);
    await seedQueue(page, "default", 5);

    await page.goto("/default");
    await page.getByLabel("Seu apelido").fill("Verificador");
    await page.getByRole("button", { name: /entrar na fila/i }).click();
    await page.getByRole("heading", { name: /adicionar música/i }).waitFor();

    const rows = page.getByTestId("queue-row");
    await expect(rows).toHaveCount(5, { timeout: 6000 });
    const allRows = await rows.all();

    await expectRowsClearOfPill(page, allRows);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(100);
    await expectRowsClearOfPill(page, allRows);
  });

  test("pending-approval state: pill does not cover the queue below it, unscrolled AND scrolled to bottom", async ({
    page,
    context,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);

    await page.goto("/new");
    await page.getByLabel("Nome do bar").fill("Bar TICKET-71");
    await page.getByRole("button", { name: /^criar sala$/i }).click();
    await page.getByTestId("join-url").waitFor();
    const joinUrl = (await page.getByTestId("join-url").textContent())!.trim();
    const roomId = joinUrl.split("/").pop()!;
    const hostCode = (await page.getByTestId("host-code").textContent())!.trim();

    // Seed a handful of rows into the LIVE queue first, while moderation is
    // still off — these represent the pre-existing approved queue, same as
    // the evidence shot. (Seeding after enabling moderation would route these
    // straight to pending too — moderation gates every submission, not just
    // the UI path.)
    await seedQueue(page, roomId, 5, "Fila");

    await page.goto(`/${roomId}/admin`);
    await page.getByLabel("Código do host").fill(hostCode);
    await page.getByRole("button", { name: /entrar/i }).click();
    await page.getByTestId("moderation-card").waitFor();
    const toggle = page.getByTestId("moderation-toggle");
    if (!(await toggle.isChecked())) {
      await page.getByTestId("moderation-track").click();
    }
    await expect(toggle).toBeChecked();

    const patron = await context.newPage();
    await patron.setViewportSize(MOBILE_VIEWPORT);
    await patron.goto(`/${roomId}`);
    await patron.getByLabel("Seu apelido").fill("Pendente");
    await patron.getByRole("button", { name: /entrar na fila/i }).click();
    await patron.getByRole("heading", { name: /adicionar música/i }).waitFor();
    await patron.getByLabel(/Buscar música/i).fill("https://youtu.be/dQw4w9WgXcQ");
    await expect(patron.getByText(/Selecionada: dQw4w9WgXcQ/)).toBeVisible({ timeout: 3000 });
    await patron.getByPlaceholder(/^ex\.: Evidências$/).fill("Minha musica pendente");
    await patron.getByRole("button", { name: /adicionar à fila/i }).click();
    await expect(patron.getByTestId("patron-pending-waiting")).toBeVisible({ timeout: 6000 });

    const rows = patron.getByTestId("queue-row");
    await expect(rows).toHaveCount(5, { timeout: 6000 });
    const allRows = await rows.all();

    await expectRowsClearOfPill(patron, allRows);

    await patron.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await patron.waitForTimeout(100);
    await expectRowsClearOfPill(patron, allRows);

    await patron.close();
  });

  test("home-indicator safe-area inset: mobile spacer grows by the inset amount", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);

    // Emulate an iPhone-style home-indicator inset via CDP — the same signal
    // env(safe-area-inset-bottom) reads on a real notched device.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { bottom: 34, bottomMax: 34 },
    });

    await seedQueue(page, "default", 5);
    await page.goto("/default");
    await page.getByLabel("Seu apelido").fill("Verificador2");
    await page.getByRole("button", { name: /entrar na fila/i }).click();
    await page.getByRole("heading", { name: /adicionar música/i }).waitFor();
    const rows = page.getByTestId("queue-row");
    await expect(rows).toHaveCount(5, { timeout: 6000 });

    // The mobile spacer is safe-area-only now (no pill-footprint reservation
    // needed — the mobile pill isn't fixed any more) — proves
    // env(safe-area-inset-bottom) is actually wired into the CSS, not just
    // present as dead text in the stylesheet.
    const spacerHeight = await page.evaluate(() => {
      const spacer = document.querySelector('[data-testid="feedback-pill-spacer"]');
      return spacer ? spacer.getBoundingClientRect().height : 0;
    });
    expect(spacerHeight).toBeGreaterThanOrEqual(34 - 1);
    expect(spacerHeight).toBeLessThan(60); // not the old ~114px pill-footprint reservation

    // The gap must land BELOW the pill (clearing the home-indicator), not
    // above it — a real defect the App Tester/Reviewer gate caught: an
    // earlier commit rendered the spacer div BEFORE the fab in the DOM, so
    // the safe-area gap appeared above the pill instead, achieving nothing
    // for its stated purpose. Assert the actual relative position, not just
    // the spacer's own height.
    const fab = page.getByRole("button", { name: /enviar feedback/i });
    const fabBox = await fab.boundingBox();
    const spacerBox = await page.locator('[data-testid="feedback-pill-spacer"]').boundingBox();
    expect(fabBox).not.toBeNull();
    expect(spacerBox).not.toBeNull();
    expect(spacerBox!.y).toBeGreaterThanOrEqual(fabBox!.y + fabBox!.height - 1);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(100);
    const allRows = await rows.all();
    await expectRowsClearOfPill(page, allRows);
  });

  /**
   * TICKET-72 coverage. The in-flow pill above fixed the overlap but left the
   * only mobile entry point at the true END of the page (~2400px down a busy
   * room). The fix adds a SECOND in-flow entry point, portalled into the
   * page's own <header>, so feedback is reachable at first paint.
   *
   * These tests assert both halves of that claim, because either alone is
   * satisfiable by a bad implementation:
   *   (a) the header trigger is ON SCREEN with NO scrolling (discoverability),
   *   (b) it is `position: static` and never overlaps a queue row at ANY
   *       scroll position (the TICKET-71 guarantee is not traded back).
   * A `position: fixed` version of this affordance would pass (a) and fail
   * (b); the pre-TICKET-72 code passes (b) and fails (a).
   */
  test("TICKET-72 — header trigger is visible without scrolling AND never overlaps a 25-row queue", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/new");
    await page.getByLabel("Nome do bar").fill("Bar TICKET-72 Header");
    await page.getByRole("button", { name: /^criar sala$/i }).click();
    await page.getByTestId("join-url").waitFor();
    const joinUrl = (await page.getByTestId("join-url").textContent())!.trim();
    const roomId = joinUrl.split("/").pop()!;
    await seedQueue(page, roomId, 25);

    await page.goto(`/${roomId}`);
    await page.getByLabel("Seu apelido").fill("Verificador72");
    await page.getByRole("button", { name: /entrar na fila/i }).click();
    await page.getByRole("heading", { name: /adicionar música/i }).waitFor();

    const rows = page.getByTestId("queue-row");
    await expect(rows).toHaveCount(25, { timeout: 8000 });
    const allRows = await rows.all();

    // (a) DISCOVERABILITY — at scroll 0, with a queue long enough that the
    // in-flow pill is thousands of px away, the header trigger is already
    // inside the viewport and tappable.
    await page.evaluate(() => window.scrollTo(0, 0));
    const trigger = page.getByTestId("feedback-header-trigger");
    await expect(trigger).toBeVisible();
    const triggerBox = (await trigger.boundingBox())!;
    expect(triggerBox).not.toBeNull();
    expect(triggerBox.y).toBeGreaterThanOrEqual(0);
    expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(MOBILE_VIEWPORT.height);
    // It really is a meaningful tap target (>= 40px, comfortably above the
    // 24px WCAG 2.2 minimum) and not a 0px "technically present" element.
    expect(triggerBox.width).toBeGreaterThanOrEqual(40);
    expect(triggerBox.height).toBeGreaterThanOrEqual(40);
    // ...and the pill it supplements is genuinely far away, so this test is
    // not passing because the page happens to be short.
    const pillY = (await page.getByRole("button", { name: /enviar feedback/i }).boundingBox())?.y;
    if (pillY !== undefined) expect(pillY).toBeGreaterThan(MOBILE_VIEWPORT.height);

    // (b) STRUCTURE — in normal flow, exactly like the pill. Asserted at the
    // CSS level, not merely inferred from an absence of overlaps.
    const position = await trigger.evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe("static");

    // (b) GEOMETRY — the same sweep the pill is held to, applied to the new
    // affordance. This is the assertion that a fixed re-implementation fails.
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    const maxScroll = Math.max(0, scrollHeight - MOBILE_VIEWPORT.height);
    for (const frac of [0, 0.2, 0.5, 0.8, 1]) {
      await page.evaluate((y) => window.scrollTo(0, y), Math.round(maxScroll * frac));
      await page.waitForTimeout(50);
      const box = await trigger.boundingBox();
      if (!box) continue; // scrolled past the header — nothing to intersect
      for (let i = 0; i < allRows.length; i++) {
        const titleBox = await allRows[i].getByTestId("queue-row-title").boundingBox();
        const badgeBox = await allRows[i].getByTestId("queue-row-badge").boundingBox();
        if (!titleBox || !badgeBox) continue;
        expect(rectsIntersect(box, titleBox), `row ${i} title overlaps the header trigger`).toBe(
          false,
        );
        expect(rectsIntersect(box, badgeBox), `row ${i} badge overlaps the header trigger`).toBe(
          false,
        );
      }
    }

    // And it actually opens the sheet — a decorative button would be worse
    // than no button.
    await page.evaluate(() => window.scrollTo(0, 0));
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("TICKET-72 — landing page: header trigger is on screen at 390px and 320px without scrolling", async ({
    page,
  }) => {
    // The landing page mounts the same widget and had the same problem: the
    // in-flow pill sits below the footer. It is also the page this ticket
    // could NOT solve with a fixed pill — a probe measured 12 (178x48 pill),
    // 8 (48px circle) and 7 (40px circle) intersections with interactive
    // landing content across 21 scroll positions at 390px.
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      const trigger = page.getByTestId("feedback-header-trigger");
      await expect(trigger).toBeVisible();
      const box = (await trigger.boundingBox())!;
      expect(box.y, `w=${width}: trigger above the fold`).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, `w=${width}: trigger above the fold`).toBeLessThanOrEqual(844);
      // Fully inside the viewport horizontally — no 320px overflow.
      expect(box.x, `w=${width}: trigger not clipped left`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `w=${width}: trigger not clipped right`).toBeLessThanOrEqual(width);
      expect(await trigger.evaluate((el) => getComputedStyle(el).position)).toBe("static");
    }
  });

  test("TICKET-72 — desktop keeps only the fixed pill: no header trigger is rendered", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // The landing page always renders a <header>, so the portal target
    // genuinely exists here — this asserts the CSS hides the trigger, not
    // that the element happens to be absent.
    await page.goto("/");
    const trigger = page.getByTestId("feedback-header-trigger");
    await expect(trigger).toHaveCount(1);
    await expect(trigger).toBeHidden();
    expect(await trigger.evaluate((el) => getComputedStyle(el).display)).toBe("none");
    // The desktop pill is still there and still fixed.
    const fab = page.getByRole("button", { name: /enviar feedback/i });
    expect(await fab.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  });

  test("desktop: no dead space is introduced at the bottom of the page, pill stays fixed", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedQueue(page, "default", 3);
    await page.goto("/default");
    await page.getByLabel("Seu apelido").fill("Desktop");
    await page.getByRole("button", { name: /entrar na fila/i }).click();
    await page.getByRole("heading", { name: /adicionar música/i }).waitFor();
    await expect(page.getByTestId("queue-row")).toHaveCount(3, { timeout: 6000 });

    const spacerHeight = await page.evaluate(() => {
      const spacer = document.querySelector('[data-testid="feedback-pill-spacer"]');
      return spacer ? spacer.getBoundingClientRect().height : 0;
    });
    expect(spacerHeight).toBe(0);

    // Desktop never had the bug and is unaffected by this ticket: the pill
    // stays position: fixed there.
    const fab = page.getByRole("button", { name: /enviar feedback/i });
    const position = await fab.evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe("fixed");
  });
});
