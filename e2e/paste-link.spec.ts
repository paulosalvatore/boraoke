import http from "node:http";
import { test, expect, type Page } from "@playwright/test";

/**
 * E2E for the paste-a-YouTube-link gaps (TICKET-140): gap 1 (an 11-letter
 * word searches), gap 3 (a pasted song shows its real title, in the picker
 * and in the queue) and gap 5 (a definite not-embeddable video is refused,
 * a failed check is not).
 *
 * The server's outbound YouTube calls (videos.list and oEmbed) are answered
 * by a LOCAL stub this file starts on PORT+1000. playwright.config.ts points
 * the app at it (YOUTUBE_API_ORIGIN / YOUTUBE_OEMBED_ORIGIN, loopback only,
 * honoured in this local production build because of BORAOKE_E2E_STUBS=1,
 * never on Vercel). No real key is involved: the app sends a placeholder key
 * to a stub origin, and this file asserts that. /api/search is mocked in the
 * browser like search.spec.ts.
 *
 * The fixture ids are used ONLY here, so the server's title cache can never
 * leak a stub title into another spec (submit-song.spec.ts relies on the
 * client title for dQw4w9WgXcQ, which no stub here ever answers).
 */

const STUB_PORT = Number(process.env.PORT ?? 3040) + 1000;
const TITLE_ID = "e2eTitle140"; // embeddable, has a title
const BLOCK_ID = "e2eBlock140"; // definite not-embeddable
const FAIL_ID = "e2eFails140"; // every lookup fails (5xx)

const STUB_TITLE = "Evidências (Karaokê Stub)";
const STUB_CHANNEL = "Karaokê Stub Channel";

