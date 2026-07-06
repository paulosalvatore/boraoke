import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * E2E: host controls (TICKET-7) — login → remove → reorder → pause.
 *
 * Runs against `npm run dev` (memory store, development mode), where the host
 * auth accepts the well-known dev fallback token (HOST_TOKEN unset in dev).
 * Pause is asserted via the admin UI state + the public queue flag (the /tv
 * player-pause consumption is a coordinated follow-up landing after the TV PR).
 */
const DEV_TOKEN = "cantai-dev-host";
const VALID_UUID = "123e4567-e89b-42d3-a456-426614174000";

/**
 * Warm-compile every route BEFORE seeding. Under `next dev` with the in-memory
 * store, first-compilation of a route re-evaluates the shared store module and
 * resets the singleton — so any state seeded before an as-yet-uncompiled route
 * is hit would be wiped (the documented memory-driver caveat; production uses
 * durable Upstash). Compiling everything up front makes later seeds stable.
 */
async function warmUp(page: import("@playwright/test").Page, request: APIRequestContext) {
  await request.post("/api/host/login", { data: { token: DEV_TOKEN } });
  await request.get("/api/host/session");
  await request.post("/api/host/pause", { data: { paused: false } });
  await request.post("/api/host/skip");
  await request.post("/api/host/remove", { data: { entryId: "warmup" } });
  await request.post("/api/host/reorder", { data: { entryId: "warmup", newIndex: 0 } });
  await request.get("/api/queue");
  // Compile the /admin bundle + its client chunks once.
  await page.goto("/default/admin");
  await page.getByLabel("Código do host").waitFor();
}

async function drain(request: APIRequestContext) {
  for (let i = 0; i < 40; i++) {
    const data = await (await request.get("/api/queue")).json();
    if (!data.items?.length) break;
    await request.post("/api/queue/advance");
  }
  await request.post("/api/host/login", { data: { token: DEV_TOKEN } });
  await request.post("/api/host/pause", { data: { paused: false } });
}

async function seed(request: APIRequestContext, title: string, table?: string) {
  const res = await request.post("/api/queue", {
    data: {
      videoId: "dQw4w9WgXcQ",
      title,
      nickname: title,
      patronUuid: crypto.randomUUID?.() ?? VALID_UUID,
      table,
      mode: "sing",
    },
  });
  expect(res.status()).toBe(201);
}

test("host logs in, removes, reorders, and pauses", async ({ page, request }) => {
  await warmUp(page, request);
  await drain(request);
  await seed(request, "Alpha", "1");
  await seed(request, "Bravo", "2");
  await seed(request, "Charlie", "3");

  // ── Login gate ──────────────────────────────────────────────────────────
  await page.goto("/default/admin");
  const tokenInput = page.getByLabel("Código do host");
  await tokenInput.waitFor();
  await tokenInput.fill(DEV_TOKEN);
  await page.getByRole("button", { name: /entrar/i }).click();

  // Dashboard renders the three seeded rows.
  await expect(page.getByText("A noite em números")).toBeVisible();
  const rows = page.getByTestId("queue-row");
  await expect(rows).toHaveCount(3);
  await expect(page.getByText("Alpha", { exact: true })).toBeVisible();

  // ── Remove (with confirm) ───────────────────────────────────────────────
  await page.getByRole("button", { name: "Remover Bravo" }).click();
  await page.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByText("Bravo")).toHaveCount(0);
  await expect(rows).toHaveCount(2);

  // ── Reorder: move Charlie (last) up above Alpha ─────────────────────────
  // Remaining order is Alpha(▶), Charlie. Move Charlie up.
  await page.getByRole("button", { name: "Subir Charlie" }).click();
  await expect
    .poll(async () => {
      const data = await (await request.get("/api/queue")).json();
      return data.items.map((e: { title?: string }) => e.title);
    })
    .toEqual(["Charlie", "Alpha"]);

  // ── Pause → reflected in admin chip AND the public queue flag ────────────
  await page.getByRole("button", { name: /pausar/i }).click();
  await expect(page.getByText("Pausado")).toBeVisible();
  await expect
    .poll(async () => (await (await request.get("/api/queue")).json()).paused)
    .toBe(true);

  // Patron submits are still accepted while paused (pause gates playback only).
  await seed(request, "Delta");

  // ── Unpause ─────────────────────────────────────────────────────────────
  await page.getByRole("button", { name: /retomar/i }).click();
  await expect
    .poll(async () => (await (await request.get("/api/queue")).json()).paused)
    .toBe(false);
});

test("host API routes reject unauthenticated callers", async ({ request }) => {
  // A fresh context with no login cookie must be locked out of every host op.
  for (const path of ["/api/host/skip", "/api/host/remove", "/api/host/reorder", "/api/host/pause"]) {
    const res = await request.post(path, { data: {}, headers: { cookie: "" } });
    expect(res.status(), `${path} must 401 without a session`).toBe(401);
  }
});
