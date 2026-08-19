# SignalWire setup

Family Fax uses SignalWire for fax-capable US numbers and fax transmission. The app owns scheduling, email forwarding, archival, and observability. SignalWire owns number rental, fax delivery, and provider billing.

## 1. Create API credentials

In the SignalWire dashboard, copy the Project ID, create an API token, and note the Space hostname such as `your-space.signalwire.com`. Store the token as a Cloudflare Worker secret. Never commit it.

Production values:

```dotenv
FAX_PROVIDER=signalwire
SIGNALWIRE_PROJECT_ID=replace-with-project-id
SIGNALWIRE_API_TOKEN=replace-with-api-token
SIGNALWIRE_SPACE_URL=your-space.signalwire.com
SIGNALWIRE_ACCOUNT_MODE=trial
SIGNALWIRE_MINIMUM_NUMBER_HOLD_DAYS=30
```

Create the token with both **Numbers** and **Fax** scopes. The adapter authenticates with HTTP Basic authentication using the Project ID and API token. It sends faxes through SignalWire's Compatibility Fax API and manages numbers through the Relay REST API. Diagnostics performs read-only calls to both APIs so a missing scope is visible before a paid action.

## 2. Understand Trial Mode and live testing

SignalWire does not publish shared fake fax credentials or a fax sandbox. Provider testing requires an account, a project-scoped API token, and one purchased SignalWire number. Family Fax uses its demo provider for free end-to-end testing before that live step.

New accounts start in Trial Mode. Current SignalWire documentation lists these relevant restrictions:

- Calling traffic is limited to purchased and verified numbers. SignalWire treats fax as calling traffic.
- The account can hold one purchased phone number.
- A Trial Mode DID cannot be released for 30 days.
- Adding a payment method and at least $5 of account credit exits Trial Mode.

Family Fax uses 30 days as the Trial Mode compatibility default and 14 days as the funded-account compatibility default. Set both values to match the current provider rule for your account:

```dotenv
# Before adding the required account credit
SIGNALWIRE_ACCOUNT_MODE=trial
SIGNALWIRE_MINIMUM_NUMBER_HOLD_DAYS=30

# After SignalWire shows that Trial Mode has ended
SIGNALWIRE_ACCOUNT_MODE=funded
SIGNALWIRE_MINIMUM_NUMBER_HOLD_DAYS=14
```

`SIGNALWIRE_MINIMUM_NUMBER_HOLD_DAYS` is the authoritative application setting. Verify it against the SignalWire dashboard and current documentation before purchase. Family Fax displays the configured hold before purchase. A one-time send schedules release for the earliest permitted date. An early **Release now** request also becomes a scheduled release. Incoming routing remains active until SignalWire completes the release.

## 3. Verify current number and fax pricing

SignalWire's number search response does not include the account-specific monthly price. Check the current local-number price in your SignalWire account and set it explicitly:

```dotenv
SIGNALWIRE_LOCAL_NUMBER_MONTHLY_PRICE=0.50
```

Family Fax displays this configured amount before purchase and requires a checkbox confirmation. The app does not claim setup fees, taxes, regulatory fees, or proration. Update the value whenever provider pricing changes. SignalWire currently publishes fax usage as a per-minute charge, while the purchased number has its own monthly price in the account.

SignalWire does not accept a lease duration when purchasing a number. Family Fax purchases the number once, stores `next_billed_at`, and releases it through the provider's DELETE endpoint according to the selected policy.

## 4. Configure provider-facing URLs

Use a narrowly routed public integration hostname. Configure a random Basic-auth username and a long random password:

```dotenv
APP_BASE_URL=https://fax.example.com
WEBHOOK_BASE_URL=https://fax-events.example.com
WEBHOOK_USERNAME=replace-with-random-username
WEBHOOK_PASSWORD=replace-with-long-random-password
```

The app configures purchased numbers in fax receive mode with this cXML endpoint:

```text
POST /webhooks/signalwire/incoming
```

That endpoint returns `<Receive mediaType="application/pdf">` with an authenticated action URL. SignalWire posts the completed inbound fax to:

```text
POST /webhooks/signalwire/inbound
```

