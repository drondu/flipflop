import React, { useEffect, useState, Component } from "react";
import { supabase, isConfigured } from "./supabase.js";
import { cloudStorage, primeCache, clearCache, pruneShadow, subscribeSync } from "./cloud-storage.js";
import { migrateLocalToCloud } from "./migrate.js";
import { localStorageShim } from "./storage-shim.js";
import Auth from "./Auth.jsx";
import App from "./flipledger.jsx";

/* ErrorBoundary catches crashes so the user sees a recoverable message
   instead of a white screen. */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, errorInfo) {
    console.error("unhandled React error", error, errorInfo);
  }
  render() {
    if (this.state.error) {
      return (
        <Splash label="Something went wrong. Close and reopen to retry.">
          <button onClick={() => this.setState({ error: null })}
            style={{ marginTop: 16, padding: "8px 16px", borderRadius: 8,
              border: "none", background: "#3ECF74", color: "#0E1113",
              fontWeight: 600, cursor: "pointer" }}>Retry</button>
        </Splash>
      );
    }
    return this.props.children;
  }
}

/* Without Supabase credentials the app still runs, backed by localStorage,
   so a plain checkout works offline and with no account. */
export default function Root() {
  const [session, setSession] = useState(null);
  const [phase, setPhase] = useState(isConfigured ? "loading" : "local");
  const [migrated, setMigrated] = useState(null);
  const [offline, setOffline] = useState(false);
  const [syncFailed, setSyncFailed] = useState(0);
  const [primeTick, setPrimeTick] = useState(0);

  useEffect(() => {
    if (!isConfigured) {
      window.storage = localStorageShim;
      return;
    }
    /* Always the cloud object when signed in: it reads from its cache and
       falls back to a local shadow when the network is down, so the UI
       never has to switch backends (or lose track of which one it used). */
    window.storage = cloudStorage;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setPhase(data.session ? "priming" : "auth");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "INITIAL_SESSION") return; // getSession above is canonical
      setSession(s);
      if (!s) {
        clearCache();
        setOffline(false);
        setSyncFailed(0);
        setPhase("auth");
      } else {
        setPhase("priming");
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  /* Prime the cache on sign-in, and again whenever the network comes back,
     so offline writes are reconciled against the cloud and re-flushed. */
  useEffect(() => {
    if (!isConfigured || !session) return;
    if (phase !== "priming" && phase !== "ready") return;
    let alive = true;
    (async () => {
      try {
        const ok = await primeCache(session.user.id);
        if (!alive) return;
        setOffline(!ok);
        if (ok) {
          try {
            const res = await migrateLocalToCloud(session.user.id);
            /* Legacy localStorage data is in the cloud now (or flagged
               dirty if the upload failed) — drop the local copies. Runs
               after the migration on purpose: pruning first would delete
               data the migration has not moved yet. */
            pruneShadow();
            if (res && res.moved > 0 && alive) setMigrated(res);
            if (res && res.moved > 0) await primeCache(session.user.id);
          } catch (e) {
            console.error("migration failed", e);
          }
        }
        if (alive) setPhase("ready");
      } catch (e) {
        console.error("priming crashed", e);
        if (alive) setPhase("error");
      }
    })();
    return () => { alive = false; };
  }, [phase, session, primeTick]);

  /* The browser fires "online" when connectivity returns — debounce to 2s
     to avoid multiple re-primes during a network transition. */
  useEffect(() => {
    if (!isConfigured || !session) return;
    let timer = null;
    const on = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setPrimeTick((n) => n + 1), 2000);
    };
    window.addEventListener("online", on);
    return () => {
      window.removeEventListener("online", on);
      if (timer) clearTimeout(timer);
    };
  }, [isConfigured, session]);

  /* Surface writes that could not reach the cloud. */
  useEffect(
    () =>
      isConfigured
        ? subscribeSync((s) => setSyncFailed((n) => (n === s.failed ? n : s.failed)))
        : undefined,
    [isConfigured]
  );

  if (phase === "loading" || phase === "priming")
    return (
      <Splash label="Loading…">
        <button onClick={() => setPhase("priming")}
          style={{ marginTop: 16, padding: "8px 16px", borderRadius: 8,
            border: "none", background: "#3ECF74", color: "#0E1113",
            fontWeight: 600, cursor: "pointer" }}>Retry</button>
      </Splash>
    );
  if (phase === "error")
    return (
      <Splash label="Could not reach the server.">
        <button
          onClick={() => setPhase("priming")}
          style={{ marginTop: 16, padding: "8px 16px", borderRadius: 8,
            border: "none", background: "#3ECF74", color: "#0E1113",
            fontWeight: 600, cursor: "pointer" }}
        >
          Retry
        </button>
      </Splash>
    );
  if (phase === "auth") return <Auth />;
  return (
    <>
      {session && offline && (
        <Notice>Offline — changes save on this device and sync when you're back online.</Notice>
      )}
      {session && !offline && syncFailed > 0 && (
        <Notice>{syncFailed} change{syncFailed > 1 ? "s" : ""} not synced yet</Notice>
      )}
      {migrated && (
        <MigrationNote info={migrated} onClose={() => setMigrated(null)} />
      )}
      <ErrorBoundary>
        <App
          key={session ? session.user.id : "local"}
          onSignOut={session ? () => supabase.auth.signOut() : null}
        />
      </ErrorBoundary>
    </>
  );
}

function Notice({ children }) {
  return (
    <div style={{
      position: "fixed", top: "max(10px, env(safe-area-inset-top))", left: "50%",
      transform: "translateX(-50%)", zIndex: 85, maxWidth: "calc(100vw - 24px)",
      background: "#E0A33A", color: "#0E1113", borderRadius: 999, padding: "7px 14px",
      fontSize: 12, fontWeight: 600, textAlign: "center",
      fontFamily: "system-ui,-apple-system,sans-serif",
    }}>{children}</div>
  );
}

function MigrationNote({ info, onClose }) {
  return (
    <div style={{
      position: "fixed", left: 12, right: 12, bottom: 82, zIndex: 90,
      background: "#3ECF74", color: "#0E1113", borderRadius: 10, padding: "11px 14px",
      fontSize: 12.5, fontWeight: 600, display: "flex", gap: 10, alignItems: "center",
      fontFamily: "system-ui,-apple-system,sans-serif",
    }}>
      <span style={{ flex: 1 }}>
        Moved {info.moved} item{info.moved === 1 ? "" : "s"}
        {info.photos ? ` and ${info.photos} photo${info.photos === 1 ? "" : "s"}` : ""} to your account.
      </span>
      <button onClick={onClose} style={{
        background: "rgba(14,17,19,.15)", border: "none", borderRadius: 6,
        padding: "5px 10px", fontSize: 12, fontWeight: 600, color: "#0E1113",
      }}>OK</button>
    </div>
  );
}

function Splash({ label, children }) {
  return (
    <div style={{
      minHeight: "100dvh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 6,
      background: "#0E1113", color: "#8F999F", fontSize: 13,
      fontFamily: "system-ui,-apple-system,sans-serif", padding: 22, textAlign: "center",
    }}>
      <span>{label}</span>
      {children}
    </div>
  );
}
