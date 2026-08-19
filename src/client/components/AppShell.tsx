import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";

import { api, type BootstrapResponse } from "../api/client";
import { ActivityPage, FaxDetailPage } from "../routes/ActivityPage";
import { ArchivePage } from "../routes/ArchivePage";
import { DiagnosticsPage } from "../routes/DiagnosticsPage";
import { FaxLinePage } from "../routes/FaxLinePage";
import { HomePage } from "../routes/HomePage";
import { ReceivePage } from "../routes/ReceivePage";
import { SendPage } from "../routes/SendPage";
import { SettingsPage } from "../routes/SettingsPage";
import { TemplatesPage } from "../routes/TemplatesPage";

interface AppContextValue {
  bootstrap: BootstrapResponse;
  refresh(): Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useFamilyFax() {
  const value = useContext(AppContext);
  if (!value) throw new Error("Family Fax context is unavailable.");
  return value;
}

export function AppShell() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const hasLoaded = useRef(false);

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    try {
      const next = await api.bootstrap();
      if (generation !== requestGeneration.current) return;
      hasLoaded.current = true;
      setBootstrap(next);
      setBootError(null);
      setRefreshError(null);
    } catch (caught) {
      if (generation !== requestGeneration.current) return;
      const message = caught instanceof Error ? caught.message : "Family Fax could not start.";
      if (hasLoaded.current) setRefreshError(message);
      else setBootError(message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (bootError) {
    return (
      <main className="boot-screen">
        <div className="signal-mark" aria-hidden="true"><i /><i /><i /></div>
        <p className="eyebrow">Private household utility</p>
        <h1>Family Fax is not reachable.</h1>
        <p role="alert">{bootError}</p>
        <button type="button" className="button button-primary" onClick={() => void load()}>Try again</button>
      </main>
    );
  }

  if (!bootstrap) {
    return (
      <main className="boot-screen" aria-busy="true">
        <div className="signal-mark transmitting" aria-hidden="true"><i /><i /><i /></div>
        <p className="eyebrow">Opening the fax line</p>
        <h1>Family Fax</h1>
      </main>
    );
  }

  return (
    <AppContext.Provider value={{ bootstrap, refresh: load }}>
      <div className="site-frame">
        <header className="site-header">
          <Link to="/" className="brand" aria-label="Family Fax home">
            <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
            <span><strong>{bootstrap.config.appName}</strong><small>Household fax line</small></span>
          </Link>
          <Navigation />
          <div className="header-status">
            <span className={`provider-dot ${bootstrap.config.isDemo ? "demo" : "live"}`} />
            {bootstrap.config.isDemo ? "Demo mode" : `${providerLabel(bootstrap.config.provider)} connected`}
          </div>
        </header>
        <main className="page-frame">
          {refreshError ? (
            <div className="warning-list" role="alert">
              <strong>The latest status could not be loaded.</strong>
              <p>{refreshError}</p>
              <button type="button" className="button button-secondary" onClick={() => void load()}>Refresh again</button>
            </div>
          ) : null}
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/send" element={<SendPage />} />
            <Route path="/receive" element={<ReceivePage />} />
            <Route path="/fax-line" element={<FaxLinePage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/activity/:id" element={<FaxDetailPage />} />
            <Route path="/archive" element={<ArchivePage />} />
            <Route path="/templates" element={<TemplatesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/diagnostics" element={<DiagnosticsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>
      </div>
    </AppContext.Provider>
  );
}

function providerLabel(provider: BootstrapResponse["config"]["provider"]): string {
  if (provider === "signalwire") return "SignalWire";
  if (provider === "sinch") return "Sinch";
  return "Demo";
}

function Navigation() {
  return (
    <nav className="bottom-nav" aria-label="Main navigation">
      <NavLink to="/" end>Home</NavLink>
      <NavLink to="/fax-line">Fax line</NavLink>
      <NavLink to="/activity">Activity</NavLink>
      <NavLink to="/archive">Archive</NavLink>
      <NavLink to="/settings">Settings</NavLink>
    </nav>
  );
}

export function PageIntro({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <header className="page-intro">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {children ? <div className="page-intro-copy">{children}</div> : null}
    </header>
  );
}

function NotFound() {
  return <PageIntro eyebrow="Not found" title="That page is off the line."><Link to="/">Return home</Link></PageIntro>;
}