const seenKeys: string[] = [];
let server: http.Server;

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${STUB_PORT}`);
    if (url.pathname === "/youtube/v3/videos") {
      seenKeys.push(url.searchParams.get("key") ?? "");
      const id = url.searchParams.get("id");
      if (id === TITLE_ID) {
        return send(res, 200, {
          items: [
            {
              id,
              status: { embeddable: true },
              snippet: { title: STUB_TITLE, channelTitle: STUB_CHANNEL },
              contentDetails: { duration: "PT4M5S" },
            },
          ],
        });
      }
      if (id === BLOCK_ID) {
        return send(res, 200, {
          items: [{ id, status: { embeddable: false }, snippet: { title: "Blocked", channelTitle: "X" } }],
        });
      }
      return send(res, 500, {});
    }
    if (url.pathname === "/oembed") {
      const v = new URL(url.searchParams.get("url") ?? "https://x/").searchParams.get("v");
      if (v === TITLE_ID) return send(res, 200, { title: STUB_TITLE, author_name: STUB_CHANNEL });
      if (v === BLOCK_ID) return send(res, 401, {});
      if (v === FAIL_ID) return send(res, 503, {});
      return send(res, 404, {});
    }
    send(res, 404, {});
  });
  await new Promise<void>((resolve) => server.listen(STUB_PORT, "127.0.0.1", resolve));
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function joinAs(page: Page, nick: string) {
  await page.goto("/default");
  await page.getByLabel("Seu apelido").waitFor();
  await page.getByPlaceholder(/ex\.: Maria/i).fill(nick);
  await page.getByRole("button", { name: /entrar na fila/i }).click();
  await page.getByRole("heading", { name: /adicionar música/i }).waitFor();
}

test("gap 1: typing an 11-letter word searches instead of selecting a fake video", async ({ page }) => {
  let searched = "";
  await page.route("**/api/search**", async (route) => {
    searched = new URL(route.request().url()).searchParams.get("q") ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results: [
          {
            videoId: "9bZkp7q19f0",
            title: "Imagination (Karaokê)",
            channelTitle: "Karaokê Hits",
            duration: "3:10",
            thumbnailUrl: "https://i.ytimg.com/vi/9bZkp7q19f0/mqdefault.jpg",
          },
        ],
      }),
    });
  });
  await joinAs(page, "WordUser");

  await page.getByLabel(/Buscar música/i).fill("Imagination");

  // A search result row appears; no pasted "YouTube link" row, nothing auto-selected.
  await expect(page.getByRole("button", { name: /Imagination \(Karaokê\)/ })).toBeVisible({ timeout: 8000 });
  expect(searched.toLowerCase()).toContain("imagination");
  await expect(page.getByText(/Selecionada:/)).toHaveCount(0);
  await expect(page.getByText("Link do YouTube", { exact: true })).toHaveCount(0);
});

test("gap 3: a pasted link shows its real title in the picker and in the queue", async ({ page }) => {
  await joinAs(page, "TitleUser");

  // A form the old parser did not understand (music.youtube.com, inside share text).
  await page.getByLabel(/Buscar música/i).fill(`olha esse https://music.youtube.com/watch?v=${TITLE_ID}&si=x 🔥`);
  await expect(page.getByText(new RegExp(`Selecionada: ${TITLE_ID}`))).toBeVisible({ timeout: 5000 });

  // Picker: the placeholder is replaced by the oEmbed title + channel.
  await expect(page.getByRole("button", { name: new RegExp(STUB_TITLE.replace(/[()]/g, "\\$&")) })).toBeVisible({
    timeout: 8000,
  });
  await expect(page.getByText(STUB_CHANNEL).first()).toBeVisible();

  await page.getByRole("button", { name: /adicionar à fila/i }).click();
  await expect(page.getByText(/música na fila/i)).toBeVisible({ timeout: 8000 });

  // Queue: "Title · Channel", never "youtu.be/<id>".
  await expect(page.getByText(`${STUB_TITLE} · ${STUB_CHANNEL}`).first()).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(`youtu.be/${TITLE_ID}`)).toHaveCount(0);

  const queue = await (await page.request.get("/api/queue?room=default")).json();
  const entry = (queue.items as Array<Record<string, unknown>>).find((e) => e.videoId === TITLE_ID);
  expect(entry).toMatchObject({ title: STUB_TITLE, channelTitle: STUB_CHANNEL, duration: "4:05" });

  // The stub only ever saw the placeholder key — never a real one.
  expect(seenKeys.length).toBeGreaterThan(0);
  expect(new Set(seenKeys)).toEqual(new Set(["local-stub-key"]));
});

test("gap 5: a definitely not-embeddable video is refused with friendly copy", async ({ page }) => {
  await joinAs(page, "BlockUser");
  await page.getByLabel(/Buscar música/i).fill(`https://youtu.be/${BLOCK_ID}`);
  await expect(page.getByText(new RegExp(`Selecionada: ${BLOCK_ID}`))).toBeVisible({ timeout: 5000 });

  await page.getByRole("button", { name: /adicionar à fila/i }).click();
  await expect(page.getByText(/Esse vídeo não toca no telão do bar/)).toBeVisible({ timeout: 8000 });

  const queue = await (await page.request.get("/api/queue?room=default")).json();
  expect((queue.items as Array<{ videoId: string }>).some((e) => e.videoId === BLOCK_ID)).toBe(false);
});

test("gap 5 fail-open: when every lookup fails the song is still queued, with the old label", async ({ page }) => {
  await joinAs(page, "FailUser");
  await page.getByLabel(/Buscar música/i).fill(`https://youtu.be/${FAIL_ID}`);
  await expect(page.getByText(new RegExp(`Selecionada: ${FAIL_ID}`))).toBeVisible({ timeout: 5000 });
  // The picker keeps its placeholder when the title is unknown.
  await expect(page.getByText("Link do YouTube", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /adicionar à fila/i }).click();
  await expect(page.getByText(/música na fila/i)).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(`youtu.be/${FAIL_ID}`).first()).toBeVisible({ timeout: 8000 });
});
