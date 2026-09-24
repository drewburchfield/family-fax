# Anti-slop lint pilot

`npm run lint` runs the existing Oxlint defaults plus four selected rules.
`npm run verify` already runs lint, and `.github/workflows/verify.yml` runs
verification on pull requests and pushes to main. No separate CI job is needed.
The project has no formatter command; existing source formatting is preserved.

## Enabled rules

| Rule | Reason |
| --- | --- |
| `anti-slop/no-chained-type-assertions` | Prevent assertions such as `value as unknown as T` from bypassing checked contracts. The initial scan found these in Worker configuration and test fixtures. |
| `anti-slop/no-widen-then-assert` | Catch known values widened to a broad type and then asserted back into a narrower contract. This protects type information without prohibiting boundary parsers. |
| `anti-slop/no-reduce-accumulator-copy` | Catch supported non-spread accumulator copies such as `Object.assign({}, acc, item)` and array `concat`/`slice`. |
| `oxc/no-accumulating-spread` | Complement the custom rule by catching repeated accumulator spreads. |

All four are errors across owned source, tests, and scripts. There are no
per-file suppressions. Vendored rules and known agent asset directories are
excluded explicitly in `.oxlintrc.json`; existing Git ignores remain in force.

The migration passes Worker bindings directly to the existing Zod schema,
uses method-level dependency contracts where test doubles previously pretended
to be entire services, and uses DOM matchers instead of element casts. It also
replaces the partial D1 double with a checked implementation whose unsupported
operations throw. Worker composition tests retain their inspection of the private
notifier dependency using TypeScript-checked bracket access.

## Intentionally deferred rules

| Rules | Reason |
| --- | --- |
| `no-known-value-widening` | The initial scan also reports the diagnostic sanitizer's `unknown` return, the captured terminal-notification error, explicit PDF result contracts, and provider status dictionaries. Choosing replacement contracts deserves a separate review of diagnostics and provider behavior. The narrower `no-widen-then-assert` rule is enabled now. |
| `no-module-mocking` | Existing Vitest module mocks isolate client API calls and context hooks. Replacing them is a separate test architecture change. |
| `no-runtime-typeof`, `no-object-parameters`, `no-unknown-parameters`, `no-unknown-returns`, `no-unknown-type-aliases`, `no-unsafe-dictionary-type` | Configuration, webhooks, persisted JSON, errors, and full diagnostic payloads use deliberate untrusted-data boundaries. Blanket restrictions would require broader schema and retention decisions. |
| `no-shape-in-symbol-names` | A symbol naming preference offers little value to this pilot. |
| `no-array-filter-map` | Pipeline rewrites need callback-order, sparse-array, and runtime-support review; they are outside the selected type and accumulator checks. |
| `no-conditional-empty-object-spread` | Optional provider/configuration fields rely on omission semantics. A rewrite must preserve the distinction between absent keys and `undefined`. |
| `no-reflect-apply`, `no-reflect-get` | Reflect policy is outside this pilot; current source has no demonstrated need for these additional bans. |
| `require-readable-spacing`, `require-safety-comment-for-type-assertion` | These would introduce a separate formatting/comment policy and broad source churn. Single assertions still need normal code review. |
| All Effect rules | Family Fax has no direct Effect dependency. |

## Provenance and updates

The complete runtime asset bundle is committed at `tools/oxlint/anti-slop/`.
[UPSTREAM.md](../tools/oxlint/anti-slop/UPSTREAM.md) records its exact commit and
source paths. Both upstream's MIT license and the nested ESLint Stylistic
license/provenance are retained. No shared or global skills are installed.

Oxlint and `@oxlint/plugins` are pinned together at **1.78.0**. Keep their exact
versions matched when upgrading. To update vendored rules, fetch the desired
upstream revision separately, compare it with the recorded pristine source,
review any local changes, and update this provenance. Do not overwrite local
policy or automatically enable newly added rules. Run `npm ci`, `npm run verify`,
and `npm run test:e2e` after an update, and check representative invalid and valid
snippets against the installed plugin.

These rules use syntax and scope analysis, not TypeScript's full type checker.
Accumulator checks do not cover all indirect helpers, named reducer callbacks,
or nested accumulator properties. Type checks, tests, and review remain necessary.
