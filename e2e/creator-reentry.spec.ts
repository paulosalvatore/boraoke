import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * E2E (TICKET-104): a room's CREATOR gets back into admin without typing.
 *
 * The bug this pins down, in its bluntest form: room creation issues NO host
 * session, so before this ticket a creator who clicked "abrir painel" on the
 * very page that had just shown them the host code landed on the LOGIN GATE and
 * had to type it. Past that moment the code is unrecoverable (only its hash is
 * stored), so the gate is a dead end for the one person who owns the room.
 *
 * The proof is the httpOnly `boraoke_identity` cookie matched against the room's
 * `creatorUuid` (POST /api/host/claim). Test 2 is the important one: it strips
 * EVERY cookie and restores only the identity cookie, which is the state a
 * creator is in once the 30-day host session has lapsed or been cleared. Test 3
 * is the negative control — the same URL from a device with no identity cookie
 * must still hit the gate, or the feature would be a room-id-is-admin hole.
 *
 * Runs against `npm run dev` (memory store). Warm-up is mandatory and must
 * include EVERY route the flow touches, /api/host/claim included: a route
 * compiling for the first time AFTER the room is created resets the in-process
 * memory singleton and the room vanishes mid-test.
 */

const IDENTITY_COOKIE = "boraoke_identity";

async function warmUp(page: Page) {
  await page.request.post("/api/rooms", { data: { name: "warmup" } });
  await page.request.post("/api/host/login", { data: { token: "cantai-dev-host" } });
  await page.request.get("/api/host/session?room=default");
  // The route under test — warmed BEFORE any room we care about exists.
  await page.request.post("/api/host/claim?room=default");
  await page.goto("/new");
  await page.goto("/default/admin");
  await page.goto("/");
}

async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto("/new");
  await page.getByLabel("Nome do bar").fill(name);
  await page.getByRole("button", { name: /^criar sala$/i }).click();
  await page.getByTestId("join-url").waitFor();
  const joinUrl = (await page.getByTestId("join-url").textContent())!.trim();
  const id = joinUrl.split("/").pop()!;
  expect(id.length).toBeGreaterThan(0);
  // The host code IS shown here — and we deliberately never read or type it.
  await expect(page.getByTestId("host-code")).toBeVisible();
  return id;
}

/** The dashboard's own card — only rendered when `auth === "authed"`. */
function dashboard(page: Page) {
  return page.getByTestId("moderation-card");
}

/** The login gate's code field — the dead end this ticket removes. */
function gateCodeInput(page: Page) {
  return page.getByLabel("Código do host");
}

/**
 * Drop every cookie, then put back ONLY the identity cookie. This is exactly a
 * creator whose 30-day host session has lapsed or been cleared: the sole
 * credential left on the device is one they cannot read from JS.
 */
async function keepOnlyIdentityCookie(context: BrowserContext) {
  const all = await context.cookies();
  const identity = all.find((c) => c.name === IDENTITY_COOKIE);
  expect(identity, "room creation must have set the identity cookie").toBeTruthy();
  await context.clearCookies();
  await context.addCookies([identity!]);
  const after = await context.cookies();
  expect(after.map((c) => c.name)).toEqual([IDENTITY_COOKIE]);
}

