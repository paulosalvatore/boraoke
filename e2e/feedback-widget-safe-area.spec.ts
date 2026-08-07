import { test, expect, type Page } from "@playwright/test";
import { drainQueue, warmModerationRoutes } from "./helpers";

/**
 * E2E (TICKET-71): the floating "Enviar feedback" pill must never cover
 * interactive queue content, at any scroll position, on any page that mounts
 * it, including on a home-indicator (safe-area-inset) phone.
 *
 * These assertions are on REAL GEOMETRY — bounding-box comparisons between the
 * fixed pill and a queue row's title/badge — not on a CSS class name. A live
 * regression here was the pill sitting directly on top of a queue row's song
 * title and "CANTAR" badge (see the ticket's evidence screenshots); a
 * class-name assertion would not have caught it.
 *
 * SCROLL-POSITION NOTE: the worst case for this bug is NOT the fully-scrolled-
 * to-bottom rest position — a trailing <footer> after the queue already gives
 * enough clearance there. Reproducing the ticket's own evidence screenshot
 * required the page's DEFAULT, un-scrolled view: on a 390x844 phone the
 * "Adicionar música" form pushes the live queue section far enough down that
 * only the first couple of rows are visible before ever touching the
 * scrollbar, and the fixed pill sits directly over whichever row lands at the
 * bottom of that first viewport. Every test below checks BOTH that natural
 * resting position and the fully-scrolled-to-bottom position, since a real
 * guest passes through both.
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
 * title/badge. Polled (not a single instant read): the fix's collision
 * avoidance recomputes on a requestAnimationFrame + ResizeObserver, which can
 * lag the very first paint by a frame or two — real, but not a false pass,
 * since a genuinely-broken build never converges and the poll times out.
 *
 * Checks EVERY row passed in, not just one: an earlier version of this test
 * checked only the single "last visible row" and missed a real regression —
 * a single-pass collision-avoidance algorithm that lifted the pill clear of
 * the row it started on, but landed it squarely on the row stacked above
 * (found by the App Tester gate on this ticket, reproduced with a 5-row
 * queue at natural page load). Checking the full set of currently-visible
 * rows is what actually catches that class of bug.
 */
async function expectRowsClearOfPill(page: Page, rows: ReturnType<Page["getByTestId"]>[]) {
  const fab = page.getByRole("button", { name: /enviar feedback/i });
  await expect(fab).toBeVisible();

  await expect
    .poll(
      async () => {
        const pillBox = await fab.boundingBox();
        if (!pillBox) return "missing-geometry";
        for (let i = 0; i < rows.length; i++) {
          const titleBox = await rows[i].getByTestId("queue-row-title").boundingBox();
          const badgeBox = await rows[i].getByTestId("queue-row-badge").boundingBox();
          if (!titleBox || !badgeBox) return `missing-geometry-row-${i}`;
          if (rectsIntersect(pillBox, titleBox)) return `title-overlap-row-${i}`;
          if (rectsIntersect(pillBox, badgeBox)) return `badge-overlap-row-${i}`;
        }
        return "clear";
      },
      { timeout: 3000, message: "pill must end up clear of every visible row's title/badge" },
    )
    .toBe("clear");
}

/** Convenience wrapper for the common single-row case. */
async function expectRowClearOfPill(page: Page, row: ReturnType<Page["getByTestId"]>) {
  await expectRowsClearOfPill(page, [row]);
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
  // Compile the host login/session routes BEFORE any real room is created —
  // their first compile mid-test resets the in-memory rooms singleton and
  // wipes a just-created room (the documented memory-driver caveat mirrored
  // from moderation.spec.ts's warmUp).
  await page.request.post("/api/host/login", { data: { token: "cantai-dev-host" } });
  await page.request.get("/api/host/session?room=default");
  await page.goto("/default");
  await page.goto("/default/admin");
  await page.goto("/new");
}

