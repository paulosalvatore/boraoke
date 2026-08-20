import { test, expect, type Page } from "@playwright/test";
import { warmModerationRoutes } from "./helpers";

/**
 * E2E (TICKET-10): the host switches the venue rotation mode on the admin page
 * and the shared queue reorders itself under the new fairness policy — the
 * product's differentiator going live. Also asserts the ATIVO chip follows the
 * active mode and no entry is lost across the switch.
 *
 * Runs against `npm run dev` (memory store). Routes are warmed up first so the
 * documented per-process singleton-reset caveat (first route compile
 * re-evaluates the store/rooms modules) doesn't wipe seeded state.
 */

async function warmUp(page: Page) {
  // Compile every route + module the flow touches, once, before seeding.
  //
  // TICKET-88 — the confirmed root cause of this spec's ~1-in-3 flake. This
  // warm-up compiled the LOGIN-GATE half of `/[room]/admin` only: it logs in
  // with a deliberately bogus token ("x"), so `page.goto("/default/admin")`
  // below renders the unauthenticated gate, which never mounts the authed
  // dashboard's 3s poll of `/api/host/pending`. That route therefore stayed
  // UNCOMPILED until the test's own `goto(/<roomId>/admin)` — i.e. AFTER the
  // room was created and the queue seeded — and its first compile re-evaluated
  // the in-memory store module, wiping both.
  //
  // Measured directly (work/reports/dev/TICKET-88-report.md): seed 3 entries →
  // room record 200 / queue length 3; issue the first `GET /api/host/pending` →
  // room record 404 / queue length 0; the follow-up `POST /api/host/mode` then
  // 401s, the success toast never renders, and the spec fails. In a full-suite
  // run host-controls/moderation happen to compile that route earlier, which is
  // why the failure surfaced intermittently rather than every time — this spec
  // was relying on ANOTHER FILE's warm-up, not on its own.
  //
  // Warming the authed host-console routes here (before any seeding) is the
  // TICKET-65 pattern applied to the right routes: compile first, seed after.
  await warmModerationRoutes(page.request);
  await page.request.post("/api/rooms", { data: { name: "warmup" } });
  await page.request.post("/api/host/login?room=default", { data: { token: "x" } });
  await page.request.post("/api/host/mode?room=default", { data: { mode: "full-karaoke" } });
  await page.request.get("/api/queue?room=default");
  await page.request.post("/api/queue", { data: {} }).catch(() => {});
  await page.goto("/default/admin");
  await page.getByLabel("Código do host").waitFor();
}

async function seed(
  page: Page,
  roomId: string,
  title: string,
  table: string,
): Promise<void> {
  const res = await page.request.post("/api/queue", {
    data: {
      room: roomId,
      videoId: "dQw4w9WgXcQ",
      title,
      nickname: title,
      patronUuid: crypto.randomUUID(),
      table,
      mode: "sing",
    },
  });
  expect(res.status(), `seed ${title}`).toBe(201);
}

async function orderTitles(page: Page, roomId: string): Promise<string[]> {
  const data = await (await page.request.get(`/api/queue?room=${roomId}`)).json();
  return (data.items as { title?: string }[]).map((e) => e.title ?? "");
}

test("host switches rotation mode → the queue reorders (per-table fairness)", async ({
  page,
}) => {
  await warmUp(page);

  // Create a real room (host code returned exactly once).
  const created = await (
    await page.request.post("/api/rooms", { data: { name: "Bar do Rodízio" } })
  ).json();
  const roomId: string = created.id;
  const hostCode: string = created.hostCode;
  expect(roomId?.length).toBeGreaterThan(0);

  // Host session for THIS room (shared cookie jar with the page).
  const login = await page.request.post(`/api/host/login?room=${roomId}`, {
    data: { token: hostCode },
  });
  expect(login.status()).toBe(200);

  // Seed: two singers at table 1, one at table 2 — full-karaoke keeps arrival
  // order (distinct uuids), per-table-2 interleaves tables.
  await seed(page, roomId, "Alpha", "1"); // u1, table 1 (now-playing)
  await seed(page, roomId, "Bravo", "1"); // u2, table 1
  await seed(page, roomId, "Charlie", "2"); // u3, table 2

  // Baseline (full-karaoke): arrival order.
  await expect
    .poll(() => orderTitles(page, roomId))
    .toEqual(["Alpha", "Bravo", "Charlie"]);

  // Open the admin dashboard (authed via the shared cookie).
  await page.goto(`/${roomId}/admin`);
  await expect(page.getByText("A noite em números")).toBeVisible();

  // full-karaoke card starts ATIVO.
  const fullCard = page.getByTestId("mode-option-full-karaoke");
  await expect(fullCard.getByText("ATIVO")).toBeVisible();

  // Switch to "2 por mesa".
  await page.getByTestId("mode-option-per-table-2").click();

  // ATIVO chip moves to the new mode; the reorder toast appears.
  await expect(page.getByTestId("mode-option-per-table-2").getByText("ATIVO")).toBeVisible();
  await expect(page.getByTestId("mode-toast")).toBeVisible();

  // The queue is now round-robin by table: Alpha(t1, playing), Charlie(t2), Bravo(t1).
  await expect
    .poll(() => orderTitles(page, roomId))
    .toEqual(["Alpha", "Charlie", "Bravo"]);

  // No entry was lost across the switch.
  expect((await orderTitles(page, roomId)).sort()).toEqual(["Alpha", "Bravo", "Charlie"]);
});
