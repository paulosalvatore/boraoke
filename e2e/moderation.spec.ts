import { test, expect, type Page } from "@playwright/test";
import { warmModerationRoutes, dropCreatorIdentity } from "./helpers";

/**
 * E2E (TICKET-44): venue-optional song moderation.
 *
 *   ON  → patron submit lands in PENDING (not the public queue / not on TV);
 *         patron sees "aguardando aprovação"; host approves → song appears in the
 *         queue; host rejects → patron sees a polite rejected state.
 *   OFF → submission is unchanged (straight to the queue).
 *
 * Runs against `npm run dev` (memory store, dev host-auth). Each test creates its
 * own room via /new (which shows the one-time host code), so the admin can log in
 * with the room's real code — the dev fallback token only covers `default`.
 */

async function warmUp(page: Page) {
  // Compile EVERY route the flow touches so a first-compilation never resets the
  // in-memory rooms/store singleton AFTER we've created a room (the documented
  // per-process memory-driver caveat; prod uses durable Upstash). Missing even
  // one API route here makes a created room vanish the first time that route
  // compiles mid-test → the admin login reports "not configured".
  await page.request.post("/api/rooms", { data: { name: "warmup" } });
  await page.request.post("/api/host/login", { data: { token: "cantai-dev-host" } });
  await page.request.get("/api/host/session?room=default");
  await warmModerationRoutes(page.request);
  await page.request.get("/api/queue?room=default");
  await page.request.post("/api/queue", {
    data: { room: "default", videoId: "dQw4w9WgXcQ", nickname: "warm", patronUuid: "00000000-0000-4000-8000-000000000000", mode: "sing" },
  });
  await page.goto("/default");
  await page.goto("/default/admin");
  await page.goto("/default/tv");
  await page.goto("/new");
}

async function createRoom(page: Page, name: string): Promise<{ id: string; hostCode: string }> {
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

async function loginAdmin(page: Page, id: string, hostCode: string) {
  // TICKET-104: the creator is auto-claimed straight into the dashboard now, so
  // to exercise the host-code gate this browser must stop being the creator.
  await dropCreatorIdentity(page);
  await page.goto(`/${id}/admin`);
  const codeInput = page.getByLabel("Código do host");
  await codeInput.waitFor();
  await codeInput.fill(hostCode);
  await page.getByRole("button", { name: /entrar/i }).click();
  // Dashboard renders once authed.
  await page.getByTestId("moderation-card").waitFor();
}

async function setModeration(page: Page, on: boolean) {
  const toggle = page.getByTestId("moderation-toggle");
  const checked = await toggle.isChecked();
  // The checkbox is visually hidden (opacity:0 behind a styled track), so click
  // the wrapping label rather than the input itself.
  if (checked !== on) {
    await page.getByTestId("moderation-track").click();
  }
  await expect(toggle).toBeChecked({ checked: on });
}

async function joinAndSubmit(page: Page, roomId: string, nick: string, song: string) {
  await page.goto(`/${roomId}`);
  await page.getByLabel("Seu apelido").fill(nick);
  await page.getByRole("button", { name: /entrar na fila/i }).click();
  await page.getByRole("heading", { name: /adicionar música/i }).waitFor();
  await page.getByLabel(/Buscar música/i).fill("https://youtu.be/dQw4w9WgXcQ");
  await expect(page.getByText(/Selecionada: dQw4w9WgXcQ/)).toBeVisible({ timeout: 3000 });
  await page.getByPlaceholder(/^ex\.: Evidências$/).fill(song);
  await page.getByRole("button", { name: /adicionar à fila/i }).click();
}

test.beforeEach(async ({ page }) => {
  await warmUp(page);
});

test("moderation OFF (default): submission goes straight to the queue", async ({ page }) => {
  const { id } = await createRoom(page, "Bar Sem Moderacao");
  await joinAndSubmit(page, id, "Livre", "Musica Livre");
  // Song shows up in the public live queue right away — no pending state.
  await expect(page.getByText("Musica Livre")).toBeVisible({ timeout: 6000 });
  await expect(page.getByTestId("patron-pending")).toHaveCount(0);
});

test("moderation ON: submit → pending → approve → appears in queue", async ({ page, context }) => {
  const { id, hostCode } = await createRoom(page, "Bar Com Moderacao");

  // Host turns moderation ON.
  await loginAdmin(page, id, hostCode);
  await setModeration(page, true);

  // Patron submits in a separate tab (own localStorage / uuid).
  const patron = await context.newPage();
  await joinAndSubmit(patron, id, "Espera", "Musica Pendente");
  // Patron sees the "aguardando aprovação" card and NOT a public-queue row.
  await expect(patron.getByTestId("patron-pending-waiting")).toBeVisible({ timeout: 6000 });
  await expect(patron.getByText(/aguardando aprovação/i)).toBeVisible();

  // Host sees the pending card (badge + approve/reject) and approves.
  await expect(page.getByTestId("pending-card")).toBeVisible({ timeout: 6000 });
  await expect(page.getByTestId("pending-badge")).toHaveText("1");
  await page.getByTestId("pending-approve").first().click();

  // Song is now in the real queue (admin queue rows) and the pending card clears.
  await expect(page.getByText("Musica Pendente")).toBeVisible({ timeout: 6000 });
  await expect(page.getByTestId("pending-card")).toHaveCount(0);

  // The patron's "aguardando" card clears (it left pending → entered the queue).
  await expect(patron.getByTestId("patron-pending-waiting")).toHaveCount(0, { timeout: 6000 });
  await patron.close();
});

test("moderation ON: reject → patron sees the polite rejected state", async ({ page, context }) => {
  const { id, hostCode } = await createRoom(page, "Bar Recusa");
  await loginAdmin(page, id, hostCode);
  await setModeration(page, true);

  const patron = await context.newPage();
  await joinAndSubmit(patron, id, "Recusado", "Musica Recusada");
  await expect(patron.getByTestId("patron-pending-waiting")).toBeVisible({ timeout: 6000 });

  await expect(page.getByTestId("pending-card")).toBeVisible({ timeout: 6000 });
  await page.getByTestId("pending-reject").first().click();

  // Patron's view flips to the rejected state; the song never reached the queue.
  await expect(patron.getByTestId("patron-pending-rejected")).toBeVisible({ timeout: 6000 });
  await expect(page.getByTestId("pending-card")).toHaveCount(0);
  await patron.close();
});
