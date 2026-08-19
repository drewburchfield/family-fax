import { expect, test } from "./fixtures";
import {
  completedFaxId,
  ensureHouseholdLine,
  mutationHeaders,
  prepareSend,
  setPreferences,
  startSend,
} from "./helpers";

test.describe("Family Fax household journeys", () => {
  test.beforeEach(async ({ request }) => {
    await setPreferences(request, ["615", "629"]);
  });

  test("home makes the two household tasks and fax line obvious", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("link", { name: "Send a fax" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Receive a fax" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Fax line", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Send and receive" })).toHaveCount(0);
    await expect(page.getByText("Demo mode")).toBeVisible();
  });

  test("opens one retained line and shows it on Receive", async ({ page }) => {
    const line = await ensureHouseholdLine(page);

    await page.goto("/receive");
    await expect(page.getByRole("heading", { name: line.formatted })).toBeVisible();
    await expect(page.getByText("fax@example.com")).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy fax number" })).toBeVisible();
  });

  test("keeps a prepared packet while opening the first household line", async ({ page, request }) => {
    const bootstrap = await (await request.get("/api/bootstrap")).json() as {
      activeNumbers: Array<{ id: string }>;
    };
    for (const number of bootstrap.activeNumbers) {
      const released = await request.post(`/api/numbers/${number.id}/release`, {
        headers: { ...mutationHeaders, "Content-Type": "application/json" },
        data: { confirmed: true },
      });
      expect(released.ok()).toBe(true);
    }

    await prepareSend(page, "6155550123");
    await expect(page.getByRole("button", { name: "Search preferred area codes" })).toBeVisible();
    await page.getByRole("button", { name: "Search preferred area codes" }).click();
    await page.locator(".candidate-card").first().click();
    await page.getByRole("checkbox", { name: /understand this can create a charge/i }).check();
    await page.getByRole("button", { name: "Confirm and open line" }).click();

    await completedFaxId(page);
  });

  test("defaults to +1, sends from the retained line, and confirms delivery once", async ({ page, request }) => {
    test.setTimeout(60_000);
    await ensureHouseholdLine(page);
    const faxId = await startSend(page, "6155550123");

    await expect.poll(async () => {
      const detail = await (await request.get(`/api/faxes/${faxId}`)).json() as {
        fax: { state: string };
        notifications: Array<{ state: string; kind: string }>;
      };
      return {
        state: detail.fax.state,
        notifications: detail.notifications.filter((item) => item.kind === "outbound_delivered").length,
        emailState: detail.notifications[0]?.state,
      };
    }).toEqual({ state: "delivered", notifications: 1, emailState: "delivered" });

    const detail = await (await request.get(`/api/faxes/${faxId}`)).json() as {
      events: Array<{ type: string }>;
    };
    expect(detail.events.filter((event) => event.type === "fax.submission_intent")).toHaveLength(1);
    expect(detail.events.filter((event) => event.type === "fax.email_delivered")).toHaveLength(1);
  });

  test("receives on the same line, archives the PDF, and confirms email once", async ({ page, request }) => {
    const line = await ensureHouseholdLine(page);
    const response = await request.post("/api/demo/incoming", {
      headers: { ...mutationHeaders, "Content-Type": "application/json" },
      data: { toNumber: line.e164, fromNumber: "+12025550123" },
    });
    expect(response.ok()).toBe(true);
    const { faxJobId } = await response.json() as { faxJobId: string };

    await expect.poll(async () => {
      const detail = await (await request.get(`/api/faxes/${faxJobId}`)).json() as {
        fax: { state: string };
        documents: Array<{ kind: string }>;
        notifications: Array<{ state: string; kind: string }>;
      };
      return {
        state: detail.fax.state,
        inboundDocuments: detail.documents.filter((item) => item.kind === "inbound").length,
        email: detail.notifications.find((item) => item.kind === "inbound_received")?.state,
      };
    }).toEqual({ state: "delivered", inboundDocuments: 1, email: "delivered" });

    await page.goto("/receive");
    await expect(page.locator(".inbound-fax-list").getByText("+1 (202) 555-0123", { exact: true }).first()).toBeVisible();
  });

  test("keeps a delivered fax truthful when email fails, then retries explicitly", async ({ page, request }) => {
    test.setTimeout(60_000);
    await ensureHouseholdLine(page);
    const faxId = await startSend(page, "6155550002");

    await expect.poll(async () => {
      const detail = await (await request.get(`/api/faxes/${faxId}`)).json() as {
        fax: { state: string };
        notifications: Array<{ state: string; attempt: number }>;
      };
      return { fax: detail.fax.state, email: detail.notifications[0]?.state };
    }).toEqual({ fax: "delivered", email: "failed" });

    const terminalAttempts = await Promise.all([
      request.post(`/api/demo/faxes/${faxId}/terminal`, { headers: mutationHeaders }),
      request.post(`/api/demo/faxes/${faxId}/terminal`, { headers: mutationHeaders }),
    ]);
    expect(terminalAttempts.every((response) => response.ok())).toBe(true);

    await page.goto(`/activity/${faxId}`);
    await expect(page.getByText("Email confirmation failed.")).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Retry email delivery" }).click();

    await expect.poll(async () => {
      const detail = await (await request.get(`/api/faxes/${faxId}`)).json() as {
        notifications: Array<{ state: string; attempt: number }>;
        events: Array<{ type: string }>;
      };
      return {
        state: detail.notifications[0]?.state,
        attempt: detail.notifications[0]?.attempt,
        deliveredEvents: detail.events.filter((event) => event.type === "fax.email_delivered").length,
      };
    }).toEqual({ state: "delivered", attempt: 2, deliveredEvents: 1 });
  });

  test("rejects a file whose type does not match supported fax formats", async ({ page }) => {
    await page.goto("/send");
    await page.getByLabel("Add PDF or photos").setInputFiles({
      name: "notes.pdf",
      mimeType: "text/plain",
      buffer: Buffer.from("not a PDF"),
    });

    await expect(page.getByRole("alert")).toContainText("PDF, JPEG, or PNG");
  });
});
