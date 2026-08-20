import { test, expect, type Page } from "@playwright/test";

async function warmUp(page: Page) {
  await page.request.post("/api/rooms", { data: { name: "warmup" } });
  await page.request.post("/api/host/login?room=default", { data: { token: "x" } });
  await page.request.post("/api/host/mode?room=default", { data: { mode: "full-karaoke" } });
  await page.request.get("/api/queue?room=default");
  await page.request.post("/api/queue", { data: {} }).catch(() => {});
  await page.goto("/default/admin");
  await page.getByLabel("Código do host").waitFor();
}

test("probe: which uncompiled route wipes the store", async ({ page }) => {
  await warmUp(page);
  const created = await (await page.request.post("/api/rooms", { data: { name: "Probe" } })).json();
  const roomId = created.id, hostCode = created.hostCode;
  await page.request.post(`/api/host/login?room=${roomId}`, { data: { token: hostCode } });
  for (const t of ["Alpha", "Bravo", "Charlie"]) {
    const r = await page.request.post("/api/queue", { data: { room: roomId, videoId: "dQw4w9WgXcQ", title: t, nickname: t, patronUuid: crypto.randomUUID(), table: "1", mode: "sing" } });
    console.log("PROBE seed", t, r.status());
  }
  const q = async (label: string) => {
    const room = await page.request.get(`/api/rooms?id=${roomId}`);
    const data = await (await page.request.get(`/api/queue?room=${roomId}`)).json();
    console.log(`PROBE ${label}: roomRecord=${room.status()} queueLen=${(data.items ?? []).length}`);
  };
  await q("after-seed");
  console.log("PROBE /api/host/session ->", (await page.request.get(`/api/host/session?room=${roomId}`)).status());
  await q("after-host-session");
  console.log("PROBE /api/host/pending ->", (await page.request.get(`/api/host/pending?room=${roomId}`)).status());
  await q("after-host-pending");
  console.log("PROBE /api/host/mode ->", (await page.request.post(`/api/host/mode?room=${roomId}`, { data: { mode: "per-table-2" } })).status());
  await q("after-mode");
  expect(true).toBe(true);
});
