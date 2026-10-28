import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Section, Field, Row } from "./ui.jsx";
import "./styles.css";

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

/* Card thumbnails live in the per-item photos keys, not in the items row:
   a 240px JPEG per item would bloat the single items blob many times over.
   When batchGet is available (cloud), all photos are fetched in a single
   query; otherwise individual sGet calls are used (local/shim). */
async function thumbMapFor(list) {
  const map = {};
  const keys = list.filter((it) => it.photoCount > 0).map((it) => kPhotos(it.id));
  if (keys.length === 0) return map;
  const prefix = kPhotos("");

  const batch = window.storage.batchGet;
  if (batch) {
    /* Cloud: single query for all photos. */
    const results = await batch(keys);
    const prefix = kPhotos("");
    for (const row of results || []) {
      if (!row.key) continue;
      try {
        const p = JSON.parse(row.value);
        const first = Array.isArray(p) && p[0];
        if (first && first.thumb) map[row.key.slice(prefix.length)] = first.thumb;
      } catch { /* skip corrupt */ }
    }
  } else {
    /* Legacy/local: individual calls (no batching available). */
    await Promise.all(
      keys.map(async (key) => {
        const p = await sGet(key, []);
        const first = Array.isArray(p) && p[0];
        if (first && first.thumb) map[key.slice(prefix.length)] = first.thumb;
      })
    );
  }
  return map;
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
  if (typeof v === "number") return isNaN(v) ? 0 : v;
  let s = String(v).replace(/\s/g, "");
  if (s === "") return 0;
  /* Strip leading currency symbols (€$RON etc.) */
  s = s.replace(/^[^\d.,-]+/i, "");
  /* Strip trailing currency symbols */
  s = s.replace(/[^\d.,-]+$/, "");
  /* Handle negatives */
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  if (!s) return 0;
  /* The last separator is the decimal point, any earlier ones are
     thousands separators — "1234,56", "1.234,56" and "1,234.56" all read
     1234.56. Same rule as the CSV import tool, so what you type is what
     the sheet had. */
  const dec = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  if (dec > -1) {
    const int = s.slice(0, dec).replace(/[.,]/g, "");
    const frac = s.slice(dec + 1).replace(/[^0-9]/g, "");
    s = frac ? `${int}.${frac}` : int;
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return 0; /* junk — reject */
  const n = parseFloat(s);
  return isNaN(n) ? 0 : (neg ? -n : n);
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
  return String(Math.round(n * 100) / 100);
};

/* ------------------------------------------------------------------ */
/* item model                                                           */
/* ------------------------------------------------------------------ */
const STATUS = {
  /* key stays "holding" so existing records keep resolving */
  holding: { label: "In progress", short: "In progress" },
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

/* Migrate older records: ensure all new fields exist so existing records
   are compatible with the current schema. Old records may have a `sold`
   boolean instead of a `status` string — convert that. Defaults are safe
   for records that predate these fields. */
const normalise = (it) => ({
  status: (it.status || (it.sold ? "sold" : "holding")),
  inShipping: 0,
  esp: "",
  parentId: null,
  lot: false,
  /* last-write-wins stamp: Date.now() so old records aren't treated
     as ancient (updated: 0 would clobber newer cloud rows in LWW). */
  updated: Date.now(),
  ...it,
});

/* ------------------------------------------------------------------ */
/* app                                                                  */
/* ------------------------------------------------------------------ */
export default function App({ onSignOut }) {
  const [items, setItems] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [settings, setSettings] = useState({ currency: "RON" });
  const [ready, setReady] = useState(false);
  const [view, setView] = useState({ name: "list" });
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("new");
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const reload = useCallback(async () => {
    const [i, s] = await Promise.all([sGet(K_ITEMS, []), sGet(K_SET, {})]);
    const list = (Array.isArray(i) ? i : []).map(normalise);
    setItems(list);
    setSettings({ currency: s && s.currency === "EUR" ? "EUR" : "RON" });
    setThumbs(await thumbMapFor(list));
  }, []);

  useEffect(() => {
    let alive = true;
    reload().then(() => alive && setReady(true));
    /* The storage layer notifies when its cache changes under us (a
       re-prime after the network returns, a newer row from another
       device) — pick the change up without a full remount. */
    const un =
      window.storage && window.storage.subscribe
        ? window.storage.subscribe(() => {
            if (alive) reload();
          })
        : null;
    return () => {
      alive = false;
      if (un) un();
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [reload]);

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
      <div className="fl-shell fl-center">
        <div className="fl-mono fl-dim">Loading ledger…</div>
      </div>
    );
  }

  return (
    <>
      <div className="fl-shell">
        {view.name === "list" && (
          <ListView
            items={shown}
            all={items}
            thumbs={thumbs}
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
            flash={flash}
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
              setThumbs((m) => ({
                ...m,
                [item.id]: photos[0] && photos[0].thumb ? photos[0].thumb : null,
              }));
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
              setThumbs((m) => {
                const n = { ...m };
                delete n[id];
                return n;
              });
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
            cloud={Boolean(onSignOut)}
            onBack={() => setView({ name: "list" })}
            onClear={() => {
              setItems([]);
              setThumbs({});
              sSet(K_ITEMS, []).catch(() => {});
              flash("Ledger cleared");
            }}
            onRestore={async (payload, mode) => {
              const list = (payload.items || []).map(normalise);
              for (const it of list) {
                const p = payload.photos && payload.photos[it.id];
                if (p) await sSet(kPhotos(it.id), p);
              }
              if (mode === "replace") {
                /* drop photo blobs for items the restore removes */
                const keep = new Set(list.map((it) => it.id));
                for (const it of items) if (!keep.has(it.id)) await sDel(kPhotos(it.id));
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
              setThumbs(await thumbMapFor(next));
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
  items, all, thumbs, cur, tied, realized, roi, closedCount, holdingCount, runList,
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
            ["holding", "In progress"],
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
            /* thumbnails come from the photos keys; `it.thumb` covers
               legacy records written before the split */
            thumb={thumbs[it.id] || it.thumb || null}
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

function Card({ it, cur, thumb, parent, childCount, onOpen }) {
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
            num(it.esp) ? (
              <span className="fl-mono fl-small fl-esp">
                asking {money(it.esp, cur)}
              </span>
            ) : (
              <span className="fl-mono fl-dim fl-small">{it.source || "In stock"}</span>
            )
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
        {thumb ? <img src={thumb} alt="" /> : <span className="fl-shotempty fl-mono">no photo</span>}
        {it.photoCount > 1 && <span className="fl-shotcount fl-mono">{it.photoCount}</span>}
        <span className={"fl-shotcode fl-mono" + (thumb ? "" : " fl-shotcode-plain")}>
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
  existing, presetParent, items, cur, code, flash,
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
    esp: "",
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
          esp: toField(existing.esp, cur),
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
    let skipped = 0;
    for (const file of files) {
      /* Only accept image types */
      if (!file.type.startsWith("image/")) {
        skipped += 1;
        continue;
      }
      try { next.push(await processFile(file)); } catch (err) { skipped += 1; }
    }
    if (skipped > 0) flash(`Skipped ${skipped} invalid file${skipped > 1 ? "s" : ""}`);
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
  /* only while open: once sold, the real figure is what matters */
  const expectedProfit =
    st === "holding" && String(f.esp).trim() !== "" ? num(f.esp) - cost : null;

  const kids = existing ? items.filter((i) => i.parentId === existing.id) : [];
  const lots = items.filter((i) => i.lot && i.id !== f.id);
  const kidsOut = kids.reduce((a, i) => a + num(i.sell), 0);
  const kidsCost = kids.reduce((a, i) => a + costOf(i), 0);
  const lotNet = fromRon(kidsOut - kidsCost, cur) + num(f.sell) - cost;

  /* A field the user didn't change keeps its stored RON value exactly, so
     repeatedly saving while displaying in EUR can't drift the figures. */
  const keepOr = (k) => {
    const s = String(f[k] ?? "");
    if (existing && s === toField(existing[k], cur)) return existing[k];
    return toRon(s, cur);
  };

  const save = () => {
    /* Non-empty fields that don't parse to a number are rejected instead
       of silently storing 0 ("1.234,56" is ambiguous, "abc" is junk). */
    const badMoney = (v) => {
      const s = String(v ?? "").trim();
      if (s === "" || num(s) !== 0) return false;
      const digits = s.replace(/\D/g, "");
      return !digits || /[1-9]/.test(digits);
    };
    const fields = [
      ["buy", "Price"],
      ["inShipping", "Shipping in"],
      ["refurb", "Repairs"],
      ["esp", "Expected price"],
      ...(st === "sold"
        ? [["sell", "Sold for"], ["shipping", "Shipping"], ["packaging", "Packaging"], ["fees", "Fees"]]
        : st === "parted"
          ? [["sell", "Leftovers"]]
          : st === "writeoff"
            ? [["sell", "Recovered"]]
            : []),
    ];
    const bad = fields.filter(([k]) => badMoney(f[k])).map(([, label]) => label);
    if (bad.length) {
      flash(`Not a valid number: ${bad.join(", ")}`);
      return;
    }
    onSave(
      {
        ...f,
        lot: !!f.lot,
        buy: keepOr("buy"),
        inShipping: keepOr("inShipping"),
        refurb: keepOr("refurb"),
        /* stored in RON like every other amount */
        esp: keepOr("esp"),
        sell: st === "holding" ? 0 : keepOr("sell"),
        shipping: st === "sold" ? keepOr("shipping") : 0,
        packaging: st === "sold" ? keepOr("packaging") : 0,
        fees: st === "sold" ? keepOr("fees") : 0,
        /* last-write-wins stamp for local/cloud merges */
        updated: Date.now(),
        photoCount: photos.length,
        /* the thumbnail lives in the photos blob, not the items row */
        thumb: null,
      },
      photos
    );
  };

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
          <Field label={`Expected selling price (${cur})`}>
            <input
              className="fl-in fl-mono"
              inputMode="decimal"
              value={f.esp}
              onChange={set("esp")}
              placeholder="What you hope to get"
            />
          </Field>
          {expectedProfit !== null && (
            <p className="fl-hint fl-espnote">
              Expected profit{" "}
              <span className={expectedProfit >= 0 ? "fl-gain" : "fl-loss"}>
                {signed(expectedProfit, cur)}
              </span>{" "}
              against {fmt(cost, cur)} in.
            </p>
          )}
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
    const row = acc.get(key) || {
      key, n: 0, revenue: 0, invested: 0, transport: 0, cost: 0, profit: 0,
    };
    row.n += 1;
    row.revenue += num(it.sell);
    row.invested += num(it.buy);
    /* transport is everything spent beyond the purchase price:
       inbound shipping plus any refurb, postage, packaging or fees */
    row.transport += costOf(it) - num(it.buy);
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
    (a, r) => ({
      n: a.n + r.n,
      revenue: a.revenue + r.revenue,
      invested: a.invested + r.invested,
      transport: a.transport + r.transport,
      cost: a.cost + r.cost,
      profit: a.profit + r.profit,
    }),
    { n: 0, revenue: 0, invested: 0, transport: 0, cost: 0, profit: 0 }
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
          <p className="fl-hint">Nothing closed yet — months appear once an item is sold, parted or written off.</p>
        ) : (
          <>
            <Section title="By month closed" note={`${totals.n} closed`}>
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
                        <span>{r.n} closed</span>
                        <span className="fl-dim">invested {money(r.invested, cur)}</span>
                        <span className="fl-dim">transport {money(r.transport, cur)}</span>
                        <span className="fl-dim">sold {money(r.revenue, cur)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>

            <Section title="Total">
              <div className="fl-ledger">
                <div className="fl-lrow">
                  <span className="fl-label">Items closed</span>
                  <span className="fl-mono">{totals.n}</span>
                </div>
                <div className="fl-ledgerline" />
                <div className="fl-lrow">
                  <span className="fl-label">Invested</span>
                  <span className="fl-mono">{money(totals.invested, cur)}</span>
                </div>
                <div className="fl-lrow">
                  <span className="fl-label">Transport</span>
                  <span className="fl-mono">{money(totals.transport, cur)}</span>
                </div>
                <div className="fl-lrow">
                  <span className="fl-label">Total spent</span>
                  <span className="fl-mono">{money(totals.cost, cur)}</span>
                </div>
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
function DataView({ items, cloud, onBack, onRestore, onClear, flash }) {
  const [working, setWorking] = useState(false);
  const [paste, setPaste] = useState("");
  const [clearing, setClearing] = useState(false);
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
            {cloud
              ? "Your ledger syncs to your account, so it follows you across devices. Still pull a backup now and then — it's your only rollback. "
              : "Everything lives in this browser only. Clear your browsing data and it's gone — so pull a backup now and then. "}
            {items.length} items stored.
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
        {items.length > 0 && (
          <Section title="Danger zone">
            {clearing ? (
              <div className="fl-btnrow">
                <p className="fl-warn" style={{ flex: 1 }}>
                  Delete all {items.length} items. This cannot be undone.
                </p>
                <button className="fl-btn" onClick={onClear}
                  style={{ background: "#c0392b", color: "#fff" }}>Confirm clear</button>
                <button className="fl-btn" onClick={() => setClearing(false)}>Cancel</button>
              </div>
            ) : (
              <button className="fl-btn" onClick={() => setClearing(true)}
                style={{ background: "#c0392b", color: "#fff" }}>
                Clear ledger
              </button>
            )}
          </Section>
        )}
        <div className="fl-spacer" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* bits (moved to src/ui.js)                                            */
/* ------------------------------------------------------------------ */
