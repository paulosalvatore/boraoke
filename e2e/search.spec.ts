import { test, expect, type Page } from "@playwright/test";

/**
 * E2E for the in-app YouTube search (TICKET-8).
 *
 * The /api/search endpoint is MOCKED via page.route so these tests never call
 * the live Google Data API and pass with no YOUTUBE_API_KEY provisioned.
 * We verify: search → select → submit queues the picked videoId, and the
 * degraded (quota/no-key) state keeps the paste-link fallback working.
 */

const MOCK_RESULTS = [
  {
    videoId: "dQw4w9WgXcQ",
    title: "Evidências (Ao Vivo)",
    channelTitle: "Chitãozinho & Xororó",
    duration: "4:13",
    thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
  },
  {
    videoId: "9bZkp7q19f0",
    title: "Evidências (Karaokê)",
    channelTitle: "Karaokê Hits",
    duration: "4:20",
    thumbnailUrl: "https://i.ytimg.com/vi/9bZkp7q19f0/mqdefault.jpg",
  },
];

async function joinAs(page: Page, nick: string) {
  await page.goto("/default");
  await page.getByLabel("Seu apelido").waitFor();
  await page.getByPlaceholder(/ex\.: Maria/i).fill(nick);
  await page.getByRole("button", { name: /entrar na fila/i }).click();
  await page.getByRole("heading", { name: /adicionar música/i }).waitFor();
}

test("search → select a result → submit queues the picked video", async ({ page }) => {
  await page.route("**/api/search**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: MOCK_RESULTS }),
    });
  });

  await joinAs(page, "SearchUser");

  await page.getByLabel(/Buscar música/i).fill("evidencias");

  // Results render; pick the first.
  const firstResult = page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i });
  await expect(firstResult).toBeVisible({ timeout: 5000 });
  await firstResult.click();

  // Selection confirmed + CTA enabled.
  await expect(page.getByText(/Selecionada: dQw4w9WgXcQ/)).toBeVisible();

  await page.getByRole("button", { name: /adicionar à fila/i }).click();
  await expect(page.getByText(/música na fila/i)).toBeVisible({ timeout: 5000 });

  // The picked song (title from the search result) shows in the live queue.
  await expect(page.getByText("Evidências (Ao Vivo)").last()).toBeVisible({ timeout: 6000 });
});

test("select a result jumps focus to the add-to-queue CTA (TICKET-40 §1)", async ({ page }) => {
  await page.route("**/api/search**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: MOCK_RESULTS }),
    });
  });

  await joinAs(page, "JumpUser");

  await page.getByLabel(/Buscar música/i).fill("evidencias");

  const firstResult = page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i });
  await expect(firstResult).toBeVisible({ timeout: 5000 });
  await firstResult.click();

  // The CTA is now the focused element and is visible — no hunt required.
  const cta = page.getByRole("button", { name: /adicionar à fila/i });
  await expect(cta).toBeVisible();
  await expect(cta).toBeFocused();
  // NOT auto-submitted — the CTA is still present (no success toast yet).
  await expect(page.getByText(/música na fila/i)).toHaveCount(0);
});

test("sing mode appends 'karaoke' to the search query (TICKET-40 §2)", async ({ page }) => {
  const seenQueries: string[] = [];
  await page.route("**/api/search**", async (route) => {
    const url = new URL(route.request().url());
    seenQueries.push(url.searchParams.get("q") ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: MOCK_RESULTS }),
    });
  });

  await joinAs(page, "SingUser");

  // Sing is the default mode; the outgoing query must carry the karaoke keyword.
  await page.getByLabel(/Buscar música/i).fill("evidencias");
  await expect(page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i })).toBeVisible({ timeout: 5000 });
  expect(seenQueries.at(-1)).toBe("evidencias karaoke");
});

/**
 * TICKET-83 §1 — THE quota acceptance criterion. Changing the sing/vibe mode
 * must fire ZERO YouTube searches; the count is asserted, not assumed. A
 * re-search only happens when the patron explicitly asks for one.
 */
test("changing the mode fires NO search (TICKET-83 §1)", async ({ page }) => {
  const seenQueries: string[] = [];
  await page.route("**/api/search**", async (route) => {
    seenQueries.push(new URL(route.request().url()).searchParams.get("q") ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: MOCK_RESULTS }),
    });
  });

  await joinAs(page, "ModeUser");

  // The chooser sits ABOVE the input and is pre-set to "sing" — a patron can
  // type immediately without answering anything first.
  const sing = page.getByRole("radio", { name: /Cantar/i });
  const vibe = page.getByRole("radio", { name: /Só curtir/i });
  await expect(sing).toBeChecked();

  // (a) Change the mode BEFORE typing anything → free, and no call at all.
  await vibe.check();
  await sing.check();
  expect(seenQueries).toHaveLength(0);

  // (b) Now search once.
  await page.getByLabel(/Buscar música/i).fill("evidencias");
  await expect(page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i })).toBeVisible({ timeout: 5000 });
  expect(seenQueries).toEqual(["evidencias karaoke"]);
  await expect(page.getByTestId("search-results-mode")).toContainText(/Cantar/i);

  // (c) Change the mode AFTER results are on screen → still ZERO new calls.
  await vibe.check();
  await page.waitForTimeout(1200); // longer than the 400ms debounce
  expect(seenQueries).toEqual(["evidencias karaoke"]);
  // The UI is honest about it: results are labelled with the mode they came from.
  await expect(page.getByTestId("search-mode-stale")).toBeVisible();

  // (d) A re-search is an EXPLICIT tap, and only then does a call go out (raw query).
  await page.getByTestId("search-again").click();
  await expect.poll(() => seenQueries.length, { timeout: 5000 }).toBe(2);
  expect(seenQueries.at(-1)).toBe("evidencias");
  await expect(page.getByTestId("search-mode-stale")).toHaveCount(0);
});

