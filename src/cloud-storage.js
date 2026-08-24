import { supabase } from "./supabase.js";

/* Implements the window.storage contract against the `kv` table.
   Reads are served from an in-memory cache primed at sign-in, so the UI
   stays synchronous-feeling; writes go to the cache immediately and are
   flushed to Postgres in the background. */

const cache = new Map();
let userId = null;

export async function primeCache(uid) {
  userId = uid;
  cache.clear();
  const { data, error } = await supabase.from("kv").select("key,value").eq("user_id", uid);
  if (error) throw error;
  for (const row of data || []) cache.set(row.key, JSON.stringify(row.value));
}

export function clearCache() {
  cache.clear();
  userId = null;
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

export const cloudStorage = {
  async get(key) {
    const value = cache.get(key);
    return value === undefined ? null : { value };
  },

  async set(key, value) {
    cache.set(key, value);
    if (!userId) return;
    return queue(key, async () => {
      const { error } = await supabase
        .from("kv")
        .upsert(
          { user_id: userId, key, value: JSON.parse(value), updated_at: new Date().toISOString() },
          { onConflict: "user_id,key" }
        );
      if (error) console.error("sync failed", key, error.message);
    });
  },

  async delete(key) {
    cache.delete(key);
    if (!userId) return;
    return queue(key, async () => {
      const { error } = await supabase.from("kv").delete().eq("user_id", userId).eq("key", key);
      if (error) console.error("delete failed", key, error.message);
    });
  },
};
