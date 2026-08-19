import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

const origin = "http://127.0.0.1:5173";
export const mutationHeaders = { Origin: origin, "X-Family-Fax-Request": "1" };

export async function setPreferences(
  request: APIRequestContext,
  preferredAreaCodes: string[],
): Promise<void> {
  const response = await request.put("/api/settings", {
    headers: { ...mutationHeaders, "Content-Type": "application/json" },
    data: {
      defaultForwardEmail: "fax@example.com",
      preferredAreaCodes,
      defaultTtlDays: 3,
      defaultRentalMonths: 1,
      householdLineId: null,
    },
  });
  expect(response.ok()).toBe(true);
}

export async function ensureHouseholdLine(page: Page): Promise<{ e164: string; formatted: string }> {
  await page.goto("/fax-line");
  const existing = page.locator(".active-number").first();
  const search = page.getByRole("button", { name: "Search preferred area codes" });
  await expect(existing.or(search)).toBeVisible({ timeout: 20_000 });
  if (await existing.isVisible()) {
    await expect(existing).toHaveText(/^\+1 \(\d{3}\) \d{3}-\d{4}$/, { timeout: 45_000 });
    const formatted = (await existing.textContent())!.trim();
    return { e164: `+${formatted.replace(/\D/g, "")}`, formatted };
  }
  await search.click();
  await page.locator(".candidate-card").first().click();
  await page.getByRole("checkbox", { name: /understand this can create a charge/i }).check();
  await page.getByRole("button", { name: "Confirm and open line" }).click();
  const completedNumber = page.locator(".active-number").first();
  await expect(completedNumber).toBeVisible({ timeout: 45_000 });
  await expect(completedNumber).toHaveText(/^\+1 \(\d{3}\) \d{3}-\d{4}$/, { timeout: 45_000 });
  const formatted = (await completedNumber.textContent())!.trim();
  return { e164: `+${formatted.replace(/\D/g, "")}`, formatted };
}

export async function startSend(page: Page, destination: string): Promise<string> {
  await prepareSend(page, destination);
  await page.getByRole("button", { name: "Send fax" }).click();
  return completedFaxId(page);
}

export async function prepareSend(page: Page, destination: string): Promise<void> {
  await page.goto("/send");
  await expect(page.getByLabel("Country")).toHaveValue("US");
  await expect(page.locator(".phone-country-code")).toHaveText("+1");
  await page.getByLabel("Fax number").fill(destination);
  await page.getByLabel("Add PDF or photos").setInputFiles({
    name: "allergy-records.pdf",
    mimeType: "application/pdf",
    buffer: await samplePdf(),
  });
  await page.getByRole("button", { name: "Prepare and preview" }).click();
  await expect(page.getByRole("heading", { name: "Send from the household line" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTitle("Final fax packet preview")).toBeVisible();
  await expect(page.getByLabel("Fax number")).toBeDisabled();
  await expect(page.getByLabel("Country")).toBeDisabled();
}

export async function completedFaxId(page: Page): Promise<string> {
  await expect(page.getByRole("heading", { name: "The fax is on its way." })).toBeVisible({ timeout: 15_000 });
  const href = await page.getByRole("link", { name: "Follow transmission" }).getAttribute("href");
  expect(href).toMatch(/^\/activity\//);
  return href!.split("/").at(-1)!;
}

async function samplePdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  page.drawText("Allergy records request", { x: 72, y: 700, size: 20, font });
  return Buffer.from(await document.save());
}
