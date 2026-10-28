/* Small UI primitives used by flipledger.jsx. Kept in a separate module
   so the main file stays focused on business logic. */
export function Section({ title, note, children }) {
  return (
    <section className="fl-sec">
      <div className="fl-sechead">
        <h2 className="fl-label">{title}</h2>
        {note && <span className="fl-mono fl-dim fl-small">{note}</span>}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, children }) {
  return (
    <label className="fl-field">
      <span className="fl-label">{label}</span>
      {children}
    </label>
  );
}

export function Row({ label, value, tone, big }) {
  return (
    <div className={"fl-lrow" + (big ? " fl-lrowbig" : "")}>
      <span className="fl-label">{label}</span>
      <span className={"fl-mono fl-strong " + (tone === "gain" ? "fl-gain" : tone === "loss" ? "fl-loss" : "")}>
        {value}
      </span>
    </div>
  );
}
