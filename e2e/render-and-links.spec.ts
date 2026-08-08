import { test, expect, type Page } from "@playwright/test";

/**
 * TICKET-20 — Render + link test suite. The TL explicitly distrusts prior
 * coverage, so this asserts that EVERY page renders its essential elements and
 * that EVERY internal href on every page resolves non-404.
 *
 * Determinism: under `next dev` with the in-memory driver, a route's FIRST
 * compilation re-evaluates the shared store/rooms modules and resets their
 * singletons — so state seeded before an as-yet-uncompiled route is hit would be
 * invisible to it. `warmUp` compiles every route up front so later
 * create→read→login round-trips are stable (prod uses durable Upstash — no such
 * caveat). Serial workers (playwright.config) keep the shared store sane.
 */

const DEV_TOKEN = "cantai-dev-host";
const YT_ID = "dQw4w9WgXcQ";
const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );

/** Compile every route (and every host endpoint) once, before any seeding. */
async function warmUp(page: Page) {
  const req = page.request;
  await req.post("/api/rooms", { data: { name: "warmup" } });
  await req.get("/api/rooms?id=default");
  await req.post("/api/host/login", { data: { token: DEV_TOKEN } });
  await req.get("/api/host/session");
  await req.get("/api/queue");
  await page.goto("/");
  await page.goto("/new");
  await page.goto("/default");
  await page.goto("/default/tv");
  await page.goto("/default/admin");
}

/** Create a room via /new and return its id + one-time host code. */
async function createRoom(
  page: Page,
  name: string,
): Promise<{ id: string; hostCode: string }> {
  await page.goto("/new");
  await page.getByLabel("Nome do bar").fill(name);
  await page.getByRole("button", { name: /^criar sala$/i }).click();
  await page.getByTestId("join-url").waitFor();
  const joinUrl = (await page.getByTestId("join-url").textContent())!.trim();
  const id = joinUrl.split("/").pop()!;
  const hostCode = (await page.getByTestId("host-code").textContent())!.trim();
  expect(id.length).toBeGreaterThan(0);
  expect(hostCode.length).toBeGreaterThan(0);
  return { id, hostCode };
}

async function seedSong(page: Page, roomId: string, title: string) {
  const res = await page.request.post(
    `/api/queue?room=${encodeURIComponent(roomId)}`,
    {
      data: {
        room: roomId,
        videoId: YT_ID,
        title,
        nickname: "Seeder",
        patronUuid: uuid(),
        mode: "sing",
      },
    },
  );
  expect(res.ok()).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await warmUp(page);
});

// ─── Per-page render assertions ────────────────────────────────────────────

test("landing renders create CTA + a working join-code input", async ({ page }) => {
  await page.goto("/");
  // create-your-room CTA
  // TICKET-69: the landing is now Direction 2 ("Demo vivo") — the create CTA
  // reads "Começar agora — é grátis" and still points at /new in one click.
  const createCta = page.getByRole("link", { name: /começar agora/i });
  await expect(createCta).toBeVisible();
  await expect(createCta).toHaveAttribute("href", "/new");
  // join-by-code input (TICKET-20 bug #2: must be present + usable)
  const codeInput = page.getByLabel(/código da sala/i);
  await expect(codeInput).toBeVisible();
  await codeInput.fill("bar-teste");
  await expect(page.getByRole("button", { name: /^entrar$/i })).toBeEnabled();
});

/**
 * TICKET-69 / TL decision: the four venue names are a MESSAGE ("boraoke is not
 * bar-only"), not a control. They shipped briefly as filter chips with one
 * "selected", which promised per-venue switching that does not exist — venue
 * presets are TICKET-32, Phase 3, not started. This pins the honest version so
 * a future restyle cannot quietly re-add the affordance: the names must be
 * visible, and none of them may be activatable or announced as selectable.
 */
test("landing venue labels are visible but NOT interactive (no promised filter)", async ({ page }) => {
  await page.goto("/");

  const names = ["No bar", "Na festa", "No condomínio", "Na empresa"];
  for (const name of names) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }

  // Nothing activatable carrying a venue name: no button/link/tab/option role,
  // no aria-selected, no tabindex, no click handler affordance.
  for (const name of names) {
    for (const role of ["button", "link", "tab", "option", "radio", "checkbox"] as const) {
      await expect(
        page.getByRole(role, { name, exact: true }),
        `venue name "${name}" must not be exposed as a ${role} — venue presets (TICKET-32) do not ship`,
      ).toHaveCount(0);
    }
  }

  const interactive = await page.evaluate((venueNames) => {
    const hits: string[] = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const text = (el.textContent ?? "").trim();
      if (!venueNames.includes(text)) continue;
      if (el.children.length > 0) continue; // leaf node carrying the name only
      const tag = el.tagName.toLowerCase();
      if (["button", "a", "input", "select", "summary"].includes(tag)) hits.push(`${text}:<${tag}>`);
      if (el.hasAttribute("tabindex")) hits.push(`${text}:tabindex`);
      if (el.hasAttribute("aria-selected")) hits.push(`${text}:aria-selected`);
      if (el.hasAttribute("role")) hits.push(`${text}:role=${el.getAttribute("role")}`);
      if (getComputedStyle(el).cursor === "pointer") hits.push(`${text}:cursor-pointer`);
    }
    return hits;
  }, names);

  expect(
    interactive,
    "venue labels must carry no interactive tag/role/tabindex/aria-selected/pointer-cursor",
  ).toEqual([]);
});

