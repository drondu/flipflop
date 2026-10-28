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
  /* batch-get: no-op for the shim, returns nothing (thumbMapFor falls back
     to individual sGet calls). */
  batchGet() {
    return Promise.resolve([]);
  },
};
