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
/* 0 when an item has no usable date, so sorts can push it to the end */
const dated = (it) => {
  const t = Number(it.created) || 0;
  return t > 86400000 ? t : 0;
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
export default function App({ onSignOut }) {
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
      /* undated records rank last in both directions, rather than
         reading as 1970 and heading the ascending sort */
      /* default: still-to-sell first, newest first inside each group */
      new: (a, b) =>
        isOpen(a) !== isOpen(b) ? (isOpen(a) ? -1 : 1) : dated(b) - dated(a),
      newest: (a, b) => dated(b) - dated(a),
      old: (a, b) => {
        const x = dated(a), y = dated(b);
        if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1);
        return x - y;
      },
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
            onMonths={() => setView({ name: "months" })}
            onSignOut={onSignOut}
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

        {view.name === "months" && (
          <MonthsView
            items={items}
            cur={settings.currency}
            onBack={() => setView({ name: "list" })}
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
  onOpen, onNew, onData, onMonths, onCurrency, onSignOut,
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
            <button className="fl-icon" onClick={onMonths} aria-label="Monthly breakdown">
              <span className="fl-mono">Months</span>
            </button>
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
            {onSignOut && (
              <button className="fl-icon fl-iconmuted" onClick={onSignOut} aria-label="Sign out">
                <span className="fl-mono">Exit</span>
              </button>
            )}
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
            <option value="new">Default</option>
            <option value="newest">Newest added</option>
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
/* ------------------------------------------------------------------ */
/* monthly breakdown                                                    */
/* ------------------------------------------------------------------ */
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const monthLabel = (key) => {
  if (key === "none") return "No date";
  const [y, m] = key.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
};

/* Groups closed items by the month they sold. Items with no sell date are
   kept under "none" rather than dropped, so the rows still add up to the
   realized total on the list screen. */
function groupByMonth(items) {
  const acc = new Map();
  for (const it of items) {
    if (isOpen(it)) continue;
    const key = it.sellDate ? it.sellDate.slice(0, 7) : "none";
    const row = acc.get(key) || { key, n: 0, revenue: 0, cost: 0, profit: 0 };
    row.n += 1;
    row.revenue += num(it.sell);
    row.cost += costOf(it);
    row.profit += profitOf(it);
    acc.set(key, row);
  }
  const rows = [...acc.values()];
  const dated = rows.filter((r) => r.key !== "none").sort((a, b) => b.key.localeCompare(a.key));
  const undated = rows.filter((r) => r.key === "none");
  return [...dated, ...undated];
}

function MonthsView({ items, cur, onBack }) {
  const rows = useMemo(() => groupByMonth(items), [items]);
  const best = rows.reduce((m, r) => (r.key !== "none" && r.profit > m ? r.profit : m), 0);
  const totals = rows.reduce(
    (a, r) => ({ n: a.n + r.n, revenue: a.revenue + r.revenue, profit: a.profit + r.profit }),
    { n: 0, revenue: 0, profit: 0 }
  );

  return (
    <div className="fl-form">
      <header className="fl-formhead">
        <button className="fl-back" onClick={onBack}>← Back</button>
        <span className="fl-code">Months</span>
        <span style={{ width: 52 }} />
      </header>

      <div className="fl-formbody">
        {rows.length === 0 ? (
          <p className="fl-hint">Nothing sold yet — months appear once you close a sale.</p>
        ) : (
          <>
            <Section title="By month sold" note={`${totals.n} closed`}>
              <div className="fl-months">
                {rows.map((r) => {
                  const share = best > 0 && r.profit > 0 ? Math.max(3, (r.profit / best) * 100) : 0;
                  return (
                    <div className="fl-month" key={r.key}>
                      <div className="fl-monthtop">
                        <span className="fl-monthname">{monthLabel(r.key)}</span>
                        <span className={"fl-mono fl-monthprofit " + (r.profit >= 0 ? "fl-gain" : "fl-loss")}>
                          {moneySigned(r.profit, cur)}
                        </span>
                      </div>
                      <div className="fl-monthbar" aria-hidden="true">
                        <span
                          className={r.profit >= 0 ? "fl-monthfill" : "fl-monthfill fl-monthfillneg"}
                          style={{ width: `${share}%` }}
                        />
                      </div>
                      <div className="fl-monthfoot fl-mono">
                        <span>{r.n} sold</span>
                        <span className="fl-dim">in {money(r.cost, cur)}</span>
                        <span className="fl-dim">out {money(r.revenue, cur)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>

            <Section title="Total">
              <div className="fl-ledger">
                <div className="fl-lrow">
                  <span className="fl-label">Items sold</span>
                  <span className="fl-mono">{totals.n}</span>
                </div>
                <div className="fl-ledgerline" />
                <div className="fl-lrow">
                  <span className="fl-label">Revenue</span>
                  <span className="fl-mono">{money(totals.revenue, cur)}</span>
                </div>
                <div className="fl-lrow fl-lrowbig">
                  <span className="fl-label">Profit</span>
                  <span className={"fl-mono " + (totals.profit >= 0 ? "fl-gain" : "fl-loss")}>
                    {moneySigned(totals.profit, cur)}
                  </span>
                </div>
              </div>
              <p className="fl-hint" style={{ marginTop: 10 }}>
                Grouped by sell date. Items closed without a date are listed
                separately so the total still matches the ledger.
              </p>
            </Section>
          </>
        )}
        <div className="fl-spacer" />
      </div>
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

html,body{background:#0B0E10;}

.fl-shell{
  color-scheme:dark;
  --bg:#0B0E10; --surface:#15191C; --surface2:#101417;
  --line:#222829; --line2:#2E3538;
  /* cards sit on dark now: the old white slabs turned a 239-row
     ledger into a wall of glare and gave every item equal weight */
  --card:#161A1D; --cardhi:#1B2023;
  --ink:#E8EDEF; --ink2:#8A959B;
  --fg:#E8EDEF; --fg2:#939EA4; --metal:#6E797F;
  --onaccent:#0B0E10; --placeholder:#7A858B;
  --green:#3ECF74; --greendeep:#1B9E52; --amber:#E0A33A;
  --blue:#54A8DA; --red:#C4493A;
  --gain:#4ADB82; --loss:#FF8672;
  --sans:'Instrument Sans',system-ui,-apple-system,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  background:var(--bg); color:var(--fg); font-family:var(--sans);
  min-height:100vh; max-width:var(--shell,540px); margin:0 auto; position:relative;
  padding-left:env(safe-area-inset-left); padding-right:env(safe-area-inset-right);
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
.fl-spacer{height:calc(96px + env(safe-area-inset-bottom));}
.fl-label{font-family:var(--mono);font-size:10px;letter-spacing:.12em;
  text-transform:uppercase;color:var(--metal);display:block;}
.fl-hint{font-size:12.5px;line-height:1.5;color:var(--fg2);margin:0 0 11px;}
.fl-warn{color:var(--amber);}
.fl-shell button{font-family:inherit;cursor:pointer;}
.fl-shell button:focus-visible,.fl-shell input:focus-visible,
.fl-shell select:focus-visible,.fl-shell textarea:focus-visible{
  outline:2px solid var(--green);outline-offset:2px;}

/* header */
.fl-head{padding:18px 16px 0;}
.fl-headrow{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;}
.fl-headbtns{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
.fl-title{font-size:19px;font-weight:600;letter-spacing:-.03em;margin:0;color:var(--fg);}
.fl-title-thin{font-weight:400;color:var(--green);}
.fl-icon{border:1px solid var(--line);background:var(--surface);border-radius:999px;
  padding:5px 12px;font-size:11px;letter-spacing:.08em;color:var(--green);
  display:flex;align-items:baseline;gap:7px;}
.fl-rate{font-size:9px;color:var(--metal);letter-spacing:.04em;}
.fl-iconmuted{color:var(--fg2);}
.fl-iconmuted:hover{color:var(--fg);border-color:var(--line2);}

.fl-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px;}
/* the two headline numbers: a top hairline in the stat's own colour
   turns them into gauges rather than plain boxes */
.fl-stat{position:relative;min-width:0;background:var(--surface);border:1px solid var(--line);
  border-radius:12px;padding:13px 14px 12px;overflow:hidden;}
.fl-stat::before{content:"";position:absolute;inset:0 0 auto 0;height:2px;
  background:linear-gradient(90deg,var(--amber),rgba(224,163,58,0));opacity:.75;}
.fl-stat:nth-child(2)::before{background:linear-gradient(90deg,var(--green),rgba(62,207,116,0));}
.fl-statval{display:block;font-family:var(--mono);font-size:23px;font-weight:500;
  letter-spacing:-.035em;margin-top:7px;font-variant-numeric:tabular-nums;color:var(--fg);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
@media (max-width:430px){.fl-statval{font-size:19px;letter-spacing:-.04em;}}
@media (max-width:360px){.fl-statval{font-size:17px;}}
.fl-sub{display:block;font-family:var(--mono);font-size:10px;color:var(--metal);margin-top:4px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

.fl-run{display:flex;align-items:flex-end;gap:3px;height:32px;margin-top:13px;padding:0 2px;
  overflow:hidden;border-bottom:1px solid var(--line);}
.fl-runbar{flex:1;min-width:3px;max-width:22px;border-radius:2px 2px 0 0;opacity:.85;
  transition:opacity .15s ease;}
.fl-run:hover .fl-runbar{opacity:.5;}
.fl-run .fl-runbar:hover{opacity:1;}
.fl-runup{background:var(--green);}
.fl-rundown{background:var(--loss);}

.fl-searchrow{display:flex;gap:7px;margin-top:14px;position:relative;min-width:0;}
.fl-search{flex:1;min-width:0;border:1px solid var(--line);background:var(--surface);
  border-radius:9px;padding:10px 12px;font-size:14px;color:var(--fg);font-family:var(--sans);
  transition:border-color .15s ease, background .15s ease;}
.fl-search:focus{outline:none;border-color:var(--greendeep);background:var(--surface2);}
.fl-search::placeholder{color:var(--placeholder);}
.fl-clear{position:absolute;right:118px;top:7px;background:none;border:none;
  color:var(--metal);font-size:18px;line-height:1;padding:2px 6px;}
.fl-sort{flex:0 0 112px;border:1px solid var(--line);background:var(--surface);
  border-radius:9px;padding:10px 8px;font-size:11.5px;color:var(--fg2);
  font-family:var(--mono);letter-spacing:.02em;
  transition:border-color .15s ease, color .15s ease;}
.fl-sort:hover{border-color:var(--line2);color:var(--fg);}

.fl-chiprow{display:flex;gap:7px;flex-wrap:wrap;}
.fl-filters{margin:11px 0 4px;}
.fl-chip{border:1px solid var(--line);background:transparent;border-radius:999px;
  padding:6px 12px;font-size:12.5px;color:var(--fg2);}
.fl-chip{transition:background .15s ease, border-color .15s ease, color .15s ease;}
.fl-chip:hover{border-color:var(--line2);color:var(--fg);}
.fl-chip-on,.fl-chip-on:hover{background:var(--green);border-color:var(--green);
  color:#0B0E10;font-weight:600;box-shadow:0 0 0 3px rgba(62,207,116,.12);}
.fl-chipn{font-family:var(--mono);font-size:10px;opacity:.55;margin-left:2px;}

/* list */
.fl-list{padding:12px 16px 0;display:flex;flex-direction:column;gap:9px;}
/* one orchestrated reveal on load; capped so a 239-row list does not
   spend two seconds animating, and disabled for reduced-motion */
@keyframes fl-rise{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}
.fl-list>*{animation:fl-rise .32s cubic-bezier(.22,.61,.36,1) backwards;}
.fl-list>*:nth-child(1){animation-delay:.01s}
.fl-list>*:nth-child(2){animation-delay:.035s}
.fl-list>*:nth-child(3){animation-delay:.06s}
.fl-list>*:nth-child(4){animation-delay:.085s}
.fl-list>*:nth-child(5){animation-delay:.11s}
.fl-list>*:nth-child(6){animation-delay:.135s}
.fl-list>*:nth-child(7){animation-delay:.16s}
.fl-list>*:nth-child(n+8){animation-delay:.18s}
/* Only open positions glow. Everything closed recedes, so the eye lands
   on what still needs selling instead of on 239 identical slabs. */
.fl-card{display:flex;width:100%;text-align:left;background:var(--card);color:var(--ink);
  border:1px solid var(--line);border-radius:11px;overflow:hidden;padding:0;
  box-shadow:0 1px 2px rgba(0,0,0,.4);
  transition:background .16s ease, border-color .16s ease, transform .12s ease;}
.fl-card.fl-c-holding{background:var(--cardhi);border-color:rgba(224,163,58,.34);}
.fl-card:hover{background:var(--cardhi);border-color:var(--line2);}
.fl-card.fl-c-holding:hover{border-color:rgba(224,163,58,.55);}
.fl-card:active{transform:scale(.995);}
@media (hover:none){.fl-card:hover{background:var(--card);border-color:var(--line);}
  .fl-card.fl-c-holding:hover{background:var(--cardhi);border-color:rgba(224,163,58,.34);}}
.fl-strip{width:5px;flex:0 0 5px;}
.fl-s-holding{background:var(--amber);}
.fl-s-sold{background:var(--greendeep);}
.fl-s-parted{background:var(--blue);}
.fl-s-writeoff{background:var(--red);}
.fl-cardbody{display:block;flex:1;padding:9px 11px 9px;min-width:0;}
.fl-cardtop{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.fl-cat{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;
  background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.05);
  border-radius:3px;padding:2px 6px;color:var(--ink2);}
.fl-tag{font-family:var(--mono);font-size:9px;letter-spacing:.06em;border:1px solid var(--line2);
  border-radius:3px;padding:1px 5px;color:var(--metal);}
.fl-taglot{border-color:rgba(84,168,218,.34);background:rgba(84,168,218,.10);color:#7CC2E8;}
.fl-state{margin-left:auto;font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;
  text-transform:uppercase;}
.fl-c-holding .fl-state{color:var(--amber);}
.fl-c-sold .fl-state{color:var(--gain);}
.fl-c-parted .fl-state{color:var(--blue);}
.fl-c-writeoff .fl-state{color:var(--loss);}
.fl-name{font-size:14.5px;font-weight:500;letter-spacing:-.012em;color:var(--ink);
  margin:5px 0 4px;line-height:1.28;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.fl-price{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;}
.fl-pricein{font-size:15px;font-weight:600;letter-spacing:-.02em;color:var(--ink);}
.fl-card:not(.fl-c-holding) .fl-pricein{font-size:13px;font-weight:400;color:var(--metal);text-decoration:line-through;}
.fl-arrow{color:var(--metal);font-size:12px;}
.fl-priceout{font-size:15px;font-weight:600;letter-spacing:-.02em;color:var(--ink);}
.fl-cardfoot{display:flex;align-items:baseline;gap:8px;margin-top:6px;}
.fl-cardfoot .fl-mono{font-size:12.5px;}
/* .fl-card .fl-gain inherits --gain; the old value was for white cards */
.fl-card .fl-loss{color:var(--loss);}
.fl-card .fl-dim{color:var(--metal);}
.fl-pct{font-size:10.5px;opacity:.7;}
.fl-days{margin-left:auto;flex:0 0 auto;}
.fl-aged{color:var(--amber);font-weight:600;}
.fl-date{flex:0 0 auto;}

.fl-shot{position:relative;flex:0 0 84px;width:84px;align-self:stretch;background:rgba(0,0,0,.14);
  display:flex;align-items:center;justify-content:center;border-left:1px solid rgba(255,255,255,.04);overflow:hidden;}
.fl-shot img{width:100%;height:100%;object-fit:cover;display:block;}
.fl-shotempty{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#808B91;}
.fl-shotcount{position:absolute;top:6px;right:6px;background:rgba(14,17,19,.78);color:#fff;
  font-size:9.5px;border-radius:4px;padding:1px 5px;}
.fl-shotcode{position:absolute;bottom:5px;left:6px;font-size:9px;color:#fff;
  text-shadow:0 1px 3px rgba(0,0,0,.75);letter-spacing:.06em;}
.fl-shotcode-plain{color:var(--metal);text-shadow:none;}

.fl-empty{border:1px dashed var(--line);border-radius:12px;padding:28px 20px;text-align:center;}
.fl-emptytitle{font-size:15px;font-weight:500;margin:0 0 6px;color:var(--fg);}
.fl-emptybody{font-size:13px;color:var(--fg2);margin:0;line-height:1.5;}

.fl-fab{position:fixed;bottom:max(20px,calc(env(safe-area-inset-bottom) + 12px));
  left:50%;transform:translateX(-50%);
  background:var(--green);color:var(--onaccent);border:none;border-radius:999px;
  padding:13px 24px;font-size:14px;font-weight:600;letter-spacing:-.01em;
  box-shadow:0 6px 24px rgba(62,207,116,.32);z-index:40;}
.fl-fabplus{font-family:var(--mono);margin-right:4px;}

/* form */
.fl-form{min-height:100vh;background:var(--bg);}
.fl-formhead{position:sticky;top:0;z-index:30;display:flex;align-items:center;
  justify-content:space-between;gap:10px;
  padding:max(12px,env(safe-area-inset-top)) 16px 12px;
  background:var(--bg);border-bottom:1px solid var(--line);}
.fl-back{background:none;border:none;font-size:14px;color:var(--fg2);padding:4px 0;}
.fl-code{font-family:var(--mono);font-size:10px;color:var(--metal);letter-spacing:.06em;}
.fl-save{background:var(--green);color:var(--onaccent);border:none;border-radius:999px;
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
.fl-in::placeholder{color:var(--placeholder);}
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
.fl-segon{background:var(--green);color:var(--onaccent);font-weight:600;}
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

.fl-months{display:flex;flex-direction:column;gap:9px;}
.fl-month{background:var(--surface);border:1px solid var(--line);border-radius:11px;
  padding:11px 12px 10px;}
.fl-monthtop{display:flex;align-items:baseline;justify-content:space-between;gap:10px;}
.fl-monthname{font-size:14px;font-weight:500;letter-spacing:-.01em;color:var(--fg);}
.fl-monthprofit{font-size:15px;font-weight:600;letter-spacing:-.02em;}
/* bar is proportional to the best month, so the shape is comparative
   rather than absolute; hidden from screen readers since the figures
   above already carry the same information */
.fl-monthbar{height:4px;border-radius:999px;background:var(--surface2);
  margin:9px 0 8px;overflow:hidden;}
.fl-monthfill{display:block;height:100%;border-radius:999px;background:var(--green);}
.fl-monthfillneg{background:var(--loss);}
.fl-monthfoot{display:flex;gap:12px;font-size:10.5px;color:var(--fg2);flex-wrap:wrap;}
@media (min-width:820px){
  .fl-months{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}
}
@media (min-width:1180px){
  .fl-months{grid-template-columns:repeat(3,minmax(0,1fr));}
}

.fl-ledger{background:var(--surface);border:1px solid rgba(62,207,116,.28);border-radius:12px;
  padding:14px 15px;color:var(--fg);box-shadow:0 0 18px rgba(62,207,116,.10);}
.fl-lrow{display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;}
.fl-lrow .fl-mono{font-size:14px;}
.fl-lrowbig .fl-mono{font-size:22px;letter-spacing:-.02em;}
.fl-ledgerline{height:1px;background:var(--line);margin:8px 0;}

.fl-btnrow{display:flex;gap:9px;flex-wrap:wrap;}
.fl-btn{flex:1;min-width:130px;border:1px solid var(--line);background:var(--surface2);
  color:var(--fg);border-radius:9px;padding:11px;font-size:13px;}
.fl-btnprimary{background:var(--green);border-color:var(--green);color:var(--onaccent);font-weight:600;}
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

.fl-toast{position:fixed;bottom:max(82px,calc(env(safe-area-inset-bottom) + 74px));
  left:50%;transform:translateX(-50%);
  background:var(--green);color:var(--onaccent);padding:9px 16px;border-radius:999px;
  font-size:12px;font-weight:600;z-index:70;}

/* ------------------------------------------------------------------ */
/* responsive: phone-first, then widen the shell and let the list       */
/* become a grid. Cards are self-contained tiles, so columns are the    */
/* natural use of a desktop viewport rather than a wider single file.   */
/* ------------------------------------------------------------------ */

/* small phones: reclaim horizontal space */
@media (max-width:400px){
  .fl-head{padding:14px 12px 0;}
  .fl-list{padding:10px 12px 0;}
  .fl-stats{gap:8px;}
  .fl-statval{font-size:20px;}
  .fl-shot{flex:0 0 68px;width:68px;}
  .fl-sort{flex:0 0 96px;}
  .fl-name{font-size:14px;}
}

/* large phones and up: a touch more air */
@media (min-width:560px){
  .fl-shell{--shell:600px;}
  .fl-head{padding:22px 20px 0;}
  .fl-list{padding:14px 20px 0;}
}

/* tablets: two columns, and the stats can breathe */
@media (min-width:820px){
  .fl-shell{--shell:820px;}
  .fl-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));
    align-items:stretch;gap:10px;}
  /* names clamp to one line in grid mode, so rows stay even */
  .fl-list .fl-name{-webkit-line-clamp:1;min-height:0;}
  .fl-list .fl-card{height:100%;}
  .fl-stats{grid-template-columns:repeat(2,minmax(0,1fr));}
  .fl-run{height:38px;}
  /* the reveal cascades across the grid, so keep it short */
  .fl-list>*{animation-duration:.28s;}
}

/* desktop: three columns and a wider shell */
@media (min-width:1180px){
  .fl-shell{--shell:1180px;}
  .fl-list{grid-template-columns:repeat(3,minmax(0,1fr));gap:11px;}
  .fl-head{padding:26px 24px 0;}
  .fl-list{padding:16px 24px 0;}
  .fl-statval{font-size:26px;}
  .fl-run{height:44px;}
}

/* very wide: cap the columns so cards never stretch into letterboxes */
@media (min-width:1500px){
  .fl-shell{--shell:1420px;}
  .fl-list{grid-template-columns:repeat(4,minmax(0,1fr));}
}

/* on desktop the add button belongs near the cursor, not floating
   in the middle of a wide viewport */
@media (min-width:820px){
  .fl-fab{left:auto;right:calc(50% - var(--shell,540px)/2 + 24px);
    transform:none;bottom:max(26px,calc(env(safe-area-inset-bottom) + 18px));}
  .fl-fab:hover{filter:brightness(1.06);}
}

/* touch: keep the pills visually small but give thumbs a real target
   via a transparent inset, rather than inflating the header */
@media (hover:none){
  .fl-icon,.fl-chip{position:relative;}
  .fl-icon::after,.fl-chip::after{content:"";position:absolute;
    inset:-9px -4px;border-radius:999px;}
}

/* pointer-driven screens get a real hover lift; touch keeps it flat */
@media (hover:hover) and (pointer:fine){
  .fl-card{transition:background .16s ease, border-color .16s ease,
    transform .16s ease, box-shadow .16s ease;}
  .fl-card:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.45);}
}

@media (prefers-reduced-motion:reduce){.fl-shell *{transition:none !important;animation:none !important;}}
`}</style>
  );
}