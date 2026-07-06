import { test, expect } from "@playwright/test";

/**
 * E2E: the /api/t telemetry beacon (TICKET-12).
 *  - Accepts a client-allowed anonymous event (202) against the real server.
 *  - Rejects server-observable event names (data-poisoning guard) and garbage.
 *  - Fail-open posture: the beacon never breaks the patron flow — the patron
 *    page keeps working regardless of telemetry.
 */

const UUID = "123e4567-e89b-42d3-a456-426614174000";

test("beacon accepts a client-allowed event with 202", async ({ request }) => {
  const res = await request.post("/api/t", {
    data: { event: "patron_joined", roomId: "default", uuid: UUID },
  });
  expect(res.status()).toBe(202);
  expect(await res.json()).toEqual({ ok: true });
});

test("beacon rejects server-observable and unknown events with 400", async ({
  request,
}) => {
  for (const event of ["song_queued", "host_action", "totally_made_up"]) {
    const res = await request.post("/api/t", {
      data: { event, roomId: "default" },
    });
    expect(res.status()).toBe(400);
  }
});

test("beacon rejects malformed bodies and the patron page still works", async ({
  page,
  request,
}) => {
  const res = await request.post("/api/t", {
    headers: { "content-type": "application/json" },
    data: "{not json",
  });
  expect(res.status()).toBe(400);

  // Telemetry never in the way: the patron page loads and the queue API answers.
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
  const queue = await request.get("/api/queue");
  expect(queue.ok()).toBeTruthy();
});
