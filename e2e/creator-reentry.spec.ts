import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { warmModerationRoutes } from "./helpers";

/**
 * E2E (TICKET-104): a room's CREATOR gets back into admin without typing.
 *
 * The bug this pins down, in its bluntest form: room creation issues NO host
 * session, so before this ticket a creator who clicked "abrir painel" on the
 * very page that had just shown them the host code landed on the LOGIN GATE and
 * had to type it. Past that moment the code is unrecoverable (only its hash is
 * stored), so the gate is a dead end for the one person who owns the room.
 *
 * The proof is the room's ADMIN CLAIM TOKEN — the httpOnly `boraoke_claim_<room>`
 * cookie, verified against `Room.claimTokenHashes` by POST /api/host/claim. It is
 * deliberately NOT the identity uuid / `creatorUuid`: keying the claim on that is
 * what the PR #81 security gate broke end-to-end, since page JS can read the uuid
 * two ways over. Test 2 is the important one: it strips EVERY cookie and restores
 * only the claim cookie, which is the state a creator is in once the 30-day host
 * session has lapsed or been cleared. Test 3 is the negative control — the same
 * URL from a device without the token must still hit the gate, or the feature
 * would be a room-id-is-admin hole. The last two describes attack the credential
 * itself: exfiltrate-and-replay, and cross-site logout.
 *
 * Runs against `npm run dev` (memory store). Warm-up is mandatory and must
 * include EVERY route the flow touches, /api/host/claim included: a route
 * compiling for the first time AFTER the room is created resets the in-process
 * memory singleton and the room vanishes mid-test.
 */


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
 * Drop every cookie, then put back ONLY the room's admin-claim cookie. This is
 * exactly a creator whose 30-day host session has lapsed or been cleared: the one
 * credential left on the device is the purpose-built claim token, which no page JS
 * has ever seen.
 *
 * It deliberately does NOT keep the identity cookie. Since the security redesign
 * the identity uuid is a non-secret label and must buy nothing here; the
 * exfiltrate-and-replay test below is what pins that.
 */
async function keepOnlyClaimCookie(context: BrowserContext, roomId: string) {
  const all = await context.cookies();
  const claim = all.find((c) => c.name === `boraoke_claim_${roomId}`);
  expect(claim, "room creation must have set the admin-claim cookie").toBeTruthy();
  await context.clearCookies();
  await context.addCookies([claim!]);
  const after = await context.cookies();
  expect(after.map((c) => c.name)).toEqual([`boraoke_claim_${roomId}`]);
}

