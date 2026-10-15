import { test, expect } from "@playwright/test";
import { advanceOnce } from "./helpers";

/**
 * E2E: patron submits a song → it appears in the queue list.
 *
 * Uses a known-good YouTube video ID (Rick Astley - Never Gonna Give You Up).
 * Playback is NOT tested here (requires browser audio; CI headless). We verify
 * that the API accepted the submission and the queue UI reflects it.
 */
test("patron submits a song and it appears in the queue", async ({ page }) => {
  // Clear the queue first via API to start clean (authenticated advance — TICKET-45)
  await advanceOnce(page.request).catch(() => {});

  // Navigate to the (default room) patron page — the global flow moved to
  // /[room] in TICKET-9; `/` is now the landing.
  await page.goto("/default");

  // Nickname gate — enter nickname and join
  await page.getByLabel("Seu apelido").waitFor();
  await page.getByPlaceholder(/ex\.: Maria/i).fill("TestUser");
  await page.getByRole("button", { name: /entrar na fila/i }).click();

  // Wait for the main form to appear
  await page.getByRole("heading", { name: /adicionar música/i }).waitFor();

  // Paste a YouTube URL into the dual-behavior search input (TICKET-8):
  // a pasted link is resolved locally without hitting the search API.
  await page.getByLabel(/Buscar música/i).fill("https://youtu.be/dQw4w9WgXcQ");

  // Wait for the resolved-selection confirmation
  await expect(page.getByText(/Selecionada: dQw4w9WgXcQ/)).toBeVisible({ timeout: 3000 });

  // There is no title field any more: the server names the song itself.
  await expect(page.getByPlaceholder(/^ex\.: Evidências$/)).toHaveCount(0);

  // Submit
  await page.getByRole("button", { name: /adicionar à fila/i }).click();

  // Confirmation message
  await expect(page.getByText(/música na fila/i)).toBeVisible({ timeout: 5000 });

  // The song should appear in the live queue list. No YouTube lookup answers
  // in e2e, so it carries the server's fallback label, never client text.
  const row = page.getByRole("listitem").filter({ hasText: "TestUser" }).first();
  await expect(row).toBeVisible({ timeout: 6000 });
  await expect(row).toContainText("youtu.be/dQw4w9WgXcQ");
});
