import { test, expect } from "@playwright/test";

/**
 * E2E (TICKET-30): the language switcher on /new.
 *  - default (no cookie) renders pt-BR
 *  - the globe pill opens a menu of NATIVE names (never flags)
 *  - picking English swaps the copy AND persists on reload (NEXT_LOCALE cookie)
 *  - picking Español swaps again
 *  - the URL never changes (rooms/pages stay path-stable)
 *
 * Each test gets a fresh context (no cookie), so the first load is the
 * Accept-Language/default path. Playwright's default Accept-Language isn't pt,
 * so the default here comes from DEFAULT_LOCALE (pt-BR) — asserted below.
 */

// Force a pt-BR Accept-Language so the first-visit (no-cookie) default is the
// source locale — otherwise Playwright Chrome sends en-US and correctly resolves
// to English (which is the Accept-Language path, exercised in its own test below).
test.use({ locale: "pt-BR" });

test.describe("language switcher", () => {
  test("switches locale, persists on reload, no URL change", async ({ page }) => {
    await page.goto("/new");

    // Default copy is pt-BR ("Criar sala" heading).
    await expect(
      page.getByRole("heading", { name: /criar sala/i }),
    ).toBeVisible();

    // Globe pill shows the active short label.
    const trigger = page.getByTestId("lang-switcher-trigger");
    await expect(trigger).toContainText("PT");

    // Open the menu → native names, no flags.
    await trigger.click();
    const menu = page.getByTestId("lang-switcher-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("Português (Brasil)");
    await expect(menu).toContainText("English");
    await expect(menu).toContainText("Español");

    const urlBefore = page.url();

    // Pick English → copy swaps to EN.
    await page.getByTestId("lang-option-en").click();
    await expect(
      page.getByRole("heading", { name: /create a room/i }),
    ).toBeVisible();
    await expect(trigger).toContainText("EN");
    // URL is unchanged (cookie-based locale, no path segment).
    expect(page.url()).toBe(urlBefore);

    // Reload → still English (NEXT_LOCALE cookie persisted).
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /create a room/i }),
    ).toBeVisible();
    await expect(page.getByTestId("lang-switcher-trigger")).toContainText("EN");

    // Switch to Español.
    await page.getByTestId("lang-switcher-trigger").click();
    await page.getByTestId("lang-option-es").click();
    await expect(
      page.getByRole("heading", { name: /crear sala/i }),
    ).toBeVisible();

    // <html lang> tracks the active locale.
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
  });

  test("cookie persists the choice across a fresh navigation", async ({
    page,
  }) => {
    await page.goto("/new");
    await page.getByTestId("lang-switcher-trigger").click();
    await page.getByTestId("lang-option-en").click();
    await expect(
      page.getByRole("heading", { name: /create a room/i }),
    ).toBeVisible();

    // Navigate away and back — the cookie keeps EN.
    await page.goto("/");
    await page.goto("/new");
    await expect(
      page.getByRole("heading", { name: /create a room/i }),
    ).toBeVisible();
  });
});

test.describe("first-visit Accept-Language detection", () => {
  test.use({ locale: "en-US" });

  test("en-US browser with no cookie resolves to English", async ({ page }) => {
    await page.goto("/new");
    await expect(
      page.getByRole("heading", { name: /create a room/i }),
    ).toBeVisible();
    await expect(page.getByTestId("lang-switcher-trigger")).toContainText("EN");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });
});

test.describe("first-visit Accept-Language detection (es)", () => {
  test.use({ locale: "es-MX" });

  test("es-MX browser with no cookie resolves to Español", async ({ page }) => {
    await page.goto("/new");
    await expect(
      page.getByRole("heading", { name: /crear sala/i }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
  });
});
