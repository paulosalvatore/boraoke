import { test, expect } from "@playwright/test";

/**
 * E2E: patron submits a song → it appears in the queue list.
 *
 * Uses a known-good YouTube video ID (Rick Astley - Never Gonna Give You Up).
 * Playback is NOT tested here (requires browser audio; CI headless). We verify
 * that the API accepted the submission and the queue UI reflects it.
 */
test("patron submits a song and it appears in the queue", async ({ page }) => {
  // Clear the queue first via API to start clean
  await page.request.post("/api/queue/advance").catch(() => {});

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

  // Optionally add a title
  await page.getByPlaceholder(/^ex\.: Evidências$/).fill("Rick Roll");

  // Submit
  await page.getByRole("button", { name: /adicionar à fila/i }).click();

  // Confirmation message
  await expect(page.getByText(/música na fila/i)).toBeVisible({ timeout: 5000 });

  // The song should appear in the live queue list
  await expect(page.getByText("Rick Roll")).toBeVisible({ timeout: 6000 });
});
