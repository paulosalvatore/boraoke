import { test, expect, type Page } from "@playwright/test";

/**
 * E2E (TICKET-43): device-level room memory ("Suas salas") + recovery.
 *
 * Covers the full user-visible loop:
 *  - create a room → landing "Suas salas" lists it (created role) → its links work
 *  - join a room as a patron → it is remembered (joined role)
 *  - the ✕ forget control removes a room from the list
 *
 * Same in-memory-store caveat as rooms.spec.ts: warm the room routes up front so
 * a created room stays resolvable for the rest of the test. Each test gets a
 * fresh browser context (clean localStorage), so the remembered-rooms list
 * starts empty.
 */

async function warmUp(page: Page) {
  await page.request.post("/api/rooms", { data: { name: "warmup" } });
  await page.goto("/default");
  await page.goto("/default/admin");
  await page.goto("/default/tv");
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

test.beforeEach(async ({ page }) => {
  await warmUp(page);
});

test("a created room appears under Suas salas with working links", async ({ page }) => {
  const roomId = await createRoom(page, "Bar Memoria");

  await page.goto("/");
  const section = page.getByTestId("saved-rooms");
  await expect(section).toBeVisible();
  await expect(section).toContainText("salvas neste dispositivo", { ignoreCase: true });

  const row = page.getByTestId("saved-room").filter({ hasText: "Bar Memoria" });
  await expect(row).toBeVisible();

  // A created room exposes patron + admin + tv links.
  await expect(row.getByTestId("saved-room-patron")).toBeVisible();
  await expect(row.getByTestId("saved-room-admin")).toBeVisible();
  await expect(row.getByTestId("saved-room-tv")).toBeVisible();

  // The patron quick-link navigates into the room.
  await row.getByTestId("saved-room-patron").click();
  await page.getByLabel("Your nickname").waitFor();
  await expect(page).toHaveURL(new RegExp(`/${roomId}$`));
});

test("joining a room as a patron remembers it (joined role)", async ({ page }) => {
  const roomId = await createRoom(page, "Bar Convidado");

  // Join as a patron from a clean device state: clear the created-room memory
  // first so we prove the JOIN path itself records the room.
  await page.goto("/");
  await page.evaluate(() => window.localStorage.removeItem("cantai_rooms_v1"));

  await page.goto(`/${roomId}`);
  await page.getByLabel("Your nickname").fill("Convidada");
  await page.getByRole("button", { name: /join queue/i }).click();
  await page.getByRole("heading", { name: /add a song/i }).waitFor();

  await page.goto("/");
  const row = page.getByTestId("saved-room").filter({ hasText: "Bar Convidado" });
  await expect(row).toBeVisible();
  // A joined (non-created) room offers only the patron entry link.
  await expect(row.getByTestId("saved-room-patron")).toBeVisible();
  await expect(row.getByTestId("saved-room-admin")).toHaveCount(0);
});

test("the ✕ control forgets a room", async ({ page }) => {
  await createRoom(page, "Bar Esquecivel");

  await page.goto("/");
  const row = page.getByTestId("saved-room").filter({ hasText: "Bar Esquecivel" });
  await expect(row).toBeVisible();

  await row.getByTestId("saved-room-forget").click();
  await expect(page.getByTestId("saved-room").filter({ hasText: "Bar Esquecivel" })).toHaveCount(0);

  // The forget persists across a reload (it was removed from localStorage).
  await page.reload();
  await expect(page.getByTestId("saved-room").filter({ hasText: "Bar Esquecivel" })).toHaveCount(0);
});
