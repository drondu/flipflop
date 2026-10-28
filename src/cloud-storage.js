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
  const { data, error } = await supabase
    .from("kv")
    .select("key,value,updated_at")
    .eq("user_id", uid)
    .not("key", "regex", "flip:(photos|thumb):");
  if (my !== primeToken) return !error; // a newer prime superseded this one
  if (error) {
    console.warn("primeCache failed", error.message);
    for (const [k, v] of prev) cache.set(k, v);
    for (const k of prevDirty) dirty.add(k);
    for (const k of prevFailed) failed.add(k);
    emit();
    return false;
  }
  for (const row of data || []) {
    const at = row.updated_at || "";
    const ours = prev.get(row.key);
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
      return shadowGet(key); // offline: serve the unconfirmed local copy
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
