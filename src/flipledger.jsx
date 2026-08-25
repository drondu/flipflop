import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";

/* ------------------------------------------------------------------ */
/* storage                                                              */
/* ------------------------------------------------------------------ */
const K_ITEMS = "flip:items";
const K_SET = "flip:settings";
const kPhotos = (id) => `flip:photos:${id}`;

async function sGet(key, fallback) {
  try {
    const r = await window.storage.get(key);
    if (!r || !r.value) return fallback;
    return JSON.parse(r.value);
  } catch (e) {
    return fallback;
  }
}
const sSet = (key, value) => window.storage.set(key, JSON.stringify(value));
async function sDel(key) {
  try {
    await window.storage.delete(key);
  } catch (e) {
    /* may not exist */
  }
}

/* ------------------------------------------------------------------ */
/* images                                                               */
/* ------------------------------------------------------------------ */
const readFile = (file) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("read failed"));
    r.readAsDataURL(file);
  });
const loadImg = (src) =>
  new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("decode failed"));
    i.src = src;
  });
function resize(img, maxDim, quality) {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/jpeg", quality);
}
async function processFile(file) {
  const img = await loadImg(await readFile(file));
  return { full: resize(img, 1200, 0.72), thumb: resize(img, 240, 0.6) };
}

/* ------------------------------------------------------------------ */
/* money — everything is stored in RON                                  */
/* ------------------------------------------------------------------ */
const num = (v) => {
  if (v === null || v === undefined) return 0;
  let s = String(v).replace(/\s/g, "");
  if (s === "") return 0;
  const dec = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  if (dec > -1) {
    const int = s.slice(0, dec).replace(/[.,]/g, "");
    const frac = s.slice(dec + 1).replace(/[^0-9]/g, "");
    s = frac ? `${int}.${frac}` : int;
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
};
const fmt = (n, cur) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const [int, frac] = Math.abs(v).toFixed(2).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${v < 0 ? "−" : ""}${frac === "00" ? grouped : `${grouped},${frac}`} ${cur}`;
};
const signed = (n, cur) => (n >= 0 ? "+" : "−") + fmt(Math.abs(n), cur);

const RATE = 5.25; // RON per 1 EUR
const toRon = (v, cur) =>
  Math.round(num(v) * (cur === "EUR" ? RATE : 1) * 100) / 100;
const fromRon = (ron, cur) => (cur === "EUR" ? num(ron) / RATE : num(ron));
const money = (ron, cur) => fmt(fromRon(ron, cur), cur);
const moneySigned = (ron, cur) => signed(fromRon(ron, cur), cur);
const toField = (v, cur) => {
  if (v === "" || v === null || v === undefined) return "";
  const n = fromRon(v, cur);
  return n ? String(Math.round(n * 100) / 100) : "";
};

/* ------------------------------------------------------------------ */
/* item model                                                           */
/* ------------------------------------------------------------------ */
const STATUS = {
  holding: { label: "Holding", short: "Holding" },
  sold: { label: "Sold", short: "Sold" },
  parted: { label: "Parted out", short: "Parted" },
  writeoff: { label: "Written off", short: "Write-off" },
};
const isOpen = (it) => (it.status || "holding") === "holding";
const statusOf = (it) => it.status || "holding";

const costOf = (it) =>
  num(it.buy) + num(it.inShipping) + num(it.refurb) +
  num(it.shipping) + num(it.packaging) + num(it.fees);
const profitOf = (it) => (isOpen(it) ? 0 : num(it.sell) - costOf(it));

const CATS = [
  /* PC parts */
  "GPU", "CPU", "Motherboard", "RAM", "Storage", "PSU",
  "Case", "Cooler", "Full PC", "Laptop", "Monitor",
  "Peripherals", "Optical drive", "Networking", "Console",
  /* everything else that passes through the shop */
  "TV", "Appliances", "Furniture", "Lighting", "Kitchenware",
  "Wearables", "Bikes", "Bundle", "Other",
];

const today = () => new Date().toISOString().slice(0, 10);
const shortDate = (d) => (d ? d.split("-").reverse().slice(0, 2).join(".") : "—");
const daysHeld = (it) => {
  if (!it.buyDate) return null;
  const end = isOpen(it) ? today() : it.sellDate || today();
  const d = Math.round((new Date(end) - new Date(it.buyDate)) / 86400000);
  return isNaN(d) ? null : Math.max(0, d);
};

/* migrate older records */
const normalise = (it) => ({
  status: it.sold ? "sold" : "holding",
  inShipping: 0,
  parentId: null,
  lot: false,
  ...it,
});

/* ------------------------------------------------------------------ */
/* app                                                                  */
/* ------------------------------------------------------------------ */
export default function App() {
  const [items, setItems] = useState([]);
  const [settings, setSettings] = useState({ currency: "RON" });
  const [ready, setReady] = useState(false);
  const [view, setView] = useState({ name: "list" });
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("new");
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  useEffect(() => {
    (async () => {
      const [i, s] = await Promise.all([sGet(K_ITEMS, []), sGet(K_SET, {})]);
      setItems((Array.isArray(i) ? i : []).map(normalise));
      setSettings({ currency: s && s.currency === "EUR" ? "EUR" : "RON" });
      setReady(true);
    })();
    return () => toastTimer.current && clearTimeout(toastTimer.current);
  }, []);

  const flash = useCallback((m) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  }, []);

  const persist = async (next, nextSettings) => {
    setItems(next);
    try {
      await sSet(K_ITEMS, next);
      if (nextSettings) {
        setSettings(nextSettings);
        await sSet(K_SET, nextSettings);
      }
    } catch (e) {
      flash("Couldn't save — storage full?");
    }
  };

  const cur = settings.currency;

  const tied = items.filter(isOpen).reduce((a, i) => a + costOf(i), 0);
  const closed = items.filter((i) => !isOpen(i));
  const realized = closed.reduce((a, i) => a + profitOf(i), 0);
  const closedCost = closed.reduce((a, i) => a + costOf(i), 0);
  const roi = closedCost > 0 ? (realized / closedCost) * 100 : 0;
  const soldRun = items.filter((i) => statusOf(i) === "sold" || statusOf(i) === "writeoff");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = items.filter((i) => {
      const s = statusOf(i);
      if (filter === "holding" && s !== "holding") return false;
      if (filter === "sold" && s !== "sold") return false;
      if (filter === "closed" && (s === "holding" || s === "sold")) return false;
      if (!q) return true;
      return [i.name, i.category, i.source, i.channel, i.notes]
        .filter(Boolean).join(" ").toLowerCase().includes(q);
    });
    const by = {
      new: (a, b) => (b.created || 0) - (a.created || 0),
      old: (a, b) => (a.created || 0) - (b.created || 0),
      profit: (a, b) => profitOf(b) - profitOf(a),
      held: (a, b) => (daysHeld(b) || 0) - (daysHeld(a) || 0),
    };
    return list.sort(by[sort] || by.new);
  }, [items, filter, query, sort]);

  if (!ready) {
    return (
      <>
        <Styles />
        <div className="fl-shell fl-center">
          <div className="fl-mono fl-dim">Loading ledger…</div>
        </div>
      </>
    );
  }

  return (
    <>
      <Styles />
      <div className="fl-shell">
        {view.name === "list" && (
          <ListView
            items={shown}
            all={items}
            cur={cur}
            tied={tied}
            realized={realized}
            roi={roi}
            closedCount={closed.length}
            holdingCount={items.filter(isOpen).length}
            runList={soldRun}
            filter={filter}
            setFilter={setFilter}
            query={query}
            setQuery={setQuery}
            sort={sort}
            setSort={setSort}
            onOpen={(it) => setView({ name: "item", id: it.id })}
            onNew={() => setView({ name: "item", id: null, parent: null })}
            onData={() => setView({ name: "data" })}
            onCurrency={(c) => persist(items, { ...settings, currency: c })}
          />
        )}

        {view.name === "item" && (
          <ItemView
            key={view.id || "new-" + (view.parent || "")}
            existing={items.find((i) => i.id === view.id) || null}
            presetParent={view.parent || null}
            items={items}
            cur={cur}
            code={items.reduce((m, i) => Math.max(m, Number(i.code) || 0), 0) + 1}
            onCancel={() => setView({ name: "list" })}
            onJump={(id) => setView({ name: "item", id })}
            onAddPart={(lotId) => setView({ name: "item", id: null, parent: lotId })}
            onSave={async (item, photos) => {
              const isNew = !items.some((i) => i.id === item.id);
              try {
                await sSet(kPhotos(item.id), photos);
              } catch (e) {
                flash("Photos too large to save");
                return;
              }
              await persist(
                isNew ? [...items, item] : items.map((i) => (i.id === item.id ? item : i))
              );
              setView({ name: "list" });
              flash(isNew ? "Logged" : "Saved");
            }}
            onDelete={async (id) => {
              await sDel(kPhotos(id));
              await persist(
                items
                  .filter((i) => i.id !== id)
                  .map((i) => (i.parentId === id ? { ...i, parentId: null } : i))
              );
              setView({ name: "list" });
              flash("Deleted");
            }}
          />
        )}

        {view.name === "data" && (
          <DataView
            items={items}
            onBack={() => setView({ name: "list" })}
            onRestore={async (payload, mode) => {
              const list = (payload.items || []).map(normalise);
              for (const it of list) {
                const p = payload.photos && payload.photos[it.id];
                if (p) await sSet(kPhotos(it.id), p);
              }
              let next = list;
              let added = list.length;
              if (mode === "merge") {
                const byId = new Map(items.map((i) => [i.id, i]));
                added = 0;
                for (const it of list) {
                  if (!byId.has(it.id)) added += 1;
                  byId.set(it.id, it);
                }
                next = [...byId.values()];
              }
              await persist(next);
              setView({ name: "list" });
              flash(
                mode === "merge"
                  ? `Added ${added} items (${next.length} total)`
                  : `Restored ${list.length} items`
              );
            }}
            flash={flash}
          />
        )}

        {toast && <div className="fl-toast fl-mono">{toast}</div>}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* list                                                                 */
/* ------------------------------------------------------------------ */
function ListView({
  items, all, cur, tied, realized, roi, closedCount, holdingCount, runList,
  filter, setFilter, query, setQuery, sort, setSort,
  onOpen, onNew, onData, onCurrency,
}) {
  const maxAbs = Math.max(1, ...runList.map((i) => Math.abs(profitOf(i))));
  const counts = {
    all: all.length,
    holding: all.filter((i) => statusOf(i) === "holding").length,
    sold: all.filter((i) => statusOf(i) === "sold").length,
    closed: all.filter((i) => ["parted", "writeoff"].includes(statusOf(i))).length,
  };

  return (
    <div>
      <header className="fl-head">
        <div className="fl-headrow">
          <h1 className="fl-title">
            Flip<span className="fl-title-thin">Ledger</span>
          </h1>
          <div className="fl-headbtns">
            <button className="fl-icon" onClick={onData} aria-label="Backup and restore">
              <span className="fl-mono">Data</span>
            </button>
            <button
              className="fl-icon"
              onClick={() => onCurrency(cur === "RON" ? "EUR" : "RON")}
              aria-label={`Showing ${cur}. Tap to switch.`}
            >
              <span className="fl-mono">{cur}</span>
              <span className="fl-rate fl-mono">1 € = 5,25</span>
            </button>
          </div>
        </div>

        <div className="fl-stats">
          <div className="fl-stat">
            <span className="fl-label">Tied up</span>
            <span className="fl-statval">{money(tied, cur)}</span>
            <span className="fl-sub">{holdingCount} holding</span>
          </div>
          <div className="fl-stat">
            <span className="fl-label">Realized</span>
            <span className={"fl-statval " + (realized >= 0 ? "fl-gain" : "fl-loss")}>
              {moneySigned(realized, cur)}
            </span>
            <span className="fl-sub">
              {closedCount} closed · {roi >= 0 ? "+" : "−"}
              {Math.abs(roi).toFixed(0)}% ROI
            </span>
          </div>
        </div>

        {runList.length > 0 && (
          <div className="fl-run" aria-hidden="true">
            {runList.map((i) => {
              const p = profitOf(i);
              return (
                <span
                  key={i.id}
                  className={"fl-runbar " + (p >= 0 ? "fl-runup" : "fl-rundown")}
                  style={{ height: 4 + (Math.abs(p) / maxAbs) * 22 }}
                />
              );
            })}
          </div>
        )}

        <div className="fl-searchrow">
          <input
            className="fl-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search parts, source, notes…"
          />
          {query && (
            <button className="fl-clear" onClick={() => setQuery("")} aria-label="Clear search">×</button>
          )}
          <select className="fl-sort fl-mono" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="new">Newest</option>
            <option value="old">Oldest</option>
            <option value="profit">Profit</option>
            <option value="held">Longest held</option>
          </select>
        </div>

        <div className="fl-chiprow fl-filters">
          {[
            ["all", "All"],
            ["holding", "Holding"],
            ["sold", "Sold"],
            ["closed", "Parted / off"],
          ].map(([k, l]) => (
            <button
              key={k}
              className={"fl-chip" + (filter === k ? " fl-chip-on" : "")}
              onClick={() => setFilter(k)}
            >
              {l} <span className="fl-chipn">{counts[k]}</span>
            </button>
          ))}
        </div>
      </header>

      <main className="fl-list">
        {items.length === 0 && (
          <div className="fl-empty">
            <p className="fl-emptytitle">
              {query ? "No match" : all.length === 0 ? "Nothing here yet" : "Nothing under this filter"}
            </p>
            <p className="fl-emptybody">
              {all.length === 0
                ? "Log the first part you bought. Add the sale later, when it moves."
                : "Try All, or clear the search."}
            </p>
          </div>
        )}
        {items.map((it) => (
          <Card
            key={it.id}
            it={it}
            cur={cur}
            parent={it.parentId ? all.find((p) => p.id === it.parentId) : null}
            childCount={it.lot ? all.filter((c) => c.parentId === it.id).length : 0}
            onOpen={() => onOpen(it)}
          />
        ))}
        <div className="fl-spacer" />
      </main>

      <button className="fl-fab" onClick={onNew}>
        <span className="fl-fabplus">+</span> Add part
      </button>
    </div>
  );
}

function Card({ it, cur, parent, childCount, onOpen }) {
  const st = statusOf(it);
  const p = profitOf(it);
  const c = costOf(it);
  const margin = !isOpen(it) && c > 0 ? (p / c) * 100 : null;
  const days = daysHeld(it);
  const stale = isOpen(it) && days !== null && days > 60;

  return (
    <button className={`fl-card fl-c-${st}`} onClick={onOpen}>
      <span className={`fl-strip fl-s-${st}`} />
      <span className="fl-cardbody">
        <span className="fl-cardtop">
          <span className="fl-cat">{it.category || "Other"}</span>
          {it.lot && <span className="fl-tag fl-taglot">Lot{childCount ? ` · ${childCount}` : ""}</span>}
          {parent && (
            <span className="fl-tag">from #{String(parent.code).padStart(4, "0")}</span>
          )}
          <span className="fl-state">{STATUS[st].short}</span>
        </span>

        <span className="fl-name">{it.name || "Untitled part"}</span>

        <span className="fl-price">
          <span className="fl-mono fl-pricein">{money(c, cur)}</span>
          {!isOpen(it) && (
            <>
              <span className="fl-arrow">→</span>
              <span className="fl-mono fl-priceout">{money(it.sell, cur)}</span>
            </>
          )}
        </span>

        <span className="fl-cardfoot">
          {isOpen(it) ? (
            <span className="fl-mono fl-dim fl-small">{it.source || "In stock"}</span>
          ) : (
            <span className={"fl-mono fl-strong " + (p >= 0 ? "fl-gain" : "fl-loss")}>
              {moneySigned(p, cur)}
              {margin !== null && (
                <span className="fl-pct">
                  {" "}{margin >= 0 ? "+" : "−"}{Math.abs(margin).toFixed(0)}%
                </span>
              )}
            </span>
          )}
          {days !== null && (
            <span className={"fl-mono fl-small fl-days" + (stale ? " fl-aged" : " fl-dim")}>
              {days}d
            </span>
          )}
          <span className="fl-mono fl-dim fl-small fl-date">
            {isOpen(it) ? shortDate(it.buyDate) : shortDate(it.sellDate)}
          </span>
        </span>
      </span>

      <span className="fl-shot">
        {it.thumb ? <img src={it.thumb} alt="" /> : <span className="fl-shotempty fl-mono">no photo</span>}
        {it.photoCount > 1 && <span className="fl-shotcount fl-mono">{it.photoCount}</span>}
        <span className={"fl-shotcode fl-mono" + (it.thumb ? "" : " fl-shotcode-plain")}>
          #{String(it.code).padStart(4, "0")}
        </span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* item form                                                            */
/* ------------------------------------------------------------------ */
function ItemView({
  existing, presetParent, items, cur, code,
  onCancel, onSave, onDelete, onJump, onAddPart,
}) {
  const blank = {
    id: "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    code,
    name: "",
    category: "GPU",
    lot: false,
    parentId: presetParent || null,
    buy: "",
    buyDate: today(),
    source: "",
    inShipping: "",
    refurb: "",
    notes: "",
    status: "holding",
    sell: "",
    sellDate: today(),
    channel: "",
    shipping: "",
    packaging: "",
    fees: "",
    thumb: null,
    photoCount: 0,
    created: Date.now(),
  };

  const [f, setF] = useState(() =>
    existing
      ? {
          ...blank,
          ...existing,
          status: statusOf(existing),
          buy: toField(existing.buy, cur),
          inShipping: toField(existing.inShipping, cur),
          refurb: toField(existing.refurb, cur),
          sell: toField(existing.sell, cur),
          shipping: toField(existing.shipping, cur),
          packaging: toField(existing.packaging, cur),
          fees: toField(existing.fees, cur),
        }
      : blank
  );
  const [photos, setPhotos] = useState([]);
  const [loadingPhotos, setLoadingPhotos] = useState(!!existing);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [viewer, setViewer] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!existing) return;
    let alive = true;
    (async () => {
      const p = await sGet(kPhotos(existing.id), []);
      if (!alive) return;
      setPhotos(
        (Array.isArray(p) ? p : [])
          .map((x) => (typeof x === "string" ? { full: x, thumb: x } : x))
          .filter((x) => x && x.full)
      );
      setLoadingPhotos(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing && existing.id]);

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const st = f.status;

  const addPhotos = async (e) => {
    const files = Array.from(e.target.files || []).slice(0, 6 - photos.length);
    if (fileRef.current) fileRef.current.value = "";
    if (!files.length) return;
    setBusy(true);
    const next = [...photos];
    for (const file of files) {
      try { next.push(await processFile(file)); } catch (err) { /* skip */ }
    }
    setPhotos(next);
    setBusy(false);
  };
  const removePhoto = (idx) => {
    setPhotos((ps) => ps.filter((_, i) => i !== idx));
    setViewer(null);
  };

  /* form values are in the active currency */
  const cost = costOf(f);
  const profit = st === "holding" ? null : num(f.sell) - cost;

  const kids = existing ? items.filter((i) => i.parentId === existing.id) : [];
  const lots = items.filter((i) => i.lot && i.id !== f.id);
  const kidsOut = kids.reduce((a, i) => a + num(i.sell), 0);
  const kidsCost = kids.reduce((a, i) => a + costOf(i), 0);
  const lotNet = fromRon(kidsOut - kidsCost, cur) + num(f.sell) - cost;

  const save = () =>
    onSave(
      {
        ...f,
        lot: !!f.lot,
        buy: toRon(f.buy, cur),
        inShipping: toRon(f.inShipping, cur),
        refurb: toRon(f.refurb, cur),
        sell: st === "holding" ? 0 : toRon(f.sell, cur),
        shipping: st === "sold" ? toRon(f.shipping, cur) : 0,
        packaging: st === "sold" ? toRon(f.packaging, cur) : 0,
        fees: st === "sold" ? toRon(f.fees, cur) : 0,
        photoCount: photos.length,
        thumb: photos.length ? photos[0].thumb : null,
      },
      photos
    );

  return (
    <div className="fl-form">
      <header className="fl-formhead">
        <button className="fl-back" onClick={onCancel}>← Back</button>
        <span className="fl-code">#{String(f.code).padStart(4, "0")}</span>
        <button className="fl-save" onClick={save} disabled={busy}>Save</button>
      </header>

      <div className="fl-formbody">
        <Section title="The part">
          <Field label="What is it">
            <input className="fl-in" value={f.name} onChange={set("name")} placeholder="RTX 3060 Ti Gigabyte" />
          </Field>
          <Field label="Category">
            <select className="fl-in" value={f.category} onChange={set("category")}>
              {CATS.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <label className="fl-toggle">
            <input
              type="checkbox"
              checked={!!f.lot}
              onChange={(e) => setF((s) => ({ ...s, lot: e.target.checked }))}
            />
            <span>This is a lot / whole PC I'll part out</span>
          </label>
          {lots.length > 0 && !f.lot && (
            <Field label="Came out of">
              <select
                className="fl-in"
                value={f.parentId || ""}
                onChange={(e) => setF((s) => ({ ...s, parentId: e.target.value || null }))}
              >
                <option value="">Bought on its own</option>
                {lots.map((l) => (
                  <option key={l.id} value={l.id}>
                    #{String(l.code).padStart(4, "0")} {l.name || "lot"}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </Section>

        <Section title="Photos" note={`${photos.length}/6`}>
          {loadingPhotos ? (
            <p className="fl-mono fl-dim fl-small">Loading photos…</p>
          ) : (
            <div className="fl-photos">
              {photos.map((p, i) => (
                <button key={i} className="fl-photo" onClick={() => setViewer(i)}>
                  <img src={p.full} alt={`Photo ${i + 1}`} />
                </button>
              ))}
              {photos.length < 6 && (
                <button
                  className="fl-photo fl-photoadd"
                  onClick={() => fileRef.current && fileRef.current.click()}
                  disabled={busy}
                >
                  {busy ? "…" : "+"}
                </button>
              )}
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/*" multiple onChange={addPhotos} style={{ display: "none" }} />
        </Section>

        <Section title="Bought">
          <div className="fl-two">
            <Field label={`Price (${cur})`}>
              <input className="fl-in fl-mono" inputMode="decimal" value={f.buy} onChange={set("buy")} placeholder="0" />
            </Field>
            <Field label="Date">
              <input className="fl-in fl-mono" type="date" value={f.buyDate} onChange={set("buyDate")} />
            </Field>
          </div>
          <Field label="From">
            <input className="fl-in" value={f.source} onChange={set("source")} placeholder="OLX, Kleinanzeigen, local…" />
          </Field>
          <div className="fl-two">
            <Field label={`Shipping in (${cur})`}>
              <input className="fl-in fl-mono" inputMode="decimal" value={f.inShipping} onChange={set("inShipping")} placeholder="0" />
            </Field>
            <Field label={`Repairs / parts (${cur})`}>
              <input className="fl-in fl-mono" inputMode="decimal" value={f.refurb} onChange={set("refurb")} placeholder="0" />
            </Field>
          </div>
        </Section>

        <Section title="Status">
          <div className="fl-seg">
            {Object.keys(STATUS).map((k) => (
              <button
                key={k}
                className={"fl-segbtn" + (st === k ? " fl-segon" : "")}
                onClick={() => setF((s) => ({ ...s, status: k }))}
              >
                {STATUS[k].short}
              </button>
            ))}
          </div>

          {st === "sold" && (
            <div className="fl-segbody">
              <div className="fl-two">
                <Field label={`Sold for (${cur})`}>
                  <input className="fl-in fl-mono" inputMode="decimal" value={f.sell} onChange={set("sell")} placeholder="0" />
                </Field>
                <Field label="Date">
                  <input className="fl-in fl-mono" type="date" value={f.sellDate} onChange={set("sellDate")} />
                </Field>
              </div>
              <Field label="Sold on">
                <input className="fl-in" value={f.channel} onChange={set("channel")} placeholder="eBay, OLX, local pickup…" />
              </Field>
              <div className="fl-three">
                <Field label="Shipping">
                  <input className="fl-in fl-mono" inputMode="decimal" value={f.shipping} onChange={set("shipping")} placeholder="0" />
                </Field>
                <Field label="Packaging">
                  <input className="fl-in fl-mono" inputMode="decimal" value={f.packaging} onChange={set("packaging")} placeholder="0" />
                </Field>
                <Field label="Fees">
                  <input className="fl-in fl-mono" inputMode="decimal" value={f.fees} onChange={set("fees")} placeholder="0" />
                </Field>
              </div>
            </div>
          )}

          {st === "parted" && (
            <div className="fl-segbody">
              <p className="fl-hint">
                The cost stays on this record. Log each component you pull out as its own
                item and point it back here — their sales are what pay this off.
              </p>
              <div className="fl-two">
                <Field label={`Leftovers sold for (${cur})`}>
                  <input className="fl-in fl-mono" inputMode="decimal" value={f.sell} onChange={set("sell")} placeholder="0" />
                </Field>
                <Field label="Date closed">
                  <input className="fl-in fl-mono" type="date" value={f.sellDate} onChange={set("sellDate")} />
                </Field>
              </div>
            </div>
          )}

          {st === "writeoff" && (
            <div className="fl-segbody">
              <p className="fl-hint">Dead, kept for your own build, or returned. Put anything you got back below.</p>
              <div className="fl-two">
                <Field label={`Recovered (${cur})`}>
                  <input className="fl-in fl-mono" inputMode="decimal" value={f.sell} onChange={set("sell")} placeholder="0" />
                </Field>
                <Field label="Date">
                  <input className="fl-in fl-mono" type="date" value={f.sellDate} onChange={set("sellDate")} />
                </Field>
              </div>
            </div>
          )}
        </Section>

        {existing && f.lot && (
          <Section title="Parts from this lot" note={`${kids.length}`}>
            {kids.length === 0 ? (
              <p className="fl-hint">Nothing pulled out yet.</p>
            ) : (
              <div className="fl-kids">
                {kids.map((k) => (
                  <button key={k.id} className="fl-kid" onClick={() => onJump(k.id)}>
                    <span className={`fl-kdot fl-s-${statusOf(k)}`} />
                    <span className="fl-kname">{k.name || "Untitled"}</span>
                    <span className={"fl-mono fl-small " + (isOpen(k) ? "fl-dim" : profitOf(k) >= 0 ? "fl-gain" : "fl-loss")}>
                      {isOpen(k) ? "open" : moneySigned(profitOf(k), cur)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <button className="fl-addpart" onClick={() => onAddPart(existing.id)}>
              + Pull a part out of this lot
            </button>
            <div className="fl-lotnet">
              <span className="fl-label">Lot net so far</span>
              <span className={"fl-mono fl-strong " + (lotNet >= 0 ? "fl-gain" : "fl-loss")}>
                {signed(lotNet, cur)}
              </span>
            </div>
          </Section>
        )}

        <Section title="Notes">
          <textarea
            className="fl-in fl-area"
            rows={3}
            value={f.notes}
            onChange={set("notes")}
            placeholder="Serial, condition, what the buyer asked…"
          />
        </Section>

        <div className="fl-ledger">
          <Row label="Cost in" value={fmt(cost, cur)} />
          {st !== "holding" && (
            <Row label={st === "writeoff" ? "Recovered" : "Out"} value={fmt(num(f.sell), cur)} />
          )}
          <div className="fl-ledgerline" />
          <Row
            label={st === "holding" ? "Capital out" : "Result"}
            value={st === "holding" ? fmt(cost, cur) : signed(profit, cur)}
            tone={st === "holding" ? "flat" : profit >= 0 ? "gain" : "loss"}
            big
          />
        </div>

        {existing && (
          <div className="fl-danger">
            {confirmDel ? (
              <>
                <button className="fl-delconfirm" onClick={() => onDelete(existing.id)}>Delete for good</button>
                <button className="fl-cancel" onClick={() => setConfirmDel(false)}>Keep it</button>
              </>
            ) : (
              <button className="fl-del" onClick={() => setConfirmDel(true)}>Delete this item</button>
            )}
          </div>
        )}
        <div className="fl-spacer" />
      </div>

      {viewer !== null && photos[viewer] && (
        <div className="fl-viewer" onClick={() => setViewer(null)}>
          <img src={photos[viewer].full} alt="" />
          <div className="fl-viewerbar" onClick={(e) => e.stopPropagation()}>
            <button className="fl-vbtn" onClick={() => setViewer((v) => (v - 1 + photos.length) % photos.length)}>‹</button>
            <button className="fl-vbtn fl-vdel" onClick={() => removePhoto(viewer)}>Remove</button>
            <button className="fl-vbtn" onClick={() => setViewer((v) => (v + 1) % photos.length)}>›</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* backup / restore                                                     */
/* ------------------------------------------------------------------ */
function DataView({ items, onBack, onRestore, flash }) {
  const [working, setWorking] = useState(false);
  const [paste, setPaste] = useState("");
  const fileRef = useRef(null);
  const pendingMode = useRef("merge");

  const buildPayload = async (withPhotos) => {
    const photos = {};
    if (withPhotos) {
      for (const it of items) photos[it.id] = await sGet(kPhotos(it.id), []);
    }
    return { app: "flipledger", v: 2, at: new Date().toISOString(), items, photos };
  };

  const download = async () => {
    setWorking(true);
    try {
      const payload = await buildPayload(true);
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `flipledger-${today()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      flash("Backup downloaded");
    } catch (e) {
      flash("Download blocked — use Copy instead");
    }
    setWorking(false);
  };

  const copy = async () => {
    setWorking(true);
    try {
      const payload = await buildPayload(false);
      await navigator.clipboard.writeText(JSON.stringify(payload));
      flash("Copied (without photos)");
    } catch (e) {
      flash("Couldn't copy");
    }
    setWorking(false);
  };

  const apply = (text, mode) => {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      flash("That isn't valid backup data");
      return;
    }
    if (!payload || !Array.isArray(payload.items)) {
      flash("That isn't a FlipLedger backup");
      return;
    }
    onRestore(payload, mode);
  };

  const pickFile = async (e) => {
    const file = (e.target.files || [])[0];
    const mode = pendingMode.current;
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    try {
      apply(await file.text(), mode);
    } catch (err) {
      flash("Couldn't read that file");
    }
  };

  return (
    <div className="fl-form">
      <header className="fl-formhead">
        <button className="fl-back" onClick={onBack}>← Back</button>
        <span className="fl-code">Backup</span>
        <span style={{ width: 52 }} />
      </header>

      <div className="fl-formbody">
        <Section title="Save a copy">
          <p className="fl-hint">
            Everything lives in this browser only. Clear your browsing data and it's gone —
            so pull a backup now and then. {items.length} items stored.
          </p>
          <div className="fl-btnrow">
            <button className="fl-btn fl-btnprimary" onClick={download} disabled={working}>
              Download .json
            </button>
            <button className="fl-btn" onClick={copy} disabled={working}>
              Copy text
            </button>
          </div>
        </Section>

        <Section title="Restore">
          <p className="fl-hint">
            <strong>Add</strong> keeps what you already have and brings in anything new.
            <br />
            <span className="fl-warn">Replace</span> wipes the ledger first — use it only to
            roll back to a backup.
          </p>
          <div className="fl-btnrow">
            <button
              className="fl-btn fl-btnprimary"
              onClick={() => {
                pendingMode.current = "merge";
                if (fileRef.current) fileRef.current.click();
              }}
            >
              Add from file
            </button>
            <button
              className="fl-btn"
              onClick={() => {
                pendingMode.current = "replace";
                if (fileRef.current) fileRef.current.click();
              }}
            >
              Replace from file
            </button>
          </div>
          <input ref={fileRef} type="file" accept=".json,application/json" onChange={pickFile} style={{ display: "none" }} />
          <textarea
            className="fl-in fl-area"
            rows={4}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="…or paste backup text here"
          />
          {paste.trim() && (
            <div className="fl-btnrow">
              <button className="fl-btn fl-btnprimary" onClick={() => apply(paste, "merge")}>
                Add pasted
              </button>
              <button className="fl-btn" onClick={() => apply(paste, "replace")}>
                Replace with pasted
              </button>
            </div>
          )}
        </Section>
        <div className="fl-spacer" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* bits                                                                 */
/* ------------------------------------------------------------------ */
function Section({ title, note, children }) {
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
function Field({ label, children }) {
  return (
    <label className="fl-field">
      <span className="fl-label">{label}</span>
      {children}
    </label>
  );
}
function Row({ label, value, tone, big }) {
  return (
    <div className={"fl-lrow" + (big ? " fl-lrowbig" : "")}>
      <span className="fl-label">{label}</span>
      <span className={"fl-mono fl-strong " + (tone === "gain" ? "fl-gain" : tone === "loss" ? "fl-loss" : "")}>
        {value}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* styles                                                               */
/* ------------------------------------------------------------------ */
function Styles() {
  return (
    <style>{`
@import url('https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

html,body{background:#0E1113;}

.fl-shell{
  color-scheme:dark;
  --bg:#0E1113; --surface:#181C1F; --surface2:#121618;
  --line:#252B2F; --card:#FFFFFF;
  --ink:#14181B; --ink2:#5C666D;
  --fg:#E6EAEC; --fg2:#8F999F; --metal:#77838A;
  --green:#3ECF74; --greendeep:#1B9E52; --amber:#E8A93C;
  --blue:#3E9BD1; --red:#B03A2C;
  --gain:#3ECF74; --loss:#FF7A66;
  --sans:'Instrument Sans',system-ui,-apple-system,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  background:var(--bg); color:var(--fg); font-family:var(--sans);
  min-height:100vh; max-width:540px; margin:0 auto; position:relative;
  -webkit-font-smoothing:antialiased;
}
.fl-shell *{box-sizing:border-box;}
.fl-center{display:flex;align-items:center;justify-content:center;height:60vh;}
.fl-mono{font-family:var(--mono);font-variant-numeric:tabular-nums;}
.fl-dim{color:var(--metal);}
.fl-small{font-size:11px;}
.fl-strong{font-weight:600;}
.fl-gain{color:var(--gain);}
.fl-loss{color:var(--loss);}
.fl-spacer{height:96px;}
.fl-label{font-family:var(--mono);font-size:10px;letter-spacing:.12em;
  text-transform:uppercase;color:var(--metal);display:block;}
.fl-hint{font-size:12.5px;line-height:1.5;color:var(--fg2);margin:0 0 11px;}
.fl-warn{color:#E8A93C;}
.fl-shell button{font-family:inherit;cursor:pointer;}
.fl-shell button:focus-visible,.fl-shell input:focus-visible,
.fl-shell select:focus-visible,.fl-shell textarea:focus-visible{
  outline:2px solid var(--green);outline-offset:2px;}

/* header */
.fl-head{padding:18px 16px 0;}
.fl-headrow{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.fl-headbtns{display:flex;gap:7px;align-items:center;}
.fl-title{font-size:19px;font-weight:600;letter-spacing:-.02em;margin:0;color:var(--fg);}
.fl-title-thin{font-weight:400;color:var(--green);}
.fl-icon{border:1px solid var(--line);background:var(--surface);border-radius:999px;
  padding:5px 12px;font-size:11px;letter-spacing:.08em;color:var(--green);
  display:flex;align-items:baseline;gap:7px;}
.fl-rate{font-size:9px;color:var(--metal);letter-spacing:.04em;}

.fl-stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px;}
.fl-stat{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 13px 11px;}
.fl-statval{display:block;font-family:var(--mono);font-size:20px;font-weight:500;
  letter-spacing:-.02em;margin-top:6px;font-variant-numeric:tabular-nums;color:var(--fg);}
.fl-sub{display:block;font-family:var(--mono);font-size:10px;color:var(--metal);margin-top:4px;}

.fl-run{display:flex;align-items:flex-end;gap:3px;height:30px;margin-top:12px;padding:0 2px;overflow:hidden;}
.fl-runbar{flex:1;min-width:3px;max-width:14px;border-radius:2px 2px 0 0;}
.fl-runup{background:var(--green);}
.fl-rundown{background:var(--loss);}

.fl-searchrow{display:flex;gap:7px;margin-top:14px;position:relative;}
.fl-search{flex:1;min-width:0;border:1px solid var(--line);background:var(--surface);
  border-radius:9px;padding:9px 11px;font-size:14px;color:var(--fg);font-family:var(--sans);}
.fl-search::placeholder{color:#5B656B;}
.fl-clear{position:absolute;right:118px;top:7px;background:none;border:none;
  color:var(--metal);font-size:18px;line-height:1;padding:2px 6px;}
.fl-sort{flex:0 0 108px;border:1px solid var(--line);background:var(--surface);
  border-radius:9px;padding:9px 8px;font-size:11.5px;color:var(--fg2);}

.fl-chiprow{display:flex;gap:7px;flex-wrap:wrap;}
.fl-filters{margin:11px 0 4px;}
.fl-chip{border:1px solid var(--line);background:transparent;border-radius:999px;
  padding:6px 12px;font-size:12.5px;color:var(--fg2);}
.fl-chip-on{background:var(--green);border-color:var(--green);color:#0E1113;font-weight:600;}
.fl-chipn{font-family:var(--mono);font-size:10px;opacity:.55;margin-left:2px;}

/* list */
.fl-list{padding:12px 16px 0;display:flex;flex-direction:column;gap:12px;}
.fl-card{display:flex;width:100%;text-align:left;background:var(--card);color:var(--ink);
  border:1px solid rgba(62,207,116,.30);border-radius:12px;overflow:hidden;padding:0;
  box-shadow:0 0 18px rgba(62,207,116,.16), 0 2px 8px rgba(0,0,0,.35);
  transition:transform .12s ease, box-shadow .12s ease;}
.fl-card:active{transform:scale(.994);box-shadow:0 0 26px rgba(62,207,116,.26);}
.fl-strip{width:5px;flex:0 0 5px;}
.fl-s-holding{background:var(--amber);}
.fl-s-sold{background:var(--greendeep);}
.fl-s-parted{background:var(--blue);}
.fl-s-writeoff{background:var(--red);}
.fl-cardbody{display:block;flex:1;padding:11px 12px 10px;min-width:0;}
.fl-cardtop{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.fl-cat{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;
  background:#EEF1F2;border-radius:3px;padding:2px 6px;color:var(--ink2);}
.fl-tag{font-family:var(--mono);font-size:9px;letter-spacing:.06em;border:1px solid #DDE2E4;
  border-radius:3px;padding:1px 5px;color:#7A848B;}
.fl-taglot{border-color:#B9DCEF;background:#EAF5FB;color:#2C7BA8;}
.fl-state{margin-left:auto;font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;
  text-transform:uppercase;}
.fl-c-holding .fl-state{color:#B8801E;}
.fl-c-sold .fl-state{color:#0F7A4B;}
.fl-c-parted .fl-state{color:#2C7BA8;}
.fl-c-writeoff .fl-state{color:#B03A2C;}
.fl-name{font-size:14.5px;font-weight:500;letter-spacing:-.01em;color:var(--ink);
  margin:7px 0 6px;line-height:1.3;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.fl-price{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;}
.fl-pricein{font-size:15px;font-weight:600;letter-spacing:-.02em;color:var(--ink);}
.fl-card:not(.fl-c-holding) .fl-pricein{font-size:13px;font-weight:400;color:#9AA3A8;text-decoration:line-through;}
.fl-arrow{color:#9AA3A8;font-size:12px;}
.fl-priceout{font-size:15px;font-weight:600;letter-spacing:-.02em;color:var(--ink);}
.fl-cardfoot{display:flex;align-items:baseline;gap:8px;margin-top:8px;}
.fl-cardfoot .fl-mono{font-size:12.5px;}
.fl-card .fl-gain{color:#0F7A4B;}
.fl-card .fl-loss{color:#C0392B;}
.fl-card .fl-dim{color:#9AA3A8;}
.fl-pct{font-size:10.5px;opacity:.7;}
.fl-days{margin-left:auto;flex:0 0 auto;}
.fl-aged{color:#B8801E;font-weight:600;}
.fl-date{flex:0 0 auto;}

.fl-shot{position:relative;flex:0 0 96px;width:96px;align-self:stretch;background:#EEF1F2;
  display:flex;align-items:center;justify-content:center;border-left:1px solid #E4E8EA;overflow:hidden;}
.fl-shot img{width:100%;height:100%;object-fit:cover;display:block;}
.fl-shotempty{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#9AA3A8;}
.fl-shotcount{position:absolute;top:6px;right:6px;background:rgba(14,17,19,.78);color:#fff;
  font-size:9.5px;border-radius:4px;padding:1px 5px;}
.fl-shotcode{position:absolute;bottom:5px;left:6px;font-size:9px;color:#fff;
  text-shadow:0 1px 3px rgba(0,0,0,.75);letter-spacing:.06em;}
.fl-shotcode-plain{color:#8A949A;text-shadow:none;}

.fl-empty{border:1px dashed var(--line);border-radius:12px;padding:28px 20px;text-align:center;}
.fl-emptytitle{font-size:15px;font-weight:500;margin:0 0 6px;color:var(--fg);}
.fl-emptybody{font-size:13px;color:var(--fg2);margin:0;line-height:1.5;}

.fl-fab{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);
  background:var(--green);color:#0E1113;border:none;border-radius:999px;
  padding:13px 24px;font-size:14px;font-weight:600;letter-spacing:-.01em;
  box-shadow:0 6px 24px rgba(62,207,116,.32);z-index:40;}
.fl-fabplus{font-family:var(--mono);margin-right:4px;}

/* form */
.fl-form{min-height:100vh;background:var(--bg);}
.fl-formhead{position:sticky;top:0;z-index:30;display:flex;align-items:center;
  justify-content:space-between;gap:10px;padding:12px 16px;
  background:var(--bg);border-bottom:1px solid var(--line);}
.fl-back{background:none;border:none;font-size:14px;color:var(--fg2);padding:4px 0;}
.fl-code{font-family:var(--mono);font-size:10px;color:var(--metal);letter-spacing:.06em;}
.fl-save{background:var(--green);color:#0E1113;border:none;border-radius:999px;
  padding:8px 18px;font-size:13px;font-weight:600;}
.fl-save:disabled{opacity:.45;}
.fl-formbody{padding:14px 16px 0;display:flex;flex-direction:column;gap:14px;}
.fl-sec{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:13px;}
.fl-sechead{display:flex;justify-content:space-between;align-items:center;margin-bottom:11px;}
.fl-sechead .fl-label{font-size:10.5px;color:var(--fg);}
.fl-field{display:block;margin-bottom:10px;}
.fl-field:last-child{margin-bottom:0;}
.fl-field .fl-label{margin-bottom:5px;}
.fl-in{width:100%;border:1px solid var(--line);border-radius:8px;background:var(--surface2);
  padding:10px 11px;font-size:15px;font-family:var(--sans);color:var(--fg);}
.fl-in::placeholder{color:#5B656B;}
.fl-in.fl-mono{font-family:var(--mono);}
.fl-area{resize:vertical;line-height:1.45;font-size:14px;margin-top:10px;}
.fl-two{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.fl-three{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;}
.fl-two .fl-field,.fl-three .fl-field{margin-bottom:10px;}
.fl-toggle{display:flex;align-items:center;gap:9px;font-size:13.5px;color:var(--fg);
  padding:4px 0;cursor:pointer;}
.fl-toggle input{width:18px;height:18px;flex:0 0 18px;accent-color:var(--green);}

.fl-seg{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;
  background:var(--surface2);border:1px solid var(--line);border-radius:10px;padding:4px;}
.fl-segbtn{border:none;background:transparent;color:var(--fg2);border-radius:7px;
  padding:8px 2px;font-size:11.5px;font-family:var(--mono);letter-spacing:.02em;}
.fl-segon{background:var(--green);color:#0E1113;font-weight:600;}
.fl-segbody{margin-top:13px;}

.fl-photos{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;}
.fl-photo{aspect-ratio:1;border-radius:8px;overflow:hidden;border:1px solid var(--line);
  padding:0;background:var(--surface2);}
.fl-photo img{width:100%;height:100%;object-fit:cover;display:block;}
.fl-photoadd{border:1px dashed var(--greendeep);background:rgba(62,207,116,.08);
  color:var(--green);font-size:20px;font-family:var(--mono);}

.fl-kids{display:flex;flex-direction:column;gap:6px;margin-bottom:11px;}
.fl-kid{display:flex;align-items:center;gap:9px;width:100%;text-align:left;
  background:var(--surface2);border:1px solid var(--line);border-radius:9px;padding:9px 11px;color:var(--fg);}
.fl-kdot{width:7px;height:7px;border-radius:999px;flex:0 0 7px;}
.fl-kname{flex:1;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.fl-addpart{width:100%;border:1px dashed var(--greendeep);background:rgba(62,207,116,.08);
  color:var(--green);border-radius:9px;padding:10px;font-size:13px;}
.fl-lotnet{display:flex;justify-content:space-between;align-items:baseline;
  margin-top:12px;padding-top:11px;border-top:1px solid var(--line);}
.fl-lotnet .fl-mono{font-size:15px;}

.fl-ledger{background:var(--surface);border:1px solid rgba(62,207,116,.28);border-radius:12px;
  padding:14px 15px;color:var(--fg);box-shadow:0 0 18px rgba(62,207,116,.10);}
.fl-lrow{display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;}
.fl-lrow .fl-mono{font-size:14px;}
.fl-lrowbig .fl-mono{font-size:22px;letter-spacing:-.02em;}
.fl-ledgerline{height:1px;background:var(--line);margin:8px 0;}

.fl-btnrow{display:flex;gap:9px;flex-wrap:wrap;}
.fl-btn{flex:1;min-width:130px;border:1px solid var(--line);background:var(--surface2);
  color:var(--fg);border-radius:9px;padding:11px;font-size:13px;}
.fl-btnprimary{background:var(--green);border-color:var(--green);color:#0E1113;font-weight:600;}
.fl-btn:disabled{opacity:.5;}

.fl-danger{display:flex;gap:9px;margin-top:2px;}
.fl-del,.fl-cancel{flex:1;background:transparent;border:1px solid var(--line);
  border-radius:9px;padding:11px;font-size:13px;color:var(--fg2);}
.fl-delconfirm{flex:1;background:var(--red);border:none;border-radius:9px;padding:11px;
  font-size:13px;font-weight:600;color:#fff;}

.fl-viewer{position:fixed;inset:0;background:rgba(6,8,9,.95);z-index:60;
  display:flex;align-items:center;justify-content:center;padding:16px;}
.fl-viewer img{max-width:100%;max-height:78vh;border-radius:10px;}
.fl-viewerbar{position:absolute;bottom:22px;left:0;right:0;display:flex;justify-content:center;gap:10px;}
.fl-vbtn{background:rgba(255,255,255,.13);border:none;color:#fff;border-radius:999px;
  padding:10px 18px;font-size:15px;}
.fl-vdel{font-size:13px;}

.fl-toast{position:fixed;bottom:82px;left:50%;transform:translateX(-50%);
  background:var(--green);color:#0E1113;padding:9px 16px;border-radius:999px;
  font-size:12px;font-weight:600;z-index:70;}
@media (prefers-reduced-motion:reduce){.fl-shell *{transition:none !important;animation:none !important;}}
`}</style>
  );
}