/**
 * Accessible-NAME assertions for the same block, kept separate because they
 * exist for a specific reason: the first version of this markup shipped with
 * two code comments that described intent rather than observed behaviour, and
 * both were false. Chromium folded the decorative "·" (then a CSS `::after`)
 * into each listitem's accessible name, and an `aria-labelledby` on the list
 * made the lead-in announce twice. Reading the CSS could never have caught
 * either — only the a11y tree shows it — so it is pinned here.
 */
test("landing venue labels expose clean accessible names (no separator, no double-announce)", async ({ page }) => {
  await page.goto("/");

  const venues = ["No bar", "Na festa", "No condomínio", "Na empresa"];
  const lead = "Onde dá pra usar";

  // Read the REAL accessibility tree out of Chromium (CDP), rather than
  // inferring it from the DOM or the CSS — inference is precisely what produced
  // the two false claims this test exists to prevent. Chromium is the only
  // browser this suite runs (see playwright.config.ts projects).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Accessibility.enable");
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
    nodes: { ignored?: boolean; role?: { value?: string }; name?: { value?: string } }[];
  };
  const axNames = nodes
    .filter((n) => !n.ignored && n.name?.value)
    .map((n) => n.name!.value as string);

  // Each venue name must reach the a11y tree as its own exact node. If the
  // decorative "·" were folded in (it was, as a CSS ::after) the node would
  // read "No bar·" and this fails.
  for (const venue of venues) {
    expect(
      axNames,
      `"${venue}" must reach the accessibility tree as an exact name — a decorative separator must not be folded in`,
    ).toContain(venue);
    expect(
      axNames.filter((n) => n.startsWith(venue) && n.includes("·")),
      `no a11y node may announce "${venue}" with the decorative separator attached`,
    ).toEqual([]);
  }

  // The lead-in must not ALSO become the list's accessible name — that
  // aria-labelledby was what made it announce twice.
  const listNaming = await page
    .locator("ul")
    .filter({ hasText: venues[0] })
    .evaluate((el) => ({
      ariaLabel: el.getAttribute("aria-label"),
      ariaLabelledby: el.getAttribute("aria-labelledby"),
    }));
  expect(
    listNaming,
    `the venue list must carry no accessible name — the visible "${lead}" lead-in already supplies the framing`,
  ).toEqual({ ariaLabel: null, ariaLabelledby: null });

  // The separators must be explicitly hidden from assistive tech.
  const seps = await page
    .locator("ul")
    .filter({ hasText: venues[0] })
    .evaluate((el) =>
      Array.from(el.querySelectorAll("li > span"))
        .filter((s) => (s.textContent ?? "").trim() === "·")
        .map((s) => s.getAttribute("aria-hidden")),
    );
  expect(seps.length, "expected one separator between each pair of venue names").toBe(venues.length - 1);
  expect(seps.every((v) => v === "true"), "every decorative separator must be aria-hidden").toBe(true);
});

test("/new renders the create form", async ({ page }) => {
  await page.goto("/new");
  await expect(page.getByLabel(/nome do bar/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^criar sala$/i })).toBeVisible();
});

test("/new?name= prefills the venue name (recreate path)", async ({ page }) => {
  await page.goto("/new?name=Bar%20Do%20Paulin");
  await expect(page.getByLabel(/nome do bar/i)).toHaveValue("Bar Do Paulin");
});

