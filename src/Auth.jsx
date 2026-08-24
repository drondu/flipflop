import React, { useState } from "react";
import { supabase } from "./supabase.js";

export default function Auth() {
  const [mode, setMode] = useState("in");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const fn = mode === "in" ? "signInWithPassword" : "signUp";
    const { data, error } = await supabase.auth[fn]({ email, password: pw });
    if (error) setMsg({ bad: true, text: error.message });
    else if (mode === "up" && !data.session)
      setMsg({ text: "Check your email to confirm, then sign in." });
    setBusy(false);
  }

  return (
    <div className="fl-authwrap">
      <form className="fl-authcard" onSubmit={submit}>
        <h1 className="fl-authtitle">
          Flip<span className="fl-authtitle-thin">Ledger</span>
        </h1>
        <p className="fl-authhint">
          {mode === "in" ? "Sign in to reach your ledger from any device." : "Create an account."}
        </p>
        <input
          className="fl-authinput" type="email" placeholder="Email" value={email}
          onChange={(e) => setEmail(e.target.value)} required autoComplete="email"
        />
        <input
          className="fl-authinput" type="password" placeholder="Password" value={pw}
          onChange={(e) => setPw(e.target.value)} required minLength={6}
          autoComplete={mode === "in" ? "current-password" : "new-password"}
        />
        {msg && <p className={msg.bad ? "fl-autherr" : "fl-authok"}>{msg.text}</p>}
        <button className="fl-authbtn" disabled={busy || !email || !pw}>
          {busy ? "…" : mode === "in" ? "Sign in" : "Create account"}
        </button>
        <button type="button" className="fl-authswap"
          onClick={() => { setMode(mode === "in" ? "up" : "in"); setMsg(null); }}>
          {mode === "in" ? "Need an account?" : "Already have one?"}
        </button>
      </form>
      <style>{`
        .fl-authwrap{min-height:100dvh;display:flex;align-items:center;justify-content:center;
          background:#0E1113;padding:22px;font-family:system-ui,-apple-system,sans-serif;}
        .fl-authcard{width:100%;max-width:340px;display:flex;flex-direction:column;gap:11px;
          background:#181C1F;border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:22px;}
        .fl-authtitle{font-size:21px;font-weight:600;letter-spacing:-.02em;margin:0;color:#E6EAEC;}
        .fl-authtitle-thin{font-weight:400;color:#3ECF74;}
        .fl-authhint{font-size:12.5px;line-height:1.5;color:#8F999F;margin:0 0 4px;}
        .fl-authinput{border:1px solid rgba(255,255,255,.09);background:#121618;border-radius:9px;
          padding:11px;font-size:15px;color:#E6EAEC;width:100%;box-sizing:border-box;}
        .fl-authinput:focus{outline:2px solid #3ECF74;outline-offset:1px;}
        .fl-authbtn{background:#3ECF74;border:none;border-radius:9px;padding:12px;
          font-size:14px;font-weight:600;color:#0E1113;margin-top:3px;}
        .fl-authbtn:disabled{opacity:.5;}
        .fl-authswap{background:none;border:none;color:#8F999F;font-size:12.5px;padding:4px;}
        .fl-autherr{color:#E5484D;font-size:12.5px;margin:0;line-height:1.45;}
        .fl-authok{color:#3ECF74;font-size:12.5px;margin:0;line-height:1.45;}
      `}</style>
    </div>
  );
}
