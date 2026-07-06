import { test, expect } from "@playwright/test";

/**
 * E2E: the feedback widget (TICKET-11).
 *  - The floating button rides patron pages, but NEVER /tv (spec AC7).
 *  - A patron can submit sentiment-only feedback in 2 taps (open + tap a face)
 *    and see the confirmation promise.
 */

test("feedback button is present on the patron page and submits in 2 taps", async ({ page }) => {
  await page.goto("/default");

  // The app mints a device uuid on boot; the widget reads it at send time.
  const fab = page.getByRole("button", { name: /enviar feedback/i });
  await expect(fab).toBeVisible();

  // Tap 1: open the sheet.
  await fab.click();
  await expect(page.getByRole("dialog", { name: /enviar feedback/i })).toBeVisible();

  // Tap 2: a sentiment face — this IS the submit action.
  await page.getByRole("button", { name: "Amei" }).click();

  // Confirmation with the promise copy.
  await expect(page.getByText(/Valeu!/i)).toBeVisible({ timeout: 5000 });
  await expect(page.getByText(/robô supervisionado por humanos/i)).toBeVisible();
});

test("feedback button does NOT render on /tv", async ({ page }) => {
  await page.goto("/default/tv");
  // Give the client component a beat to mount.
  await page.waitForTimeout(500);
  await expect(page.getByRole("button", { name: /enviar feedback/i })).toHaveCount(0);
});
