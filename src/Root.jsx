import React, { useEffect, useState } from "react";
import { supabase, isConfigured } from "./supabase.js";
import { cloudStorage, primeCache, clearCache } from "./cloud-storage.js";
import { migrateLocalToCloud } from "./migrate.js";
import { localStorageShim } from "./storage-shim.js";
import Auth from "./Auth.jsx";
import App from "./flipledger.jsx";

/* Without Supabase credentials the app still runs, backed by localStorage,
   so a plain checkout works offline and with no account. */
export default function Root() {
  const [session, setSession] = useState(null);
  const [phase, setPhase] = useState(isConfigured ? "loading" : "local");
  const [migrated, setMigrated] = useState(null);

  useEffect(() => {
    if (!isConfigured) {
      window.storage = localStorageShim;
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setPhase(data.session ? "priming" : "auth");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) {
        clearCache();
        setPhase("auth");
      } else {
        setPhase("priming");
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (phase !== "priming" || !session) return;
    let alive = true;
    (async () => {
      try {
        await primeCache(session.user.id);
        window.storage = cloudStorage;
        try {
          const res = await migrateLocalToCloud(session.user.id);
          if (res && res.moved > 0 && alive) setMigrated(res);
          if (res && res.moved > 0) await primeCache(session.user.id);
        } catch (e) {
          console.error("migration failed", e);
        }
        if (alive) setPhase("ready");
      } catch (e) {
        if (alive) setPhase("error");
      }
    })();
    return () => { alive = false; };
  }, [phase, session]);

  if (phase === "loading" || phase === "priming") return <Splash label="Loading…" />;
  if (phase === "error")
    return <Splash label="Could not reach the server. Pull to retry." />;
  if (phase === "auth") return <Auth />;
  return (
    <>
      <App key={(session ? session.user.id : "local") + (migrated ? ":m" : "")} />
      {migrated && (
        <MigrationNote info={migrated} onClose={() => setMigrated(null)} />
      )}
      {session && (
        <button
          onClick={() => supabase.auth.signOut()}
          title={session.user.email}
          style={{
            position: "fixed", top: 10, right: 10, zIndex: 80,
            background: "rgba(24,28,31,.9)", border: "1px solid rgba(255,255,255,.09)",
            color: "#8F999F", borderRadius: 999, padding: "5px 11px", fontSize: 11,
            letterSpacing: ".06em",
          }}
        >
          Sign out
        </button>
      )}
    </>
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

function Splash({ label }) {
  return (
    <div style={{
      minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0E1113", color: "#8F999F", fontSize: 13,
      fontFamily: "system-ui,-apple-system,sans-serif", padding: 22, textAlign: "center",
    }}>{label}</div>
  );
}
