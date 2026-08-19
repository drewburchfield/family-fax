export function assertDemoBootstrap(value: unknown): asserts value is {
  config: { provider: "demo"; isDemo: true };
} {
  const config = recordValue(recordValue(value).config);
  if (config.provider !== "demo" || config.isDemo !== true) {
    throw new Error(
      `E2E safety check failed: refusing mutations for provider=${String(config.provider)} isDemo=${String(config.isDemo)}.`,
    );
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
