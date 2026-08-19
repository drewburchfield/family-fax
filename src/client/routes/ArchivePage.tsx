import { useEffect, useState } from "react";

import type { FaxJob } from "../../shared/contracts";
import { api } from "../api/client";
import { PageIntro } from "../components/AppShell";
import { FaxTable } from "./ActivityPage";
import { ErrorNotice } from "./SendPage";

export function ArchivePage() {
  const [search, setSearch] = useState("");
  const [faxes, setFaxes] = useState<FaxJob[]>([]);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setFaxes([]);
    setError(null);
    const timer = window.setTimeout(() => {
      void api.listFaxes(search, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setFaxes(result.faxes);
        })
        .catch((caught) => {
          if (!controller.signal.aborted) setError(caught instanceof Error ? caught : new Error("The archive could not be loaded."));
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [search]);
  return (
    <>
      <PageIntro eyebrow="Retained privately" title="Fax archive"><p>Search complete numbers, provider IDs, or internal transmission IDs.</p></PageIntro>
      {error ? <ErrorNotice error={error} /> : null}
      <label className="archive-search">Search the archive<input type="search" placeholder="Phone number or ID" value={search} onChange={(event) => setSearch(event.currentTarget.value)} /></label>
      <FaxTable faxes={faxes} />
    </>
  );
}
