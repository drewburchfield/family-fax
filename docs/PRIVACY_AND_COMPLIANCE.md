# Privacy and compliance

Family Fax can handle sensitive documents. Deploying this source does not make the operator, Cloudflare account, SignalWire account, email system, backup process, or household workflow compliant with HIPAA or any other legal requirement. This document is operational guidance, not legal advice.

## Data retained by the app

The default deployment retains:

- Original uploads and the exact final outbound PDF
- Inbound fax PDFs
- Full source and destination fax numbers
- Forwarding email addresses
- Cover-sheet fields and document names
- Provider fax, project, and number identifiers
- Provider prices, responses, webhooks, errors, and timing
- Correlation IDs and state-transition history
- Application settings and cover templates

D1 holds structured metadata and events. Private R2 holds documents and larger raw provider artifacts. The tested retention mode is `forever`.

## Credentials excluded from durable diagnostics

Fax data is intentionally unredacted in a private deployment. The audit scrubber removes authorization values, cookies, passwords, secrets, tokens, API and access keys, private keys, URL user information, and provider-content bearer tokens.

Store Cloudflare, SignalWire, optional Sinch, and webhook credentials as encrypted Worker secrets. Keep them out of Wrangler `vars`, D1, R2, documents, browser configuration, logs, screenshots, and support messages.

## Access controls

- Protect the app hostname with a deny-by-default Cloudflare Access application.
- Allow only named household identities.
- Enable MFA where practical and keep sessions reasonably short.
- Keep the provider integration hostname limited to `/webhooks/*` and `/provider-content/*`.
- Keep R2 private and disable public bucket URLs.
- Use unique Basic credentials for provider webhooks.
- Rotate Cloudflare, SignalWire, optional Sinch, and webhook credentials after suspected exposure.

## Email delivery

The production path archives an inbound PDF in R2, then sends it through the Cloudflare Email Service binding to the configured mailbox. Assess that mailbox's account security, forwarding rules, retention, mobile devices, backups, and organizational agreements. SMTP delivery is not end-to-end encryption.

The fax detail page shows unconfirmed email delivery and provides an explicit retry. A retry can create a duplicate if the previous email was accepted while its final audit write failed. The R2 copy remains the app's retained source.

## Medical and regulated documents

Confirm current contracts and account eligibility with every processor before using protected health information. This includes Cloudflare, SignalWire, the receiving email provider, backups, and any optional Sinch deployment. The operator remains responsible for minimum-necessary access, retention, audit review, incident response, endpoint security, and legal analysis.

Provider media retention can change and must not be treated as the household archive. Verify current SignalWire storage behavior and account settings. Family Fax keeps its own R2 copy after a successful inbound archive.

## Backups and deletion

Backups contain the same sensitive data as production. Encrypt them, limit access, record locations, and test restoration with synthetic documents.

Automatic timed deletion is not implemented. `DEFAULT_RETENTION=forever` is the only supported policy. A required deletion workflow must cover D1, R2, backups, SignalWire, email, and an optional Sinch account.

## Before using real medical documents

1. Complete the provider, Cloudflare, and email account agreements appropriate to the use case.
2. Protect the app with Access and test denial for an unapproved identity.
3. Confirm the integration hostname exposes only provider paths.
4. Verify R2 has no public access.
5. Verify the receiving email account and devices.
6. Complete a synthetic send, receive, email, retry, and release test.
7. Confirm audit, backup, and incident-response procedures.
8. Decide whether indefinite retention is appropriate.