test.describe("feedback pill never covers queue content (TICKET-71)", () => {
  test.beforeEach(async ({ page }) => {
    await warmUp(page);
    // Start from an empty default-room queue so each test owns its own state
    // (drain, not a single advance — a prior test in this file may have
    // seeded several entries).
    await drainQueue(page.request).catch(() => {});
  });

  test("populated queue: pill does not cover the last visible row's title/badge, unscrolled AND scrolled to bottom", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await seedQueue(page, "default", 5);

    await page.goto("/default");
    await page.getByLabel("Seu apelido").fill("Verificador");
    await page.getByRole("button", { name: /entrar na fila/i }).click();
    await page.getByRole("heading", { name: /adicionar música/i }).waitFor();

    const rows = page.getByTestId("queue-row");
    await expect(rows).toHaveCount(5, { timeout: 6000 });

    // 1) The page's default, un-scrolled view — the exact state the ticket's
    // evidence screenshot shows: the search form pushes the queue far enough
    // down that only its first rows fit above the fold, right where the
    // fixed pill sits. Check EVERY row currently on screen, not just the
    // last one — a stacked pair can both be near the pill simultaneously.
    const visibleRows = await findRowsAboveFold(page, rows);
    if (visibleRows.length > 0) await expectRowsClearOfPill(page, visibleRows);

    // 2) Scrolled fully to the bottom (the acceptance criterion's literal
    // wording) — the true last row must also be clear here.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(150);
    const visibleAtBottom = await findRowsAboveFold(page, rows);
    await expectRowsClearOfPill(page, visibleAtBottom.length > 0 ? visibleAtBottom : [rows.last()]);
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

    // 1) Default, un-scrolled view (matches patron-pending-approval-mobile.png).
    // Check every row on screen, not just the last — see expectRowsClearOfPill.
    const visibleRows = await findRowsAboveFold(patron, rows);
    if (visibleRows.length > 0) await expectRowsClearOfPill(patron, visibleRows);

    // 2) Scrolled fully to the bottom.
    await patron.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await patron.waitForTimeout(150);
    const visibleAtBottom = await findRowsAboveFold(patron, rows);
    await expectRowsClearOfPill(patron, visibleAtBottom.length > 0 ? visibleAtBottom : [rows.last()]);

    await patron.close();
  });

  test("home-indicator safe-area inset: reserved space grows so the overlap does not reappear", async ({
    page,
  }) => {
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

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(200);

    // The reserved space itself must have grown by the inset amount — proves
    // env(safe-area-inset-bottom) is actually wired into the calc(), not just
    // present as dead text in the stylesheet.
    const spacerHeight = await page.evaluate(() => {
      const spacer = document.querySelector('[data-testid="feedback-pill-spacer"]');
      return spacer ? spacer.getBoundingClientRect().height : 0;
    });
    expect(spacerHeight).toBeGreaterThanOrEqual(80 + 34 - 1);

    await expectRowClearOfPill(page, rows.last());

    // The pill itself should also float clear of the inset (not flush against
    // the very bottom edge, which is where the home-indicator gesture bar
    // lives on a real device).
    const fab = page.getByRole("button", { name: /enviar feedback/i });
    const pillBox = await fab.boundingBox();
    expect(pillBox).not.toBeNull();
    expect(pillBox!.y + pillBox!.height).toBeLessThanOrEqual(MOBILE_VIEWPORT.height - 34 + 1);
  });

  test("desktop: no dead space is introduced at the bottom of the page", async ({ page }) => {
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
  });
});

/**
 * Find every queue row that is at least partially above the bottom of the
 * current viewport — i.e. everything a guest actually sees without scrolling
 * any further. Returns an empty array if every row is already fully below
 * the fold. Deliberately returns ALL such rows, not just the last one: a
 * stacked pair can both sit near the pill's footprint at once, and checking
 * only the last row missed exactly that case (see {@link expectRowsClearOfPill}).
 */
async function findRowsAboveFold(
  page: Page,
  rows: ReturnType<Page["getByTestId"]>,
): Promise<ReturnType<Page["getByTestId"]>[]> {
  const count = await rows.count();
  const viewportHeight = page.viewportSize()!.height;
  const visible: ReturnType<Page["getByTestId"]>[] = [];
  for (let i = 0; i < count; i++) {
    const box = await rows.nth(i).boundingBox();
    if (box && box.y < viewportHeight) {
      visible.push(rows.nth(i));
    }
  }
  return visible;
}
