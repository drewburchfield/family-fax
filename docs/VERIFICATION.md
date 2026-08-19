# Verification

Family Fax separates free automated verification from account-specific live verification.

## Automated release gate

Run from a clean checkout:

```sh
npm ci
npm run verify
npx playwright install chromium
npm run test:e2e
npm audit
```

`npm run verify` runs Oxlint, browser and Worker type checks, Vitest, production builds, and a Wrangler dry run against the public production template. The Playwright suite uses a dedicated demo-only Wrangler file and fresh local Cloudflare state. A safety preflight aborts the run unless the app reports `provider=demo` and `isDemo=true`.

The automated gate covers:

- Desktop and mobile household-line setup and reuse
- The default country selector and visible `+1` prefix
- Cover-sheet editing, document conversion, PDF merge, preview, and digest checks
- Successful, failed, and ambiguous outbound fax states
- Incoming fax archival and private document access
- One durable email notification per received or delivered fax
- Notification failure, unknown delivery, and explicit retry
- Number purchase confirmation, scheduled release, provider holds, renewal, and manual release
- Interrupted provisioning, fax polling, release recovery, and hourly reconciliation
- SignalWire and Sinch request, response, callback, and provider-contract boundaries
- Cloudflare Access validation, same-origin mutations, webhook authentication, and expiring provider-content tokens
- Secret-free diagnostics, provider artifacts, correlation IDs, and deployment metadata

The CI workflow runs the same commands for every pull request and every push to `main`.

## Live provider boundary

SignalWire does not provide shared fake fax credentials or a fax sandbox. Live validation uses the operator's account and can create number and fax charges. Complete it with synthetic documents after the automated gate passes.

The controlled smoke test in [SignalWire setup](SIGNALWIRE_SETUP.md) verifies:

1. Provider credentials and current number inventory
2. One confirmed number purchase
3. One outbound fax and its terminal callback
4. One delivered-send email confirmation
5. One inbound reply, R2 archive, and email attachment
6. One release request and final provider-state reconciliation

Record the application correlation IDs and provider IDs in a private operator log. Keep account identifiers, numbers, addresses, fax documents, and diagnostic bundles out of public issues and pull requests.

## Deployment verification

Before deploying, copy the public templates to ignored files and replace every placeholder:

```sh
cp .env.production.example .env.production
cp .wrangler.production.example.jsonc .wrangler.production.jsonc
```

The guarded production scripts require explicit file paths:

```sh
export FAMILY_FAX_WRANGLER_CONFIG_PATH=.wrangler.production.jsonc
export FAMILY_FAX_SECRETS_FILE=.env.production
npm run db:migrate:remote
npm run deploy
```

After deployment, verify Cloudflare Access denial and approval, Diagnostics health, integration-route isolation, webhook rejection and acceptance, private R2 access, email delivery, and the current provider release hold.