test.describe("creator admin re-entry", () => {
  test("the creator reaches admin straight from creation, typing nothing", async ({ page }) => {
    await warmUp(page);
    const id = await createRoom(page, "Bar Reentrada");

    await page.goto(`/${id}/admin`);

    await expect(dashboard(page)).toBeVisible();
    await expect(gateCodeInput(page)).toHaveCount(0);
  });

  test("re-entry works with ONLY the identity cookie left (host session gone)", async ({
    page,
    context,
  }) => {
    await warmUp(page);
    const id = await createRoom(page, "Bar Cookie Perdido");

    // Reach admin once so a host session definitely exists, then destroy it.
    await page.goto(`/${id}/admin`);
    await expect(dashboard(page)).toBeVisible();
    await keepOnlyIdentityCookie(context);

    await page.goto(`/${id}/admin`);

    await expect(dashboard(page)).toBeVisible();
    await expect(gateCodeInput(page)).toHaveCount(0);
    // And the claim really did re-mint a host session cookie for this room.
    const names = (await context.cookies()).map((c) => c.name);
    expect(names).toContain(`cantai_host_${id}`);
  });

  test("deliberate LOGOUT is not undone by auto-claim", async ({ page }) => {
    // The control this protects: on a shared venue tablet, logout must actually
    // log the host out. The creator's identity cookie lives 2 years, so without
    // the no-claim marker the next admin load would silently claim back in and
    // the next person to pick up the tablet would be host.
    await warmUp(page);
    const id = await createRoom(page, "Bar Tablet Compartilhado");

    await page.goto(`/${id}/admin`);
    await expect(dashboard(page)).toBeVisible();

    await page.getByTestId("admin-logout-button").click();
    await page
      .getByTestId("admin-logout-confirm")
      .getByRole("button", { name: /^confirmar$/i })
      .click();
    await expect(gateCodeInput(page)).toBeVisible();

    // The real test: a fresh page load must NOT auto-claim back in.
    await page.goto(`/${id}/admin`);
    await expect(gateCodeInput(page)).toBeVisible();
    await expect(dashboard(page)).toHaveCount(0);
  });

  test("entering the host code after a logout restores frictionless re-entry", async ({
    page,
  }) => {
    // The marker must not be a one-way door: someone who can present the code has
    // proved possession, so auto-claim comes back for them.
    await warmUp(page);
    await page.goto("/new");
    await page.getByLabel("Nome do bar").fill("Bar Volta Por Cima");
    await page.getByRole("button", { name: /^criar sala$/i }).click();
    await page.getByTestId("join-url").waitFor();
    const id = (await page.getByTestId("join-url").textContent())!.trim().split("/").pop()!;
    const hostCode = (await page.getByTestId("host-code").textContent())!.trim();

    await page.goto(`/${id}/admin`);
    await expect(dashboard(page)).toBeVisible();
    await page.getByTestId("admin-logout-button").click();
    await page
      .getByTestId("admin-logout-confirm")
      .getByRole("button", { name: /^confirmar$/i })
      .click();
    await expect(gateCodeInput(page)).toBeVisible();

    // Log in with the code once...
    await gateCodeInput(page).fill(hostCode);
    await page.getByRole("button", { name: /^entrar$/i }).click();
    await expect(dashboard(page)).toBeVisible();

    // The property this test is NAMED for, asserted rather than assumed (PR #81
    // review, B2): the login must have CLEARED the marker. Without this line the
    // `clearCookies()` below destroys the marker itself, so deleting the
    // marker-clearing block in POST /api/host/login left this test green — the
    // suite could not tell the fixed code from the broken code. A path mismatch
    // on the clear also fails here, since the stale cookie would survive.
    expect((await page.context().cookies()).map((c) => c.name)).not.toContain(
      `boraoke_noclaim_${id}`,
    );

    // ...and auto-claim works again: drop the host session, keep only identity.
    const context = page.context();
    const identity = (await context.cookies()).find((c) => c.name === IDENTITY_COOKIE);
    await context.clearCookies();
    await context.addCookies([identity!]);
    await page.goto(`/${id}/admin`);
    await expect(dashboard(page)).toBeVisible();
  });

  test("a device that did NOT create the room still hits the code gate", async ({
    page,
    browser,
  }) => {
    await warmUp(page);
    const id = await createRoom(page, "Bar Alheio");

    // A different browser context = a different device: no identity cookie, no
    // remembered rooms. Knowing the room id must buy nothing.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    try {
      await otherPage.goto(`/${id}/admin`);
      await expect(gateCodeInput(otherPage)).toBeVisible();
      await expect(dashboard(otherPage)).toHaveCount(0);
    } finally {
      await other.close();
    }
  });
});

test.describe("returning-creator homepage hero", () => {
  test("the hero leads with the created room and links into admin", async ({ page }) => {
    await warmUp(page);
    const id = await createRoom(page, "Bar do Hero");

    await page.goto("/");

    const hero = page.getByTestId("creator-hero");
    await expect(hero).toBeVisible();
    await expect(hero).toContainText("Bar do Hero");
    const cta = page.getByTestId("creator-hero-admin");
    await expect(cta).toHaveAttribute("href", `/${id}/admin`);

    // The generic create-a-room hero is no longer what leads the page.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

    // And the CTA actually lands in the dashboard, still typing nothing.
    await cta.click();
    await expect(dashboard(page)).toBeVisible();
  });

  test("a first-time visitor sees the generic hero, unchanged", async ({ browser }) => {
    const fresh = await browser.newContext();
    const page = await fresh.newPage();
    try {
      await page.goto("/");
      await expect(page.getByTestId("creator-hero")).toHaveCount(0);
      // The generic hero's create CTA is still the lead action.
      await expect(page.getByRole("link", { name: /come\u00e7ar agora/i }).first()).toBeVisible();
    } finally {
      await fresh.close();
    }
  });
});
