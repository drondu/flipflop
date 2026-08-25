import { cloudStorage } from "./cloud-storage.js";

/* One-time move of pre-Supabase localStorage data into the cloud account.
   Runs after the cache is primed, so it can tell an empty account from a
   populated one and refuses to overwrite a ledger that already has items. */

const K_ITEMS = "flip:items";
const K_SET = "flip:settings";
const DONE = "flip:migrated";
const kPhotos = (id) => `flip:photos:${id}`;

const readLocal = (key) => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
};

export function hasLocalData() {
  const items = readLocal(K_ITEMS);
  return Array.isArray(items) && items.length > 0;
}

export function alreadyMigrated(userId) {
  try {
    return localStorage.getItem(`${DONE}:${userId}`) === "1";
  } catch {
    return false;
  }
}

/* Returns { moved, photos } on success, or null when there is nothing to do. */
export async function migrateLocalToCloud(userId) {
  if (alreadyMigrated(userId) || !hasLocalData()) return null;

  const localItems = readLocal(K_ITEMS) || [];

  // Never clobber an account that already holds items.
  const existing = await cloudStorage.get(K_ITEMS);
  let cloudItems = [];
  if (existing && existing.value) {
    try {
      cloudItems = JSON.parse(existing.value) || [];
    } catch {
      cloudItems = [];
    }
  }

  // Merge by id; anything already in the cloud wins.
  const byId = new Map();
  for (const it of localItems) if (it && it.id) byId.set(it.id, it);
  for (const it of cloudItems) if (it && it.id) byId.set(it.id, it);
  const merged = [...byId.values()];

  const added = merged.length - cloudItems.length;
  await cloudStorage.set(K_ITEMS, JSON.stringify(merged));

  const localSettings = readLocal(K_SET);
  if (localSettings && !(existing && existing.value)) {
    await cloudStorage.set(K_SET, JSON.stringify(localSettings));
  }

  // Photos are per-item; skip any the cloud already has.
  let photos = 0;
  for (const it of localItems) {
    if (!it || !it.id) continue;
    const local = readLocal(kPhotos(it.id));
    if (!Array.isArray(local) || local.length === 0) continue;
    const there = await cloudStorage.get(kPhotos(it.id));
    if (there && there.value && there.value !== "[]") continue;
    try {
      await cloudStorage.set(kPhotos(it.id), JSON.stringify(local));
      photos += local.length;
    } catch (e) {
      console.error("photo migration failed", it.id, e);
    }
  }

  try {
    localStorage.setItem(`${DONE}:${userId}`, "1");
  } catch {
    /* marking is best-effort; the merge above is idempotent anyway */
  }

  return { moved: added, photos };
}
