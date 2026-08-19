import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const operation = process.argv[2];
const extraArguments = process.argv.slice(3);
const configPath = process.env.FAMILY_FAX_WRANGLER_CONFIG_PATH;
const secretsPath = process.env.FAMILY_FAX_SECRETS_FILE;

if (!configPath || !existsSync(configPath)) {
  fail("Set FAMILY_FAX_WRANGLER_CONFIG_PATH to an existing production Wrangler configuration.");
}
if (operation === "deploy" && (!secretsPath || !existsSync(secretsPath))) {
  fail("Set FAMILY_FAX_SECRETS_FILE to an existing ignored production secrets file.");
}

const wranglerEntry = "node_modules/wrangler/bin/wrangler.js";
if (!existsSync(wranglerEntry)) fail("Install dependencies before running a production command.");

const argumentsByOperation = {
  deploy: ["deploy", "--config", configPath, "--secrets-file", secretsPath, ...extraArguments],
  migrate: ["d1", "migrations", "apply", "DB", "--remote", "--config", configPath, ...extraArguments],
};
const wranglerArguments = argumentsByOperation[operation];
if (!wranglerArguments) fail("Choose the deploy or migrate production operation.");

const result = spawnSync(process.execPath, [wranglerEntry, ...wranglerArguments], {
  stdio: "inherit",
});
if (result.error) fail(result.error.message);
process.exit(result.status ?? 1);

function fail(message) {
  console.error(message);
  process.exit(1);
}
