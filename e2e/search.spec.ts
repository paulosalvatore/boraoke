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
  await page.getByLabel("Your nickname").waitFor();
  await page.getByPlaceholder(/nickname|e\.g\. Maria/i).fill(nick);
  await page.getByRole("button", { name: /join queue/i }).click();
  await page.getByRole("heading", { name: /add a song/i }).waitFor();
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
  await expect(page.getByText(/Selected: dQw4w9WgXcQ/)).toBeVisible();

  await page.getByRole("button", { name: /add to queue/i }).click();
  await expect(page.getByText(/song added to the queue/i)).toBeVisible({ timeout: 5000 });

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
  const cta = page.getByRole("button", { name: /add to queue/i });
  await expect(cta).toBeVisible();
  await expect(cta).toBeFocused();
  // NOT auto-submitted — the CTA is still present (no success toast yet).
  await expect(page.getByText(/song added to the queue/i)).toHaveCount(0);
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

  // Switch to listen/dance → the query is searched raw (re-run on mode switch).
  await page.getByLabel("Mode").selectOption("listen-dance");
  await expect
    .poll(() => seenQueries.at(-1), { timeout: 5000 })
    .toBe("evidencias");
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
  await expect(page.getByText(/Selected: dQw4w9WgXcQ/)).toBeVisible({ timeout: 5000 });

  // TICKET-40-BUG-01 regression: the paste-resolve in DEGRADED mode must ALSO
  // jump focus to the (now enabled) add-to-queue CTA. The jump is an effect on
  // the selection state, so it fires after React commits — the button is
  // enabled by the time .focus() runs.
  const cta = page.getByRole("button", { name: /add to queue/i });
  await expect(cta).toBeEnabled();
  await expect(cta).toBeFocused();

  await cta.click();
  await expect(page.getByText(/song added to the queue/i)).toBeVisible({ timeout: 5000 });
});
