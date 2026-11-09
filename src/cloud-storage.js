import { supabase } from "./supabase.js";

/* Implements the window.storage contract against the `kv` table.
   Reads are served from an in-memory cache primed at sign-in, so the UI
   stays synchronous-feeling; writes go to the cache immediately and are
   flushed to Postgres in the background.

   Durability: every write also lands in a localStorage "shadow" (best
   effort — photos may exceed the quota and that's fine). If the network
   drops, the shadow is what get() falls back to, and keys whose flush
   failed are re-sent on the next successful prime, so offline edits are
   reconciled instead of silently lost. `subscribe` lets the UI reload
   when a prime changes the cache. */

const cache = new Map(); // key -> { value: string, at: string }
const dirty = new Set(); // keys with a write not yet confirmed in the cloud
const failed = new Set(); // keys whose last flush errored (awaiting retry)
let userId = null;
let primeToken = 0;
/* True once this session has a confirmed view of the cloud (a successful
   prime). While false, the in-memory ledger may be a stale/partial local
   copy, so it must never overwrite the cloud ledger row (see flush). */
let primedOk = false;

const listeners = new Set();
function emit(extra) {
  const s = { failed: failed.size, ...extra };
  for (const cb of listeners) cb(s);
}

/* UI subscribes to see how many writes are stuck unsynced. */
export function subscribeSync(cb) {
  listeners.add(cb);
  cb({ failed: failed.size });
  return () => listeners.delete(cb);
}

/* The UI reloads when the cache changes under it (a re-prime after the
   network returns, another device's newer row, …). */
export function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const t = (s) => (s ? new Date(s).getTime() || 0 : 0);
const isMediaKey = (k) => k.startsWith("flip:photos:") || k.startsWith("flip:thumb:");

/* The entire ledger is ONE kv row holding a JSON array of items. A blind
   last-write-wins on that single row is how a stale copy on one device
   deletes another device's items, so this key is reconciled by merging the
   item arrays by id instead (see mergeItems). */
const K_ITEMS = "flip:items";
const parseItems = (v) => {
  let a = v;
  if (typeof a === "string") {
    try { a = JSON.parse(a); } catch { a = []; }
  }
  return Array.isArray(a) ? a : [];
};
const itemStamp = (it) => (it && (it.updated || it.created)) || 0;
/* Union of two items arrays: every id present in either copy survives; for
   a shared id the copy with the newer per-item stamp wins (local wins ties,
   it being the device in hand). Deletions therefore do not propagate across
   devices — an accepted trade: resurrecting a deleted item is far less bad
   than silently losing items a device did not know about. */
function mergeItems(localArr, cloudArr) {
  localArr = parseItems(localArr);
  cloudArr = parseItems(cloudArr);
  const byId = new Map();
  const noId = [];
  for (const it of cloudArr) if (it && it.id) byId.set(it.id, it);
  for (const it of localArr) {
    if (!it) continue;
    if (!it.id) { noId.push(it); continue; }
    const cur = byId.get(it.id);
    if (!cur || itemStamp(it) >= itemStamp(cur)) byId.set(it.id, it);
  }
  return [...byId.values(), ...noId];
}

/* Shadow helpers. The shadow only ever holds keys this client wrote but
   could not confirm in the cloud, so it is small by construction. */
function shadowSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota exceeded (photos) — the shadow is best-effort */
  }
}
function shadowDel(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
function shadowGet(key) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? null : { value };
  } catch {
    return null;
  }
}
/* Decide the fate of each flip:* key in localStorage.
   The one rule that matters: never delete data that is not confirmed in
   the cloud. A local-only key may be the user's real ledger (never
   migrated, or written by a non-cloud build) — deleting it would lose it.
   - confirmed in the cloud, not dirty  -> stale duplicate, drop
   - dirty (unconfirmed write)          -> keep, unless wiping (sign-out)
   - not in the cloud, not dirty        -> local-only data, keep */
function dropLocalKeys({ wipeDirty }) {
  try {
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("flip:")) continue;
      /* the migration flag is per-user bookkeeping, not ledger data */
      if (k.startsWith("flip:migrated:")) continue;
      const isDirty = dirty.has(k);
      if (cache.has(k) && !isDirty) drop.push(k);
      else if (isDirty && wipeDirty) drop.push(k);
    }
    for (const k of drop) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/* Drop stale local duplicates of data already confirmed in the cloud.
   Runs after the local->cloud migration, so anything it drops is in the
   cloud (or still flagged dirty, in which case it is kept). */
export function pruneShadow() {
  dropLocalKeys({ wipeDirty: false });
}

export function clearCache() {
  /* Evaluate while the cache still knows what is confirmed in the cloud.
     Unconfirmed (dirty) keys are user-specific, so they go on sign-out;
     local-only data survives for the next session. */
  dropLocalKeys({ wipeDirty: true });
  cache.clear();
  dirty.clear();
  failed.clear();
  userId = null;
  primedOk = false;
  emit();
}

