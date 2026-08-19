const baseUrl = (process.argv[2] ?? "http://127.0.0.1:5173").replace(/\/$/, "");
const mutationHeaders = {
  Origin: baseUrl,
  "Content-Type": "application/json",
  "X-Family-Fax-Request": "1",
};

interface TemporaryNumber {
  id: string;
  faxJobId: string | null;
  e164: string | null;
  state: string;
}

const bootstrap = await json<{
  config: { isDemo: boolean; preferredAreaCodes: string[]; defaultForwardEmail: string; defaultTtlDays: number };
  activeNumbers: TemporaryNumber[];
}>("/api/bootstrap");

if (!bootstrap.config.isDemo) {
  throw new Error("The seed command runs only in demo mode so it cannot create a provider charge.");
}

const fax = await json<{ id: string }>("/api/faxes", {
  method: "POST",
  headers: mutationHeaders,
  body: JSON.stringify({
    mode: "receive-only",
    toNumber: null,
    requestedTtlDays: bootstrap.config.defaultTtlDays,
    coverData: null,
  }),
});
await json(`/api/faxes/${fax.id}/prepare`, {
  method: "POST",
  headers: mutationHeaders,
  body: JSON.stringify({ finalDocumentId: null, pageCount: null }),
});
const search = await json<{ candidates: Array<Record<string, unknown>> }>("/api/numbers/search", {
  method: "POST",
  headers: mutationHeaders,
  body: JSON.stringify({ areaCodes: bootstrap.config.preferredAreaCodes }),
});
if (!search.candidates[0]) throw new Error("Demo number inventory is empty.");
const started = await json<{ number: TemporaryNumber }>(`/api/faxes/${fax.id}/start`, {
  method: "POST",
  headers: mutationHeaders,
  body: JSON.stringify({
    candidate: search.candidates[0],
    forwardingEmail: bootstrap.config.defaultForwardEmail,
    confirmed: true,
  }),
});

const active = await pollForNumber(started.number.id);
await json("/api/demo/incoming", {
  method: "POST",
  headers: mutationHeaders,
  body: JSON.stringify({ toNumber: active.e164, fromNumber: "+12025550123" }),
});

process.stdout.write(
  `Seeded demo receiving line ${active.e164} with one archived inbound fax. Release it from the home screen when finished.\n`,
);

async function pollForNumber(id: string): Promise<TemporaryNumber> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const latest = await json<{ activeNumbers: TemporaryNumber[] }>("/api/bootstrap");
    const number = latest.activeNumbers.find((item) => item.id === id);
    if (number?.state === "active" && number.e164) return number;
    if (number && ["provision_failed", "released"].includes(number.state)) {
      throw new Error(`Demo number entered ${number.state}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the demo number workflow.");
}

async function json<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json() as T;
}
