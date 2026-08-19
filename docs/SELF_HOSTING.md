# Self-hosting Family Fax

This guide starts with the no-charge demo and then creates a private SignalWire deployment from the public source.

## Prerequisites

- Node.js 22.12 or newer
- A Cloudflare account and a domain using Cloudflare DNS
- Wrangler authenticated with `npx wrangler login`
- An R2 subscription enabled in the Cloudflare dashboard
- A SignalWire account only when moving beyond demo mode

## 1. Create the Cloudflare storage

Create D1 and R2 with names that match `wrangler.jsonc`:

```sh
npx wrangler d1 create family-fax
npx wrangler r2 bucket create family-fax-documents
```

Copy the D1 `database_id` returned by Wrangler into the `DB` binding in `wrangler.jsonc`. Bucket names are not secret. R2 buckets are private by default and must remain private for this app.

Apply the schema:

After creating an ignored deployment-specific Wrangler configuration, apply the schema with the guarded production command described in step 8.

Cloudflare's [D1 migration guide](https://developers.cloudflare.com/d1/reference/migrations/) explains how Wrangler records applied files. The [R2 bucket guide](https://developers.cloudflare.com/r2/buckets/create-buckets/) confirms that new buckets are not public by default.

## 2. Verify demo mode locally

The committed configuration uses `AUTH_MODE=dev` and `FAX_PROVIDER=demo`. Development authentication accepts only localhost URLs, so it is suitable for local verification and cannot accidentally expose a remotely deployed API.

```sh
npm ci
npm run verify
npm run dev
```

Open the displayed localhost address. Open one demo household line, send from it, receive on it, and review its lifecycle controls on Fax line. Do not deploy with `AUTH_MODE=dev`. Configure Cloudflare Access before the first remote smoke test.

## 3. Choose two hostnames

Use one private application hostname and one narrowly routed integration hostname:

```text
fax.example.com
fax-events.example.com
```

The application hostname serves the UI and private API behind Cloudflare Access. The integration hostname must route only these provider-facing paths:

```text
/webhooks/signalwire/*
/provider-content/*
```

SignalWire needs the second path to fetch the outbound PDF. It cannot pass an interactive Access login. Provider-content URLs are random, single-document, expiring tokens and are revoked when a fax reaches a terminal state.

Copy the production Wrangler template and replace the domains, zone, resource names, and D1 identifier:

```sh
cp .wrangler.production.example.jsonc .wrangler.production.jsonc
```

The copied file is ignored. Keep every deployment-specific value there.

Create a proxied DNS record for the integration hostname if the route does not create one. Do not route the integration hostname root or application assets to the Worker.

## 4. Protect the application with Cloudflare Access

In Cloudflare Zero Trust:

1. Go to Access controls, Applications.
2. Create a self-hosted public-hostname application for the private app hostname.
3. Add an Allow policy containing only the household identities that may use the app.
4. Configure an identity provider. Emailed one-time PINs are sufficient for a small family deployment if that matches your risk assessment.
5. Set a reasonable session duration and require MFA where practical.
6. Copy the application audience tag and your team domain.

Cloudflare documents this flow in [Publish a self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/). The Worker performs its own JWT signature, issuer, and audience validation after Access permits the request.

Do not put an interactive Access policy in front of the two integration routes. Their application endpoints remain inaccessible because the public integration hostname does not route `/api/*` or static assets.

You can keep `FAX_PROVIDER=demo` for the first Cloudflare smoke test, but set `AUTH_MODE=access`, `CF_ACCESS_AUD`, and `CF_ACCESS_TEAM_DOMAIN` in an ignored secrets file before deploying it. This verifies the remote storage, workflow, and Access boundary without renting a number or sending a real fax.

## 5. Enable email delivery

Family Fax uses a Cloudflare Email Service binding to send received PDFs and delivered-send confirmations. In Cloudflare, onboard the sending domain under Email Service, then add and verify the household destination address under Email Routing. The committed `EMAIL` binding can send only to verified destinations in the account. The configured `EMAIL_FROM_ADDRESS` must belong to the onboarded domain.

For a public fork, keep recipient addresses in the deployment environment. Do not commit them to `wrangler.jsonc`.

## 6. Prepare production values

Copy the production environment template:

```sh
cp .env.production.example .env.production
```

Replace every placeholder. Confirm the provider's current monthly number price, release hold, email size limits, and account state. The `--secrets-file` deployment option uploads every value as an encrypted Worker secret, including personal configuration that is not itself a credential.

`.env*` and `.dev.vars*` are ignored. The Cloudflare Vite plugin copies local development values into `dist` for `vite preview`, but [Cloudflare confirms that generated file is not deployed](https://developers.cloudflare.com/workers/vite-plugin/reference/secrets/). Keep `dist` ignored and treat local build directories as sensitive anyway.

## 7. Configure SignalWire

Complete [SignalWire setup](SIGNALWIRE_SETUP.md) before the production deploy. Verify the project ID, API token, Space URL, webhook authentication, number eligibility, email delivery, and account pricing.

## 8. Build and deploy production

The Vite plugin snapshots `wrangler.jsonc` during the build. Build after changing bindings or routes, then pass the ignored production file to Wrangler:

```sh
export FAMILY_FAX_WRANGLER_CONFIG_PATH=.wrangler.production.jsonc
export FAMILY_FAX_SECRETS_FILE=.env.production
npm run deploy
```

The secret-file values override generic demo defaults for that deployed version. Wrangler prints binding names but hides their values.

Apply new D1 migrations before deploying application code that depends on them:

```sh
export FAMILY_FAX_WRANGLER_CONFIG_PATH=.wrangler.production.jsonc
export FAMILY_FAX_SECRETS_FILE=.env.production
npm run db:migrate:remote
npm run deploy
```

Both production scripts fail closed unless the explicit Wrangler configuration exists. Deploy also requires the ignored secrets file. The committed `wrangler.jsonc` remains a demo template with a placeholder D1 identifier and cannot be used accidentally through `npm run deploy`.

## 9. Production checks

1. Open the application hostname in a private browser window and confirm Access denies an unapproved identity.
2. Sign in with an approved identity and open Diagnostics.
3. Confirm provider, D1, and R2 checks pass and that the deployment ID and timestamp are present.
4. Confirm the integration hostname root does not serve the application.
5. Confirm an unauthenticated webhook request returns 401.
6. Confirm an invalid provider-content token returns 404 and never reveals a bucket URL.
7. Confirm the read-only provider health and inventory checks first. SignalWire does not offer a fax sandbox, so the first live send requires a purchased household line and a controlled destination permitted by the account mode.
8. Confirm Send displays the configured country and `+1` prefix, and that it uses the household line without another inventory search.
9. Verify that a successful send produces one household email confirmation.
10. Verify that a received test PDF is archived and produces one household email with the document attached when it is below the configured threshold.
11. Request release from Fax line only when the household no longer needs the number. Review the provider minimum-hold date shown by the app.

Never make the R2 bucket public, never deploy `AUTH_MODE=dev` for real documents, and never expose the app host without Access.

## Free-allowance expectations

Occasional household traffic is small, but usage, plan limits, and pricing remain the operator's responsibility. Storage grows because this release retains all records and documents.

Review current [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), [Workflows](https://developers.cloudflare.com/workflows/reference/limits/), and [Email Service](https://developers.cloudflare.com/email-service/) terms before deploying. SignalWire billing is separate. An optional Sinch deployment also has its own provider bill.