test("/[room] renders join form, then song input + queue + player-hint", async ({ page }) => {
  const { id } = await createRoom(page, "Bar Render Patron");
  await page.goto(`/${id}`);

  // join (nickname) gate
  const nick = page.getByLabel("Seu apelido");
  await expect(nick).toBeVisible();
  await nick.fill("RenderTester");
  await page.getByRole("button", { name: /entrar na fila/i }).click();

  // post-join essentials
  await expect(page.getByRole("heading", { name: /adicionar música/i })).toBeVisible();
  await expect(page.getByLabel(/buscar música/i)).toBeVisible(); // song input
  await expect(page.getByRole("heading", { name: /fila ao vivo/i })).toBeVisible();
  // player-hint (TICKET-20 #3: patron page has no player by design → hint to TV)
  const hint = page.getByTestId("patron-player-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toHaveAttribute("href", `/${id}/tv`);
});

test("room-404: valid slug shows recreate path; unknown text present", async ({ page }) => {
  await page.goto("/sala-que-nao-existe-xyz");
  await expect(page.getByText(/essa sala não existe/i)).toBeVisible();
  // one-click recreate (TICKET-20 #1b) — derived name prefilled into /new
  const recreate = page.getByTestId("recreate-room");
  await expect(recreate).toBeVisible();
  await expect(recreate).toHaveAttribute("href", /\/new\?name=/);
  await expect(page.getByRole("link", { name: /voltar ao início/i })).toBeVisible();
});

test("/[room]/tv renders the YT iframe host with a seeded queue", async ({ page }) => {
  const { id } = await createRoom(page, "Bar Render Tv");
  await seedSong(page, id, "Musica de Render");
  await page.goto(`/${id}/tv`);
  await expect(page.getByTestId("tv-hero")).toContainText("Musica de Render", { timeout: 8000 });
  // the YT player mount point exists only when something is playing
  await expect(page.locator("#yt-player")).toHaveCount(1);
});

test("/[room]/tv renders a sane idle state with an empty queue", async ({ page }) => {
  const { id } = await createRoom(page, "Bar Render Idle");
  await page.goto(`/${id}/tv`);
  await expect(page.getByTestId("tv-idle")).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(/escaneia e canta/i)).toBeVisible();
  // no dead player panel while idle
  await expect(page.locator("#yt-player")).toHaveCount(0);
});

test("/[room]/admin: login → controls + mode switcher + customer-screen links", async ({ page }) => {
  const { id, hostCode } = await createRoom(page, "Bar Render Admin");
  await page.goto(`/${id}/admin`);

  // login gate
  const token = page.getByLabel(/código do host/i);
  await expect(token).toBeVisible();
  await token.fill(hostCode);
  await page.getByRole("button", { name: /^entrar$/i }).click();

  // dashboard essentials
  await expect(page.getByRole("button", { name: /pausar|retomar/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /pular música/i })).toBeVisible();
  // mode switcher (TICKET-10)
  const modeSwitcher = page.getByRole("radiogroup", { name: /modo de rodízio/i });
  await expect(modeSwitcher).toBeVisible();
  await expect(modeSwitcher).toContainText(/karaokê completo/i);
  // TICKET-20 #5: links to both customer-facing screens of this room
  await expect(page.getByTestId("admin-patron-link")).toHaveAttribute("href", `/${id}`);
  await expect(page.getByTestId("admin-tv-link")).toHaveAttribute("href", `/${id}/tv`);
});

test("legacy /admin and /tv redirect into the default room (no dead routes)", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/default\/admin$/);
  await page.goto("/tv");
  await expect(page).toHaveURL(/\/default\/tv$/);
});

// ─── Link crawler ──────────────────────────────────────────────────────────

/**
 * Every internal href on a page must resolve non-404. We collect same-origin
 * `<a href>`s (skipping the YT iframe / external links), then HEAD/GET each and
 * assert the status is not 404. Static-route slugs and `mailto:` are skipped.
 */
async function crawlLinks(page: Page, path: string) {
  await page.goto(path);
  // give client components (nickname gate etc.) a beat to render their links
  await page.waitForTimeout(300);
  const hrefs: string[] = await page.evaluate(() => {
    const origin = window.location.origin;
    return Array.from(document.querySelectorAll("a[href]"))
      .map((a) => (a as HTMLAnchorElement).href)
      .filter((h) => h.startsWith(origin))
      .map((h) => h.replace(origin, ""))
      .filter((h) => h && !h.startsWith("#") && !h.startsWith("mailto:"));
  });
  const unique = Array.from(new Set(hrefs));
  for (const href of unique) {
    const res = await page.request.get(href);
    expect(
      res.status(),
      `internal link ${href} on ${path} must not 404`,
    ).not.toBe(404);
  }
  return unique;
}

test("link-crawler: landing, /new, and a live room's pages have no 404 links", async ({ page }) => {
  const { id } = await createRoom(page, "Bar Crawler");
  await seedSong(page, id, "Cancao Crawler");

  await crawlLinks(page, "/");
  await crawlLinks(page, "/new");
  await crawlLinks(page, `/${id}/tv`);
  // patron + admin render their internal links only after the client gate; the
  // static links they DO expose server-side (footer, etc.) are covered here.
  await crawlLinks(page, `/${id}`);
});
