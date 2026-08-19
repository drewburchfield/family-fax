# Security policy

## Supported version

Security fixes target the current default branch. The project has not had an independent security audit.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/drewburchfield/family-fax/security/advisories/new). Do not open a public issue containing a vulnerability, fax content, medical information, credentials, account identifiers, or deployment details. Use synthetic values and the minimum reproduction data.

## Security boundaries

- Protect the interactive hostname with Cloudflare Access in production.
- Route only `/webhooks/*` and `/provider-content/*` on the public integration hostname.
- Require separate Basic credentials on provider webhooks.
- Use random, scoped, expiring bearer tokens for provider document access.
- Validate Cloudflare Access assertions on private API routes.
- Require same-origin requests plus `X-Family-Fax-Request: 1` for state changes.
- Keep R2 private. Disable `r2.dev` and public bucket domains.
- Store secrets in encrypted Cloudflare secrets or ignored local environment files.
- Retain fax data unredacted only within the private deployment boundary. The audit service removes credential-bearing keys and URL user information before durable diagnostic storage.

See [Privacy and compliance](docs/PRIVACY_AND_COMPLIANCE.md) for the operational data model and compliance caveats.
