/* window.storage over localStorage: the fallback when no Supabase project is
   configured. The app expects get(key) -> { value } | null, set, delete. */
export const localStorageShim = {
  async get(key) {
    const value = localStorage.getItem(key);
    return value === null ? null : { value };
  },
  async set(key, value) {
    localStorage.setItem(key, value);
  },
  async delete(key) {
    localStorage.removeItem(key);
  },
  /* nothing external can change localStorage from another device */
  subscribe() {
    return () => {};
  },
  /* batch-get: per-key localStorage reads. Mirrors the cloud shape so
     thumbMapFor needs no shim-specific branch. */
  async batchGet(keys) {
    const out = [];
    for (const k of keys) {
      const value = localStorage.getItem(k);
      if (value !== null) out.push({ key: k, value });
    }
    return out;
  },
  /* batch-delete: per-key localStorage removal. */
  async batchDelete(keys) {
    for (const k of keys) localStorage.removeItem(k);
  },
};
