# Sinch setup

Sinch remains available as an optional fallback for existing deployments. New Family Fax deployments use SignalWire as the primary production provider.

Family Fax uses the Sinch Numbers API to search, rent, inspect, and release numbers, and Fax API v3 to send, receive, download, and route faxes to email.

Live provider mutations are intentionally not part of automated tests. Number rental and real fax delivery may create charges.

## 1. Create the project credentials

1. Create or select a project in the Sinch Build dashboard.
2. Record the project ID.
3. Create an access key and record its key ID and secret immediately. The secret is shown only when the key is created.
4. Enable two-factor authentication on the Sinch account.

The adapter exchanges the key ID and key secret at `https://auth.sinch.com/oauth2/token`, caches the short-lived bearer token, and refreshes it once after a 401. Sinch documents this in [OAuth 2.0 authentication](https://developers.sinch.com/docs/fax/api-reference/authentication/oauth).

## 2. Create or select a Fax service

Sinch creates a default Fax service for a new project. Record the service ID and keep one service dedicated to this app if possible. The app passes that service ID when renting a number and sending a fax.

The [Sinch getting-started guide](https://developers.sinch.com/docs/fax/getting-started) describes project credentials, Fax service setup, and number assignment.

## 3. Configure incoming webhooks

Set the Fax service incoming webhook to:

```text
https://fax-events.example.com/webhooks/sinch
```

Choose JSON content if the dashboard offers a content-type option. The app also accepts Sinch's multipart form. Configure the same Basic username and password placed in `WEBHOOK_USERNAME` and `WEBHOOK_PASSWORD`. If Sinch accepts credentials only through URL user information, use:

```text
https://username:password@fax-events.example.com/webhooks/sinch
```

Use URL-safe random values. Do not reuse the Sinch API key or the Cloudflare account password.

Sinch Fax API v3 does not provide signed webhook requests. It supports Basic authentication instead. Family Fax compares that credential in constant time, durably deduplicates event identifiers, records accepted and rejected webhook timestamps, and retries archival safely if document storage fails. See Sinch's [webhook reference](https://developers.sinch.com/docs/fax/api-reference/fax/section/webhooks) and [v3 migration notes](https://developers.sinch.com/docs/fax/v2-v3migration).

Outbound completion callbacks are set per fax by the app and use the same integration hostname and Basic credential.

## 4. Confirm number and Fax eligibility

The app searches US local inventory by ordered area-code preference. Before renting, it shows Sinch's returned setup and monthly prices and requires explicit confirmation. It provisions the selected number with `voiceConfiguration.type=FAX` and the configured service ID.

Confirm in the dashboard that:

- The account can rent US local numbers.
- The desired area codes have fax-capable inventory.
- Any identity or supporting-document requirements are complete.
- The selected number shows the intended Fax service under Voice Configuration.
- The current rental unit and price are acceptable.

A number can be billed as a monthly rental even if Family Fax releases it after a few days. The app does not claim proration.

Sinch can return a rented number with scheduled voice provisioning still in progress. Family Fax waits for the selected number to report the intended Fax service, using read-only checks after the single rental request. If setup does not become ready in the workflow window, it attempts to remove any partial email route and release that exact number. Check the event timeline for `number.provisioning`, `number.provisioning_unknown`, or `number.provision_cleanup_failed` when setup takes longer than expected.

## 5. Confirm fax-to-email

For receive-only and combined modes, the app adds the active number to the configured forwarding email with receive permission. On release, it removes that association before releasing the number.

Allowlist mail from `sinchfax.com` and `sinch.com` if delivery is filtered. Sinch documents email association and TLS transport in [Fax to Email](https://developers.sinch.com/docs/fax/api-reference/fax/fax-to-email/encryption).

The app also archives the inbound PDF in private R2, so email is a delivery convenience rather than the only copy.

## 6. Use the no-charge outbound test first

Sinch documents `+19898989898` as an outbound test destination that emulates a fax without charging the account. Use a synthetic one-page document. Confirm that:

1. The UI shows the exact final PDF preview.
2. A number quote is displayed and acknowledged.
3. The workflow records one submission intent.
4. The Fax detail reaches a terminal state or a clearly visible review state.
5. The one-time sending number releases.
6. Diagnostics contain the correlation ID and provider response without credentials.

The test destination avoids a fax-page charge, but number provisioning rules or account-specific charges can still apply. Review the quote shown by the app.

Trial accounts may be limited to verified destination numbers. Follow the account's current dashboard guidance before testing a real office.

## 7. Controlled receive test

1. Choose Receive faxes with the shortest acceptable TTL.
2. Review the number rental quote and provision one number.
3. Send a harmless test page to it from an independent fax source.
4. Confirm the PDF appears in Archive and reaches the forwarding inbox.
5. Confirm the authenticated webhook timestamp in Diagnostics.
6. Release the number from the home screen.
7. Confirm the line state is Released and the fax remains downloadable.

## Ambiguous submissions

If the provider request fails without returning a fax ID, Family Fax records `status_unknown` and does not submit again. Review the Sinch dashboard, destination office, event timeline, and diagnostic bundle. Do not press through with a second send until you have determined whether the first fax exists.

## Region

`SINCH_REGION=global` uses `https://fax.api.sinch.com`. The adapter also supports a regional prefix when the account requires one. Validate the exact supported region with the current [Fax API reference](https://developers.sinch.com/docs/fax/api-reference) before changing it.