/* Serialize writes per key so rapid edits can't land out of order. */
const inflight = new Map();
function queue(key, task) {
  const prev = inflight.get(key) || Promise.resolve();
  const next = prev.then(task, task).finally(() => {
    if (inflight.get(key) === next) inflight.delete(key);
  });
  inflight.set(key, next);
  return next;
}

/* (Re)send one key's cached state to the cloud. A key absent from the
   cache means "delete was requested". */
function flush(key) {
  queue(key, async () => {
    const entry = cache.get(key);
    try {
      if (entry) {
        if (key === K_ITEMS && !primedOk) {
          /* This session never confirmed the cloud ledger, so our local
             copy may be partial/stale. Upserting it would replace the
             whole cloud row and delete other devices' items — hold it
             locally (dirty + failed, shown as "not synced yet") and let
             the next successful prime union-merge it safely. */
          dirty.add(key);
          failed.add(key);
          shadowSet(key, entry.value);
          return;
        }
        const { error } = await supabase
          .from("kv")
          .upsert(
            { user_id: userId, key, value: JSON.parse(entry.value), updated_at: entry.at },
            { onConflict: "user_id,key" }
          );
        if (error) throw error;
      } else {
        const { error } = await supabase.from("kv").delete().eq("user_id", userId).eq("key", key);
        if (error) throw error;
      }
      dirty.delete(key);
      failed.delete(key);
    } catch (e) {
      console.error("sync failed", key, e.message);
      dirty.add(key);
      failed.add(key);
      const entry = cache.get(key);
      if (entry) shadowSet(key, entry.value);
      else shadowDel(key); // failed delete — keep it deleted locally too
    } finally {
      emit(isMediaKey(key) ? { photoOnly: true } : undefined);
    }
  });
}

/* Fetch the user's rows and reconcile them with the cache:
   - a cloud row newer than our cached write wins (another device);
   - a cached write newer than the cloud row is kept and re-flushed;
   - keys only in the cache (created offline) are kept and re-flushed;
   - a key deleted locally but still in the cloud stays deleted and the
     delete is re-issued.
   Returns false when the fetch itself failed (network down); the cache
   is left as it was so the UI keeps showing its data. */
export async function primeCache(uid) {
  userId = uid;
  /* Guard the ledger for the duration of the fetch: until the cloud read
     succeeds, a flush of the ledger row must not overwrite it (see flush). */
  primedOk = false;
  const my = ++primeToken;
  const prev = new Map(cache);
  const prevDirty = new Set(dirty);
  const prevFailed = new Set(failed);
  cache.clear();
  dirty.clear();
  failed.clear();
  // Skip media blobs (photos + thumbs): 280 items × 6 photos = 1680 rows
  // (megabytes). The reconcile step excludes them, so dirty/failed media
  // keys are re-flushed separately below.
  // Note: two `not.like` filters, NOT one `regex` — PostgREST has no
  // `regex` row-filter operator (verified against the v11/v12/current
  // filter grammars), so `key=not.regex.…` makes the whole request fail
  // with a 400 "failed to parse filter". `like` is a core operator on
  // every version, and media keys always start with these exact prefixes
  // (see isMediaKey), so the two NOT LIKEs are equivalent.
  const { data, error } = await supabase
    .from("kv")
    .select("key,value,updated_at")
    .eq("user_id", uid)
    .not("key", "like", "flip:photos:%")
    .not("key", "like", "flip:thumb:%");
  if (my !== primeToken) return !error; // a newer prime superseded this one
  if (error) {
    console.warn("primeCache failed", error.message);
    for (const [k, v] of prev) cache.set(k, v);
    for (const k of prevDirty) dirty.add(k);
    for (const k of prevFailed) failed.add(k);
    emit();
    return false;
  }
  primedOk = true; // the cloud read succeeded — the ledger is safe to write
  for (const row of data || []) {
    const at = row.updated_at || "";
    const ours = prev.get(row.key);
    if (row.key === K_ITEMS) {
      /* Whole-ledger row: union-merge by item id (see mergeItems) so a
         stale copy on this device can never delete another device's items.
         Local = in-memory cache ∪ localStorage shadow, so items this device
         wrote that the cloud lost (another device overwrote the row) come
         back on the next sync. Push the union up only when it adds something. */
      const cloudArr = parseItems(row.value);
      const shadow = shadowGet(K_ITEMS);
      const localArr = mergeItems(
        ours ? parseItems(ours.value) : [],
        shadow ? parseItems(shadow.value) : []
      );
      const mergedStr = JSON.stringify(mergeItems(localArr, cloudArr));
      if (mergedStr === JSON.stringify(cloudArr)) {
        cache.set(row.key, { value: mergedStr, at });
        dirty.delete(row.key);
        failed.delete(row.key); // local holds nothing the cloud lacks
      } else {
        const atNew = ours && t(ours.at) > t(at) ? ours.at : at;
        cache.set(row.key, { value: mergedStr, at: atNew });
        dirty.add(row.key); // local has newer/extra items — sync the union
        failed.delete(row.key);
      }
      continue;
    }
    if (!ours) {
      if (prevDirty.has(row.key)) {
        dirty.add(row.key); // delete pending — keep it deleted, re-flush below
        continue;
      }
      cache.set(row.key, { value: JSON.stringify(row.value), at });
    } else if (t(ours.at) >= t(at)) {
      cache.set(row.key, ours); // our offline write is newer — keep it
      dirty.add(row.key);
    } else {
      cache.set(row.key, { value: JSON.stringify(row.value), at });
      dirty.delete(row.key);
      failed.delete(row.key); // cloud is newer — adopt it
    }
  }
  for (const [k, v] of prev) {
    if (!cache.has(k)) {
      cache.set(k, v); // created offline, not in the cloud yet
      if (isMediaKey(k)) {
        if (prevDirty.has(k)) dirty.add(k);
      } else {
        dirty.add(k);
      }
    }
  }
  for (const k of [...dirty]) flush(k);
  // Re-flush media keys that are dirty but absent from the cache (pending
  // deletes). Keys that ARE in the cache (failed writes) were already
  // re-added to dirty by the prev loop above and flushed by the loop above,
  // so we only handle the delete case here.
  for (const k of prevDirty) {
    if (isMediaKey(k) && !cache.has(k)) {
      failed.add(k);
      flush(k);
    }
  }
  emit();
  return true;
}

