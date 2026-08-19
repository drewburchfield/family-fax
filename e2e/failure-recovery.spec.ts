import { expect, test } from "./fixtures";
import { ensureHouseholdLine, setPreferences, startSend } from "./helpers";

test.beforeEach(async ({ request }) => {
  await setPreferences(request, ["615", "629"]);
});

test("keeps an ambiguous provider result in review without replaying or buying another line", async ({
  page,
  request,
}) => {
  await ensureHouseholdLine(page);
  const before = await (await request.get("/api/bootstrap")).json() as {
    activeNumbers: Array<{ id: string }>;
  };
  const faxId = await startSend(page, "6155550001");

  await expect.poll(async () => {
    const payload = await (await request.get(`/api/faxes/${faxId}`)).json() as {
      fax: { state: string };
    };
    return payload.fax.state;
  }).toBe("status_unknown");
  const detail = await (await request.get(`/api/faxes/${faxId}`)).json() as {
    events: Array<{ type: string }>;
  };
  expect(detail.events.filter((event) => event.type === "fax.submission_intent")).toHaveLength(1);
  const after = await (await request.get("/api/bootstrap")).json() as {
    activeNumbers: Array<{ id: string }>;
  };
  expect(after.activeNumbers.map((number) => number.id).sort()).toEqual(
    before.activeNumbers.map((number) => number.id).sort(),
  );
});

test("shows provider failure without changing the retained household line", async ({ page, request }) => {
  const line = await ensureHouseholdLine(page);
  const faxId = await startSend(page, "6155550000");

  await expect.poll(async () => {
    const payload = await (await request.get(`/api/faxes/${faxId}`)).json() as {
      fax: { state: string };
    };
    return payload.fax.state;
  }).toBe("failed");

  await page.goto("/receive");
  await expect(page.getByRole("heading", { name: line.formatted })).toBeVisible();
  const bootstrap = await (await request.get("/api/bootstrap")).json() as {
    activeNumbers: Array<{ e164: string; state: string }>;
  };
  expect(bootstrap.activeNumbers).toContainEqual(
    expect.objectContaining({ e164: line.e164, state: "active" }),
  );
});
