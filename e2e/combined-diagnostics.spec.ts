import { expect, test } from "./fixtures";
import { ensureHouseholdLine } from "./helpers";

test("Fax line owns billing and lifecycle controls", async ({ page }) => {
  test.setTimeout(60_000);
  await ensureHouseholdLine(page);

  await expect(page.getByRole("heading", { name: "Household fax line" })).toBeVisible();
  await expect(page.getByText(/monthly rental/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Release now" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open diagnostics" })).toBeVisible();
});

test("diagnostics reports provider, database, storage, and sweep visibility", async ({ page }) => {
  await page.goto("/diagnostics");

  await expect(page.getByText(/All core checks passed|Something needs attention/)).toBeVisible();
  await expect(page.locator("pre")).toContainText('"database"');
  await expect(page.locator("pre")).toContainText('"storage"');
  await expect(page.getByRole("button", { name: "Run checks" })).toBeVisible();
});

test("keyboard navigation works without horizontal overflow", async ({ page }) => {
  await page.goto("/");
  const send = page.getByRole("link", { name: "Send a fax" });
  await send.focus();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/send$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
