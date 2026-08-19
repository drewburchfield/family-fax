# Operations

Family Fax is designed to make the normal household flow obvious and the abnormal provider flow diagnosable without direct database editing.

## Routine checks

Open Diagnostics after deployment changes or before a time-sensitive fax. It reports:

- Provider credential and service reachability
- D1 and R2 binding health
- Active and failed-release number counts
- Last provider webhook and last accepted or rejected webhook authentication
- Last hourly safety sweep
- Application version, Worker deployment ID, tag, and timestamp

The authenticated JSON endpoint is `/api/health`. The same data is rendered at `/diagnostics`. A per-fax bundle is available from each Fax detail page and includes the job, documents, complete event timeline, raw provider artifacts, and a secret-free configuration summary.

## Logs and durable history

`wrangler.jsonc` enables Workers observability at full sampling. Stream current platform logs with:

```sh
npx wrangler tail family-fax
```

Cloudflare log retention is short on the free plan. D1 event rows and R2 diagnostic payloads are the permanent record.

Full logging means fax numbers, forwarding email, provider IDs, document metadata, state changes, and provider payloads can be retained. It does not mean credentials. The audit boundary removes authorization, cookies, passwords, secrets, tokens, API keys, URL user information, and provider-content bearer tokens.

Use the `X-Correlation-ID` response header or the Fax detail page to connect an HTTP error, workflow, provider result, webhook, and scheduled recovery.

## Number states

The Fax line page owns number lifecycle controls. An `active` household line with a scheduled release can add one month, switch to manual release, or request an earlier release. The app enforces `SIGNALWIRE_MINIMUM_NUMBER_HOLD_DAYS`, which the operator must keep aligned with the provider account. An early request moves the number to `expiring`, records `number.release_deferred`, and shows the first permitted release date. Receiving continues until the provider completes release. Manually retained numbers continue monthly billing until release succeeds. `release_failed` lines show a Retry release button after a reload. Provider responses that say the number is already absent count as success.

SignalWire may acknowledge a rental before its fax configuration is ready. Family Fax records the selected candidate before the paid mutation, rents it exactly once, and reconciles that same number for about 19 minutes. The UI keeps showing `requested` during that window. It does not rent a replacement automatically.

If readiness never completes, the workflow removes any partial email route and releases the selected number. A successful cleanup becomes `provision_failed`. When SignalWire's minimum hold remains, the number becomes `release_failed` with a future release date and a `number.provision_cleanup_deferred` event. The hourly sweep waits for that date. Other release failures remain visible for operator recovery.

If release continues to fail:

1. Download the fax diagnostic bundle.
2. Check Diagnostics and `wrangler tail`.
3. Verify SignalWire credentials and Fax service health.
4. Check whether the minimum hold date is still in the future. Wait for the scheduled sweep when it is.
5. Retry release from Fax line when the hold has ended.
6. If SignalWire still owns the number, release it in the SignalWire dashboard.
7. Keep the failed application record for diagnosis. The next hourly sweep will try overdue records again.

The hourly Cron runs at minute 0. It finds overdue numbers, interrupted releases, fax jobs stuck for at least 15 minutes, and stale notification claims, then attempts safe release, status reconciliation, or delivery-state recovery. The outcome is recorded as `lifecycle.safety_sweep`.

## Fax states

- `delivered`: SignalWire reported completion and the final packet token was revoked.
- `failed`: The provider returned a terminal failure. Read its error code and message on Fax detail.
- `status_unknown`: The outbound provider mutation did not return a reliable result. The app intentionally does not replay it.
- `submitted` or `sending`: Webhook delivery is preferred and the workflow polls as a fallback.

For `status_unknown`, check the SignalWire dashboard and the recipient before deciding on any new fax. A second fax is a human decision because automatic retry could deliver a duplicate medical or legal document.

## Webhook problems

An invalid Basic credential returns 401 and updates `lastRejectedWebhook`. A valid event updates `lastAuthenticatedWebhook`. Duplicate event keys are accepted without duplicating jobs or documents.

If no incoming fax appears:

1. Confirm the SignalWire number points to `/webhooks/signalwire/incoming` on the integration hostname, not the Access-protected app hostname.
2. Confirm only `/webhooks/*` and `/provider-content/*` are routed on that integration hostname.
3. Confirm the Basic values match the encrypted Worker secrets.
4. Check rejected and accepted timestamps in Diagnostics.
5. Check SignalWire's event and fax record.
6. Download the provider PDF from SignalWire before its retention expires if the app never archived it.

If inbound R2 storage fails after the event is claimed, the app releases the durable webhook claim. A provider retry can resume the same internal fax and document without creating a duplicate archive.

Email confirmation has its own durable state and never changes the fax result. Both `inbound_received` and `outbound_delivered` notifications use one composite claim per fax and kind. A provider callback, workflow poll, or hourly reconciliation can converge on the same claim without sending the same confirmation twice. `failed` means the email adapter reported failure. `delivery_unknown` means a send started but durable acceptance could not be confirmed, so the provider may or may not have accepted it. Open Fax detail to inspect the notification and retry either state deliberately. A retry from `delivery_unknown` can produce a duplicate because the first delivery may have succeeded.

Provider ownership is stored with every new number. Legacy rows with unknown ownership are blocked from release and reuse. Release them in the original provider dashboard or reconcile their ownership before changing the database record.

## Document problems

The browser accepts PDF, JPEG, and PNG. It creates the canonical final PDF and verifies page count and SHA-256 before a paid action. The Worker checks MIME type, size, page count, and file signature while streaming to R2.

If a PDF is encrypted, malformed, or has unflattened form fields, flatten it with Print to PDF and upload the result.

## Backups

The default retention is indefinite, so backups should cover both D1 metadata and R2 objects.

Export D1 to a private local directory:

```sh
mkdir -p private-backups
npx wrangler d1 export family-fax --remote --output private-backups/family-fax.sql
```

For R2, use an S3-compatible backup tool such as rclone with a scoped R2 API token. Preserve object keys and custom metadata. Encrypt backup media, restrict access, and test restoration with synthetic data.

A D1 export without R2 is not a complete fax archive. An R2 copy without D1 loses ownership, search, digest, and timeline metadata.

## Retention and deletion

The supported `DEFAULT_RETENTION` value is `forever`. The app has no scheduled deletion job.

Manual deletion must include the D1 fax, event, token, document, and number records plus the related R2 objects. No supported UI or script performs that destructive operation in this release. Back up first and document what was removed.

## Usage and free limits

Review usage in the Cloudflare dashboards for Workers, Workflows, D1, and R2. A few household faxes should be tiny relative to included allowances, but indefinite storage grows. Free-plan limit exhaustion can interrupt API, database, or workflow operations rather than silently billing.

Verify current account limits from the provider links in the README.

## Updating

Before an update:

```sh
npm ci
npm run verify
npm run test:e2e
npx wrangler d1 migrations list DB --remote
```

Apply migrations before code that requires them, build after Wrangler changes, and deploy with the ignored production secret file. After deploy, verify the deployment metadata and one complete demo or no-charge provider journey.