/**
 * TICKET-83 §2 — pagination. The server hands over a big first page (up to 50
 * rows for ONE of the platform's 100 daily searches); "load more" reveals them 8
 * at a time with no further network traffic, asks for a real second page only
 * once they run out, and refuses to go past MAX_SEARCH_PAGES at all.
 */
test("load more pages through results, revealing fetched rows for free", async ({ page }) => {
  const requests: { q: string; pageToken: string | null; page: string | null }[] = [];
  const pageOne = Array.from({ length: 12 }, (_, i) => ({
    videoId: `p1vid${i}`,
    title: `Page1 Song ${i}`,
    channelTitle: "Ch",
    duration: "3:00",
    thumbnailUrl: "https://i.ytimg.com/vi/x/mqdefault.jpg",
  }));
  const pageTwo = Array.from({ length: 3 }, (_, i) => ({
    videoId: `p2vid${i}`,
    title: `Page2 Song ${i}`,
    channelTitle: "Ch",
    duration: "3:00",
    thumbnailUrl: "https://i.ytimg.com/vi/x/mqdefault.jpg",
  }));

  await page.route("**/api/search**", async (route) => {
    const url = new URL(route.request().url());
    const pageToken = url.searchParams.get("pageToken");
    requests.push({
      q: url.searchParams.get("q") ?? "",
      pageToken,
      page: url.searchParams.get("page"),
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        pageToken
          // Google still offers MORE pages — the client must refuse anyway,
          // because page depth is capped at MAX_SEARCH_PAGES (TICKET-83).
          ? { results: pageTwo, nextPageToken: "CURSOR_3" }
          : { results: pageOne, nextPageToken: "CURSOR_2" },
      ),
    });
  });

  await joinAs(page, "PageUser");
  await page.getByLabel(/Buscar música/i).fill("evidencias");

  // First render shows one client page (8 of the 12 fetched rows).
  await expect(page.getByRole("button", { name: /Page1 Song 0/ })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole("button", { name: /Page1 Song 7/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Page1 Song 8/ })).toHaveCount(0);
  expect(requests).toHaveLength(1);

  // Tap 1: reveals rows 8-11, ALREADY FETCHED → no new request, zero quota.
  await page.getByTestId("search-load-more").click();
  await expect(page.getByRole("button", { name: /Page1 Song 11/ })).toBeVisible();
  expect(requests).toHaveLength(1);

  // Tap 2: the fetched rows are exhausted, so now (and only now) the next
  // server page is requested — carrying the cursor.
  await page.getByTestId("search-load-more").click();
  await expect(page.getByRole("button", { name: /Page2 Song 0/ })).toBeVisible({ timeout: 5000 });
  expect(requests).toHaveLength(2);
  expect(requests[1].pageToken).toBe("CURSOR_2");

  // The page budget (MAX_SEARCH_PAGES = 2) is now spent. Even though Google
  // offered a CURSOR_3, the affordance retires rather than spending a third of
  // the platform's daily searches, and the copy suggests refining instead.
  await expect(page.getByTestId("search-load-more")).toHaveCount(0);
  await expect(page.getByTestId("search-no-more")).toBeVisible();
  await expect(page.getByTestId("search-no-more")).toContainText(/outras palavras/i);
  expect(requests).toHaveLength(2);
  // The deep request declared its depth so the server could enforce the cap too.
  expect(requests[1].page).toBe("2");

  // A deep-page result is still selectable and submittable.
  await page.getByRole("button", { name: /Page2 Song 0/ }).click();
  await expect(page.getByText(/Selecionada: p2vid0/)).toBeVisible();
});

test("a short result set shows no load-more affordance", async ({ page }) => {
  await page.route("**/api/search**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: MOCK_RESULTS }),
    });
  });

  await joinAs(page, "ShortUser");
  await page.getByLabel(/Buscar música/i).fill("evidencias");
  await expect(page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i })).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("search-load-more")).toHaveCount(0);
});

