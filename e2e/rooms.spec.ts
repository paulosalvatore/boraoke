import { test, expect, type Page } from "@playwright/test";

/**
 * E2E (TICKET-9): create a room → join via its URL → submit → the room-scoped
 * TV shows the song; a second room stays empty (queue isolation). Plus the
 * landing join-by-code path.
 *
 * The memory store is per-process, and Playwright runs one dev server, so a
 * room created in a test is resolvable for the rest of that test. Each test
 * gets a fresh browser context (clean localStorage), so nickname/table
 * per-room persistence is exercised in isolation.
 */

/**
 * Compile every room-touching route ONCE up front. Under `next dev` with the
 * in-memory driver, a route's first compilation re-evaluates the shared
 * store/rooms modules and resets their singletons — so a room created before an
 * as-yet-uncompiled room route is hit would be invisible to it. Warming the
 * routes first makes later create→read round-trips stable (production uses
 * durable Upstash and has no such caveat).
 */
async function warmUp(page: Page) {
  await page.request.post("/api/rooms", { data: { name: "warmup" } });
  await page.request.get("/api/rooms?id=default");
  await page.goto("/default");
  await page.goto("/default/tv");
  await page.goto("/default/admin");
}

async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto("/new");
  await page.getByLabel("Nome do bar").fill(name);
  await page.getByRole("button", { name: /^criar sala$/i }).click();
  await page.getByTestId("join-url").waitFor();
  const joinUrl = (await page.getByTestId("join-url").textContent())!.trim();
  const id = joinUrl.split("/").pop()!;
  expect(id.length).toBeGreaterThan(0);
  return id;
}

async function joinAndSubmit(
  page: Page,
  roomId: string,
  nick: string,
  song: string,
  table?: string,
) {
  await page.goto(`/${roomId}`);
  await page.getByLabel("Your nickname").fill(nick);
  await page.getByRole("button", { name: /join queue/i }).click();
  await page.getByRole("heading", { name: /add a song/i }).waitFor();
  if (table) await page.getByLabel("Table number").fill(table);
  await page.getByLabel(/Buscar música/i).fill("https://youtu.be/dQw4w9WgXcQ");
  await expect(page.getByText(/Selected: dQw4w9WgXcQ/)).toBeVisible({ timeout: 3000 });
  await page.getByPlaceholder(/Bohemian Rhapsody/i).fill(song);
  await page.getByRole("button", { name: /add to queue/i }).click();
  await expect(page.getByText(/song added to the queue/i)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(song)).toBeVisible({ timeout: 6000 });
}

test.beforeEach(async ({ page }) => {
  await warmUp(page);
});

test("two rooms stay isolated and the TV shows the room's song", async ({ page }) => {
  const roomA = await createRoom(page, "Bar E2E Um");
  const roomB = await createRoom(page, "Bar E2E Dois");
  expect(roomA).not.toBe(roomB);

  // Submit a song to room A (with a table number → AC3).
  await joinAndSubmit(page, roomA, "AliceE2E", "Musica da Sala A", "7");

  // Room B stays empty — isolated queue (AC2).
  await page.goto(`/${roomB}`);
  await page.getByRole("heading", { name: /add a song/i }).waitFor();
  await expect(page.getByText(/no songs yet/i)).toBeVisible();
  await expect(page.getByText("Musica da Sala A")).toHaveCount(0);

  // Room A's TV shows the song + table metadata (AC3/AC4).
  await page.goto(`/${roomA}/tv`);
  await expect(page.getByTestId("tv-hero")).toContainText("Musica da Sala A", { timeout: 8000 });
  // Scope to the singer line — the TICKET-10 "get to the mic" call also shows the
  // table, so a bare /Mesa 7/ getByText is ambiguous.
  await expect(page.getByTestId("tv-singer")).toContainText("Mesa 7");

  // Room B's TV is idle (the recruitment poster) — no song.
  await page.goto(`/${roomB}/tv`);
  await expect(page.getByTestId("tv-idle")).toBeVisible({ timeout: 8000 });
});

test("landing join-by-code navigates into the room", async ({ page }) => {
  const room = await createRoom(page, "Bar Codigo");

  await page.goto("/");
  await page.getByLabel(/Código da sala/i).fill(room);
  await page.getByRole("button", { name: /^entrar$/i }).click();

  // Lands on the room's patron page (nickname gate, then the venue chip).
  await page.getByLabel("Your nickname").waitFor();
  await expect(page).toHaveURL(new RegExp(`/${room}$`));
});

test("an unknown room shows a not-found landing, not a broken page", async ({ page }) => {
  await page.goto("/no-such-room-zzzz");
  await expect(page.getByText(/Essa sala não existe/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /voltar ao início/i })).toBeVisible();
});
