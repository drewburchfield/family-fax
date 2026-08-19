import { describe, expect, it } from "vitest";

import {
  D1Repository,
  mapFaxJobRow,
  mapFaxNotificationRow,
  mapTemporaryNumberRow,
} from "./d1-repository";

describe("D1 row mapping", () => {
  it("uses a NULL-safe filter for unrecoverable ambiguous submissions", async () => {
    let preparedSql = "";
    const database = {
      prepare(sql: string) {
        preparedSql = sql;
        return {
          bind() {
            return {
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await new D1Repository(database).listStuckFaxJobs("2026-08-16T12:01:00.000Z");

    expect(preparedSql).toContain("COALESCE(failure_code, '') = 'ambiguous_submission'");
  });

  it("restores structured fax fields", () => {
    const result = mapFaxJobRow({
      id: "job-1",
      mode: "send-only",
      direction: "outbound",
      state: "prepared",
      to_number: "+16155550100",
      from_number: null,
      provider_fax_id: null,
      provider_project_id: null,
      temporary_number_id: null,
      correlation_id: "correlation-1",
      final_document_id: null,
      page_count: 3,
      estimated_cost_json: '{"amount":"0.135","currency":"USD"}',
      reported_cost_json: null,
      requested_ttl_days: null,
      requested_rental_months: 2,
      cover_data_json: '{"recipient":"Clinic","sender":"Family","subject":"Records","callbackNumber":"","note":"","enabled":true}',
      failure_code: null,
      failure_message: null,
      created_at: "2026-08-16T12:00:00.000Z",
      updated_at: "2026-08-16T12:01:00.000Z",
      submitted_at: null,
      completed_at: null,
    });

    expect(result.pageCount).toBe(3);
    expect(result.estimatedCost?.amount).toBe("0.135");
    expect(result.coverData?.recipient).toBe("Clinic");
    expect(result.requestedRentalMonths).toBe(2);
  });

  it("restores temporary-number pricing", () => {
    const result = mapTemporaryNumberRow({
      id: "number-1",
      fax_job_id: "job-1",
      e164: "+16155550199",
      area_code: "615",
      provider_id: "+16155550199",
      provider_name: "signalwire",
      state: "active",
      mode: "receive-only",
      forwarding_email: "fax@example.com",
      setup_price_json: null,
      monthly_price_json: '{"amount":"1.00","currency":"USD","intervalMonths":1}',
      provisioned_at: "2026-08-16T12:00:00.000Z",
      earliest_provider_release_at: "2026-09-15T12:00:00.000Z",
      release_policy: "scheduled",
      rental_months: 2,
      next_billed_at: "2026-09-16T12:00:00.000Z",
      release_at: "2026-10-16T11:00:00.000Z",
      expires_at: "2026-08-19T12:00:00.000Z",
      release_started_at: null,
      released_at: null,
      workflow_id: "number-number-1",
      created_at: "2026-08-16T12:00:00.000Z",
      updated_at: "2026-08-16T12:00:00.000Z",
    });

    expect(result.monthlyPrice?.intervalMonths).toBe(1);
    expect(result.state).toBe("active");
    expect(result).toMatchObject({
      providerName: "signalwire",
      releasePolicy: "scheduled",
      rentalMonths: 2,
      nextBilledAt: "2026-09-16T12:00:00.000Z",
      earliestProviderReleaseAt: "2026-09-15T12:00:00.000Z",
      releaseAt: "2026-10-16T11:00:00.000Z",
    });
  });

  it("keeps legacy provider ownership unknown instead of relabeling it", () => {
    const result = mapTemporaryNumberRow({
      id: "legacy-number",
      fax_job_id: null,
      e164: "+16155550198",
      area_code: "615",
      provider_id: "+16155550198",
      provider_name: null,
      state: "active",
      mode: "receive-only",
      forwarding_email: "fax@example.com",
      setup_price_json: null,
      monthly_price_json: null,
      provisioned_at: "2026-08-01T12:00:00.000Z",
      earliest_provider_release_at: null,
      release_policy: "scheduled",
      rental_months: null,
      next_billed_at: null,
      release_at: "2026-08-19T12:00:00.000Z",
      expires_at: "2026-08-19T12:00:00.000Z",
      release_started_at: null,
      released_at: null,
      workflow_id: null,
      created_at: "2026-08-01T12:00:00.000Z",
      updated_at: "2026-08-01T12:00:00.000Z",
    });

    expect(result.providerName).toBeUndefined();
  });

  it("restores fax notifications and nullable attachment outcomes", () => {
    const row = {
      fax_job_id: "job-1",
      kind: "outbound_delivered",
      state: "delivered",
      destination_email: "family@example.com",
      attempt: 1,
      message_id: "message-1",
      attached: 1,
      last_error: null,
      created_at: "2026-08-16T12:00:00.000Z",
      updated_at: "2026-08-16T12:01:00.000Z",
      delivered_at: "2026-08-16T12:01:00.000Z",
    };

    expect([
      mapFaxNotificationRow(row),
      mapFaxNotificationRow({ ...row, attached: 0 }),
      mapFaxNotificationRow({ ...row, attached: null }),
    ]).toEqual([
      expect.objectContaining({
        faxJobId: "job-1",
        kind: "outbound_delivered",
        state: "delivered",
        destinationEmail: "family@example.com",
        attached: true,
      }),
      expect.objectContaining({ attached: false }),
      expect.objectContaining({ attached: null }),
    ]);
  });
});