test("degraded search shows fallback copy but paste-link still works", async ({ page }) => {
  // Simulate no key / quota: the API returns the degraded contract.
  await page.route("**/api/search**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ degraded: true, reason: "quota", results: [] }),
    });
  });

  await joinAs(page, "DegradedUser");

  const input = page.getByLabel(/Buscar música/i);
  await input.fill("alguma musica");

  // Fallback copy is shown.
  await expect(page.getByText(/Busca indisponível — cola o link do YouTube/)).toBeVisible({ timeout: 5000 });

  // Pasting a link resolves locally (no API) and becomes selectable/submittable.
  await input.fill("https://youtu.be/dQw4w9WgXcQ");
  await expect(page.getByText(/Selecionada: dQw4w9WgXcQ/)).toBeVisible({ timeout: 5000 });

  // TICKET-40-BUG-01 regression: the paste-resolve in DEGRADED mode must ALSO
  // jump focus to the (now enabled) add-to-queue CTA. The jump is an effect on
  // the selection state, so it fires after React commits — the button is
  // enabled by the time .focus() runs.
  const cta = page.getByRole("button", { name: /adicionar à fila/i });
  await expect(cta).toBeEnabled();
  await expect(cta).toBeFocused();

  await cta.click();
  await expect(page.getByText(/música na fila/i)).toBeVisible({ timeout: 5000 });
});

/**
 * TICKET-83: pagination must be ABSENT (not broken) on the degraded path, and
 * the mode chooser must still work there — it costs nothing either way.
 */
test("degraded search has no pagination and the mode chooser still works", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/search**", async (route) => {
    calls++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ degraded: true, reason: "no-api-key", results: [] }),
    });
  });

  await joinAs(page, "DegradedPageUser");
  await page.getByLabel(/Buscar música/i).fill("alguma musica");
  await expect(page.getByTestId("search-degraded")).toBeVisible({ timeout: 5000 });

  // No results → no load-more, no mode badge, nothing to page through.
  await expect(page.getByTestId("search-load-more")).toHaveCount(0);
  await expect(page.getByTestId("search-results-mode")).toHaveCount(0);

  const callsAfterSearch = calls;
  await page.getByRole("radio", { name: /Só curtir/i }).check();
  await page.waitForTimeout(1200);
  expect(calls).toBe(callsAfterSearch);

  // Paste-a-link is untouched by any of this.
  await page.getByLabel(/Buscar música/i).fill("https://youtu.be/dQw4w9WgXcQ");
  await expect(page.getByText(/Selecionada: dQw4w9WgXcQ/)).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("search-load-more")).toHaveCount(0);
});

/**
 * TICKET-83 reviewer finding 2 — "load more" must never pair a NEW query with
 * the PREVIOUS query's cursor. That combination is a guaranteed cache miss:
 * one of the platform's 100 daily searches spent on a request whose results are
 * junk, then cached for 12h. The affordance withdraws while the debounce is in
 * flight rather than paging a query the patron has moved off.
 */
test("load more withdraws once the query is edited (no stale-cursor search)", async ({ page }) => {
  const requests: { q: string; pageToken: string | null }[] = [];
  const many = Array.from({ length: 12 }, (_, i) => ({
    videoId: `svid${i}`,
    title: `Stale Song ${i}`,
    channelTitle: "Ch",
    duration: "3:00",
    thumbnailUrl: "https://i.ytimg.com/vi/x/mqdefault.jpg",
  }));

  await page.route("**/api/search**", async (route) => {
    const url = new URL(route.request().url());
    requests.push({ q: url.searchParams.get("q") ?? "", pageToken: url.searchParams.get("pageToken") });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: many, nextPageToken: "CURSOR_2" }),
    });
  });

  await joinAs(page, "StaleUser");
  const input = page.getByLabel(/Buscar música/i);
  await input.fill("evidencias");
  await expect(page.getByRole("button", { name: /Stale Song 0/ })).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("search-load-more")).toBeVisible();

  // Edit the query. For the length of the debounce the OLD results are still
  // painted while the cursor belongs to a query the patron has abandoned —
  // `queryDirty` withdraws the affordance across that window. (That window is a
  // few hundred ms, so it is not asserted here; what IS asserted below is the
  // guarantee it protects, which holds deterministically.)
  await input.fill("outra musica");
  // The mock returns identical rows for both queries, so "results are visible"
  // proves nothing here — wait for the SECOND search to actually land.
  await expect.poll(() => requests.length, { timeout: 5000 }).toBe(2);

  // Page all the way into a deep fetch against the NEW query. (Wait for the
  // reveal to commit between taps — two taps inside one render both read the
  // same handler closure and would merely reveal twice, which is free but not
  // what this test is exercising.)
  await page.getByTestId("search-load-more").click();
  await expect(page.getByRole("button", { name: /Stale Song 11/ })).toBeVisible();
  await page.getByTestId("search-load-more").click();
  await expect.poll(() => requests.filter((r) => r.pageToken).length, { timeout: 5000 }).toBe(1);

  const deep = requests.filter((r) => r.pageToken);
  expect(deep).toHaveLength(1);
  // The critical assertion: the cursor was never paired with a different query.
  expect(deep[0].q).toBe("outra musica karaoke");
});