test.describe("creator admin re-entry", () => {
  test("the creator reaches admin straight from creation, typing nothing", async ({ page }) => {
    await warmUp(page);
    const id = await createRoom(page, "Bar Reentrada");

    await page.goto(`/${id}/admin`);

    await expect(dashboard(page)).toBeVisible();
    await expect(gateCodeInput(page)).toHaveCount(0);
  });

  test("re-entry works with ONLY the claim cookie left (host session gone)", async ({
    page,
    context,
  }) => {
    await warmUp(page);
    const id = await createRoom(page, "Bar Cookie Perdido");

    // Reach admin once so a host session definitely exists, then destroy it.
    await page.goto(`/${id}/admin`);
    await expect(dashboard(page)).toBeVisible();
    await keepOnlyClaimCookie(context, id);

    await page.goto(`/${id}/admin`);

    await expect(dashboard(page)).toBeVisible();
    await expect(gateCodeInput(page)).toHaveCount(0);
    // And the claim really did re-mint a host session cookie for this room.
    const names = (await context.cookies()).map((c) => c.name);
    expect(names).toContain(`cantai_host_${id}`);
  });

  test("deliberate LOGOUT is not undone by auto-claim", async ({ page }) => {
    // The control this protects: on a shared venue tablet, logout must actually
    // log the host out. Without server-side revocation the next admin load would
    // silently claim back in and the next person to pick up the tablet would be
    // host. Revocation now clears the room's claim-token hashes, so the credential
    // is dead for every copy of it, not merely absent from this jar.
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
    // Revocation must not be a one-way door: someone who can present the code has
    // proved possession, so a FRESH credential is minted and frictionless re-entry
    // comes back for them.
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
    // review B2, carried through the redesign): the login must have MINTED a fresh
    // claim credential. Asserted here, before the `clearCookies()` below, which
    // would otherwise destroy the very cookie whose existence is the property —
    // that is exactly how the previous version of this test stayed green against a
    // login route that granted nothing.
    const afterLogin = await page.context().cookies();
    const minted = afterLogin.find((c) => c.name === `boraoke_claim_${id}`);
    expect(minted, "a correct host code must mint a fresh claim credential").toBeTruthy();
    expect(minted!.httpOnly).toBe(true);

    // ...and auto-claim works again off that credential alone.
    await keepOnlyClaimCookie(page.context(), id);
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

/**
 * The two tests below exist because their ABSENCE is why both security blockers
 * reached a gate: a reviewer and a Tech Manager both read the PR's "a cookie page
 * JS cannot read" claim and neither round produced a test that attacks it. Unit
 * tests cannot see either one — the first needs a second browser profile, the
 * second needs a second origin.
 */
test.describe("the claim credential cannot be exfiltrated and replayed (B-S1)", () => {
  test("everything page JS can see is NOT enough to claim the room", async ({
    page,
    browser,
  }) => {
    await warmUp(page);

    // Scrape the /api/identity echo FIRST, before the room exists. The echo is
    // available to page JS at any time, so an attacker is not constrained to do
    // this after creation — and doing it first keeps the documented dev-only
    // memory-store reset (a route's first in-browser compile) off this test's
    // critical path instead of 404-ing the room mid-assertion.
    await page.goto("/");
    const identityEcho = await page.evaluate(async () =>
      fetch("/api/identity", { method: "POST" })
        .then((r) => r.json())
        .catch(() => ({})),
    );

    const id = await createRoom(page, "Bar Exfiltracao");
    await page.goto(`/${id}/admin`);
    await expect(dashboard(page)).toBeVisible();

    // Now play the attacker with one unattended minute at the venue tablet: take
    // everything else page JS can reach — document.cookie and all of localStorage.
    const loot = await page.evaluate(() => {
      const ls: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        ls[k] = localStorage.getItem(k) ?? "";
      }
      return { cookie: document.cookie, localStorage: ls };
    });

    // Sanity: the claim credential is in none of the loot, under any name. If this
    // ever fails, the redesign has been undone.
    const lootBlob = JSON.stringify({ ...loot, identityEcho });
    expect(lootBlob).not.toContain("boraoke_claim");
    const claimCookie = (await page.context().cookies()).find(
      (c) => c.name === `boraoke_claim_${id}`,
    );
    expect(claimCookie, "the creator's device must hold a claim credential").toBeTruthy();
    expect(claimCookie!.httpOnly).toBe(true);
    expect(lootBlob).not.toContain(claimCookie!.value);

    // Now replay every scrap of it from a DIFFERENT browser profile.
    const attacker = await browser.newContext();
    try {
      await attacker.addInitScript((stolen) => {
        for (const [k, v] of Object.entries(stolen as Record<string, string>)) {
          try { localStorage.setItem(k, v); } catch { /* ignore */ }
        }
      }, loot.localStorage);
      // Only credential-SHAPED scraps are worth replaying as cookies, and only
      // those are valid cookie values anyway (the remembered-rooms blob is JSON,
      // which cannot be a cookie value at all — injecting it produced a malformed
      // Cookie header rather than an attack). The loot that matters is the identity
      // uuid: the echo from /api/identity and the localStorage mirror.
      const candidates = [
        identityEcho?.uuid,
        ...Object.values(loot.localStorage),
        ...loot.cookie.split("; ").map((c) => c.split("=").slice(1).join("=")),
      ].filter(
        (v): v is string =>
          typeof v === "string" && /^[A-Za-z0-9._~-]{8,200}$/.test(v),
      );
      expect(candidates.length, "the attacker must have scraped something").toBeGreaterThan(0);
      // Try each stolen value as each credential cookie name the app uses.
      await attacker.addCookies(
        candidates.flatMap((value) =>
          ["boraoke_identity", `boraoke_claim_${id}`, `cantai_host_${id}`].map((name) => ({
            name,
            value,
            domain: "127.0.0.1",
            path: "/",
          })),
        ),
      );
      const apage = await attacker.newPage();
      // The claim must refuse...
      const claim = await apage.request.post(`/api/host/claim?room=${id}`);
      expect(claim.status()).toBe(401);
      // ...and no host authority may be reachable with the loot either.
      const mod = await apage.request.post(`/api/host/moderation?room=${id}`, {
        data: { moderation: true },
      });
      expect(mod.status()).toBe(401);
      // The admin page shows the code gate, not the dashboard.
      await apage.goto(`/${id}/admin`);
      // The attacker must never reach the dashboard. Asserted as an ABSENCE
      // rather than as "the code gate is visible" on purpose: whether the gate or
      // a loading/not-configured state renders depends on the dev server's
      // documented in-process memory-store reset (a route's first compile can
      // drop the room mid-test), which has nothing to do with the credential.
      // The positive "a non-creator sees the code gate" assertion is not lost —
      // it is its own test above, which passes. What must hold here is that no
      // amount of stolen loot renders host controls, and that is what this pins.
      await expect(dashboard(apage)).toHaveCount(0);
    } finally {
      await attacker.close();
    }

    // Deliberately NOTHING is asserted about the victim's own claim here. The
    // obvious closer — "and the owner can still get in" — was written as
    // `expect([200, 401]).toContain(status)` to absorb the dev store's documented
    // reset, which accepts every possible status and therefore asserts nothing
    // at all: it cannot fail, so it is not evidence, and leaving it in would have
    // made this test read as covering one more property than it does. That
    // property is real and is pinned where it can actually fail — the B-S2
    // cross-site test below asserts the owner's claim is exactly 200 after an
    // attack, and "re-entry works with ONLY the claim cookie left" asserts it
    // directly. This test's job is the attacker's side, and it ends here.
  });
});

test.describe("a third-party page cannot lock the creator out (B-S2)", () => {
  test("a cross-site top-level POST to logout changes nothing", async ({ page, context }) => {
    await warmUp(page);
    const id = await createRoom(page, "Bar Csrf Alvo");
    await page.goto(`/${id}/admin`);
    await expect(dashboard(page)).toBeVisible();

    // A genuinely different site, served by intercepting a foreign origin. Only
    // the attacker page is faked; the form POST goes to the real server, as a
    // top-level cross-site navigation — the shape SameSite=lax does not stop,
    // because nothing needs to be SENT for a Set-Cookie to stick.
    const target = `${page.url().split("/").slice(0, 3).join("/")}/api/host/session?room=${id}`;
    await context.route("http://evil.test/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<form id="f" method="POST" action="${target}"></form><script>f.submit()</script>`,
      }),
    );

    const attacker = await context.newPage();
    await attacker.goto("http://evil.test/trap.html");
    await attacker.waitForLoadState("load").catch(() => {});
    await attacker.close();

    // The owner's no-typing re-entry must be untouched: the logout was refused.
    const claim = await page.request.post(`/api/host/claim?room=${id}`);
    expect(claim.status()).toBe(200);
    await page.goto(`/${id}/admin`);
    await expect(dashboard(page)).toBeVisible();
  });

  test("the owner's OWN logout still works, and still sticks", async ({ page }) => {
    await warmUp(page);
    const id = await createRoom(page, "Bar Logout Proprio");
    await page.goto(`/${id}/admin`);
    await expect(dashboard(page)).toBeVisible();

    await page.getByTestId("admin-logout-button").click();
    await page
      .getByTestId("admin-logout-confirm")
      .getByRole("button", { name: /^confirmar$/i })
      .click();
    await expect(gateCodeInput(page)).toBeVisible();

    // Revoked server-side, so a reload cannot auto-claim back in.
    await page.goto(`/${id}/admin`);
    await expect(gateCodeInput(page)).toBeVisible();
    await expect(dashboard(page)).toHaveCount(0);
  });
});