/* Batch-fetch values for a list of keys. Used by thumbMapFor to load
   multiple thumbs in a single query, and by migrateLocalToCloud to
   batch-check which photos already exist in the cloud. Chunks at 50 keys
   to stay under Postgres URL limits. */
async function batchGet(keys) {
  if (!userId || keys.length === 0) return [];
  const results = [];
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const { data, error } = await supabase
      .from("kv")
      .select("key,value")
      .eq("user_id", userId)
      .in("key", chunk);
    if (error) continue; // partial results are better than none
    if (data) results.push(...data);
  }
  return results;
}

/* Batch-delete keys. Used by clear-ledger to remove all photo+thumb rows
   in a single pass. Chunks at 50. Local cache/shadow cleanup always runs;
   cloud delete is best-effort (orphan blobs are invisible to the user). */
async function batchDelete(keys) {
  if (keys.length === 0) return;
  const allMedia = keys.every(isMediaKey);
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    for (const k of chunk) {
      cache.delete(k);
      shadowDel(k);
    }
    if (!userId) {
      for (const k of chunk) { dirty.delete(k); failed.delete(k); }
      continue;
    }
    for (const k of chunk) { dirty.add(k); failed.delete(k); }
    try {
      const { error } = await supabase
        .from("kv")
        .delete()
        .eq("user_id", userId)
        .in("key", chunk);
      if (error) throw error;
      for (const k of chunk) { dirty.delete(k); failed.delete(k); }
    } catch {
      for (const k of chunk) { dirty.add(k); failed.add(k); }
    }
  }
  emit(allMedia ? { photoOnly: true } : undefined);
}
export { batchGet, batchDelete };

export const cloudStorage = {
    async get(key) {
      const entry = cache.get(key);
      if (entry) return { value: entry.value };
      const sh = shadowGet(key);
      if (sh) return sh; // offline: serve the unconfirmed local copy
      /* Media keys (photos/thumbs) are excluded from the prime to keep it
         light, so a cache miss on one is EXPECTED: the photos may simply
         live in the cloud (written on another device). Fetch the single row
         and seed the cache/shadow for next time. Non-media keys (the
         ledger, settings) are always primed, so they stay local-only. */
      if (isMediaKey(key) && userId) {
        try {
          const { data, error } = await supabase
            .from("kv")
            .select("key,value,updated_at")
            .eq("user_id", userId)
            .eq("key", key);
          if (!error && data && data[0]) {
            const value = JSON.stringify(data[0].value);
            const at = data[0].updated_at || new Date().toISOString();
            cache.set(key, { value, at });
            shadowSet(key, value);
            return { value };
          }
        } catch { /* offline — serve the fallback */ }
      }
      return null;
    },

    async set(key, value) {
    const at = new Date().toISOString();
    cache.set(key, { value, at });
    shadowSet(key, value);
    if (!userId) return;
    dirty.add(key);
    failed.delete(key);
    emit(isMediaKey(key) ? { photoOnly: true } : undefined);
    return flush(key);
  },

  async delete(key) {
    cache.delete(key);
    shadowDel(key);
    if (!userId) return;
    dirty.add(key);
    failed.delete(key);
    emit(isMediaKey(key) ? { photoOnly: true } : undefined);
    return flush(key);
  },

    subscribe,
    batchGet,
    batchDelete,
  };