Outbound status callbacks use:

```text
POST /webhooks/signalwire/fax
```

All three routes require the configured Basic credentials. Do not put interactive Cloudflare Access in front of these routes.

## 5. Configure Cloudflare email

Onboard a domain in Cloudflare Email Service and verify the household destination address. Set a sender on that onboarded domain:

```dotenv
EMAIL_FROM_ADDRESS=fax@example.com
DEFAULT_FORWARD_EMAIL=family@example.com
MAX_EMAIL_ATTACHMENT_BYTES=18000000
```

The `EMAIL` Workers binding sends two notification types to the selected verified destination: a confirmation after SignalWire reports an outbound fax delivered, and an incoming-fax message after the PDF is archived. Messages under `MAX_EMAIL_ATTACHMENT_BYTES` include the exact outbound packet or inbound PDF. Larger faxes include an authenticated archive link. Leave room for MIME encoding overhead under Cloudflare's verified-destination message-size limit. Notification state is stored separately from fax state as `sending`, `delivered`, `failed`, or `delivery_unknown`. A durable claim prevents duplicate sends during concurrent callbacks. The fax detail page provides an explicit retry for `failed` and `delivery_unknown` notifications.

## 6. Choose the number lifecycle

The household UI offers:

- One, two, or three months, with configurable presets.
- Keep until released, which continues monthly billing until someone clicks Release now.
- Add 1 month for a scheduled line.
- Keep until released to cancel a scheduled release.
- Request release now. The app releases immediately when permitted or schedules the provider's earliest allowed date.

For scheduled lines, Family Fax plans release one hour before the applicable provider billing boundary, then moves the date forward when SignalWire's minimum hold ends later. The hourly recovery sweep retries overdue releases. Provider billing remains authoritative, so verify released numbers in the SignalWire dashboard after a failure or incident.

Rows created before provider ownership was recorded remain labeled as legacy ownership. The app blocks release and reuse of those rows after a provider switch. Release any old Sinch number through Sinch, or reconcile and backfill its provider ownership deliberately before switching production providers.

The selected household line is reused for later sends. Sending never changes its release schedule. When no eligible line exists, Send and Receive show the same household-line setup control. Fax line remains the canonical page for inventory search, purchase confirmation, renewal, diagnostics, and release.

## 7. Controlled live test

Run the no-charge demo suite first. Then use your SignalWire trial account or funded account and proceed one mutation at a time:

1. Open Diagnostics and confirm D1, R2, provider, and deployment checks pass.
2. Search the preferred area codes and compare the displayed monthly amount with the SignalWire dashboard.
3. Confirm one number purchase in the UI.
4. Confirm the country selector defaults to United States and shows `+1`, then send a small PDF with a cover sheet to a controlled destination.
5. Confirm the outbound job reaches `delivered` and the household inbox receives one delivered-send confirmation with the final packet attached when it is below the attachment threshold.
6. Receive a reply on the purchased number and confirm the PDF appears in the archive and the household inbox receives one incoming-fax message.
7. Request release only when finished with the line. If the minimum hold remains, confirm the app shows the exact scheduled date and SignalWire still owns the number. After that date, confirm both the app event and SignalWire dashboard show the number absent.

Do not repeat a purchase or send when the app reports an ambiguous provider result. Use the diagnostics bundle and SignalWire dashboard to reconcile it first.

Primary references:

- [SignalWire first fax](https://signalwire.com/docs/platform/fax)
- [SignalWire Trial Mode](https://signalwire.com/docs/platform/trial-mode)
- [SignalWire phone-number search](https://signalwire.com/docs/apis/rest/phone-numbers/search-available-phone-numbers)
- [SignalWire phone-number release](https://signalwire.com/docs/apis/rest/phone-numbers/release-phone-number)
- [SignalWire `purchased_too_recently` error](https://signalwire.com/docs/apis/error-codes#purchased-too-recently)
- [SignalWire send fax API](https://developer.signalwire.com/rest/compatibility-api/endpoints/send-fax)
- [SignalWire fax pricing](https://signalwire.com/pricing/fax)
- [Cloudflare Email Service Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [Cloudflare send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/)
