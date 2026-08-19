import { describe, expect, it } from "vitest";

describe("project entry points", () => {
  it("exports the client application", async () => {
    const client = await import("./client/App");

    expect(client.App).toBeTypeOf("function");
  });

  it("exports the Worker handler", async () => {
    const worker = await import("./worker/index");

    expect(worker.default.fetch).toBeTypeOf("function");
  });
});
