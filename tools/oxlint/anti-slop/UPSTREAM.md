# Vendored anti-slop

- Source: https://github.com/dmmulroy/anti-slop
- Exact commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Source path: `skills/install-anti-slop/assets/anti-slop/`
- Installed path: `tools/oxlint/anti-slop/`
- Copied with that commit's `skills/install-anti-slop/scripts/install.mjs`.
- Verified with upstream `node scripts/sync-skill-assets.mjs --check`: the
  bundled assets match `src/`, excluding upstream `*.test.ts` files.
- Local additions: this record and upstream's root MIT `LICENSE`.
- Local source modifications: none. The nested `vendor/eslint-stylistic/LICENSE`
  and `vendor/eslint-stylistic/UPSTREAM.md` are preserved verbatim.

Family Fax intentionally enables a selected ruleset rather than the install
skill's full default policy. See [the project policy](../../../docs/anti-slop.md)
for enabled rules, deferred rules, limitations, and update instructions. The
Effect entry point is included in the pristine asset copy but is not registered.
