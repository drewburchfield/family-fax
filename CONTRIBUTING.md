# Contributing

Family Fax is an open-source, self-hosted utility for one household. Contributions should keep the product small, private by deployment, and easy to operate.

## Development

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Use demo mode for routine development. Automated tests must never call a live provider, rent a number, send a fax, or release a number.

Before proposing a change:

```sh
npm run verify
npx playwright install chromium
npm run test:e2e
```

## Expectations

- Add tests at stable seams such as domain transitions, provider contracts, services, HTTP behavior, and user journeys.
- Keep provider-specific shapes behind `FaxProvider`.
- Preserve the rule that an ambiguous outbound mutation is never replayed automatically.
- Keep PDF assembly in the browser unless the Cloudflare CPU design changes.
- Make paid provider actions explicit and price-confirmed.
- Preserve full fax diagnostics while excluding passwords, tokens, cookies, authorization headers, and provider-content bearer tokens.
- Use synthetic examples. Never commit a real fax, medical document, email address, phone number, account ID, deployment domain, or secret.
- Update operator docs when behavior, bindings, routes, environment values, billing boundaries, or recovery procedures change.

## Provider adapters

A new adapter must implement `src/providers/fax-provider.ts` and pass the shared provider contract tests. Document mutation idempotency, webhook authentication, number billing, delivery states, raw payload retention, and ambiguous-send reconciliation.

## Reporting security problems

Follow [SECURITY.md](SECURITY.md). Never put fax content, credentials, or personal data in a public issue.
