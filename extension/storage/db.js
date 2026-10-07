/* Chat Capsule v5 — IndexedDB Storage Layer
   Replaces chrome.storage.local for large capsule data.
   Falls back to chrome.storage.local if IndexedDB is unavailable.
   
   API:
     db.put(capsule)       → { id }
     db.get(id)            → capsule | null
     db.list()             → [{ id, title, site, capturedAt, messages, sizeBytes }]
     db.delete(id)         → void
     db.clear()            → void
     db.usage()            → { count, estimatedBytes }
*/
"use strict";

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CapsuleDB = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DB_NAME = "chat-capsule-v5";
  const DB_VERSION = 1;
  const STORE = "capsules";
  const META_STORE = "meta";

  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB not available"));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("capturedAt", "capturedAt");
          store.createIndex("site", "site");
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(stores, mode) {
    return open().then((db) => {
      const t = db.transaction(stores, mode);
      return t;
    });
  }

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function titleOf(capsule) {
    const t = capsule.content && capsule.content.transcript;
    const first = Array.isArray(t) && t.find((m) => m.role === "User");
    const label = first ? first.text.replace(/\s+/g, " ").slice(0, 50) : (capsule.source && capsule.source.title) || "Capsule";
    return ((capsule.source && capsule.source.site) || "?") + ": " + label;
  }

  async function put(capsule) {
    if (!capsule || !capsule.id) throw new Error("Capsule must have an id");
    const t = await tx(STORE, "readwrite");
    const store = t.objectStore(STORE);
    // Store the full capsule but also keep a flat index record
    const data = {
      id: capsule.id,
      title: titleOf(capsule),
      site: (capsule.source && capsule.source.site) || "unknown",
      capturedAt: capsule.capturedAt || new Date().toISOString(),
      messages: (capsule.content && capsule.content.transcript && capsule.content.transcript.length) || 0,
      data: capsule, // full capsule object
    };
    await request(store.put(data));
    return { id: capsule.id };
  }

  async function get(id) {
    const t = await tx(STORE, "readonly");
    const store = t.objectStore(STORE);
    const rec = await request(store.get(id));
    return rec ? rec.data : null;
  }

  async function list() {
    const t = await tx(STORE, "readonly");
    const store = t.objectStore(STORE);
    const idx = store.index("capturedAt");
    const all = await request(idx.getAll());
    // Return metadata only, not full data
    return all.reverse().map((r) => ({
      id: r.id,
      title: r.title,
      site: r.site,
      capturedAt: r.capturedAt,
      messages: r.messages,
      sizeBytes: JSON.stringify(r.data || {}).length,
    }));
  }

  async function remove(id) {
    const t = await tx(STORE, "readwrite");
    const store = t.objectStore(STORE);
    await request(store.delete(id));
  }

  async function clear() {
    const t = await tx(STORE, "readwrite");
    const store = t.objectStore(STORE);
    await request(store.clear());
  }

  async function usage() {
    const t = await tx(STORE, "readonly");
    const store = t.objectStore(STORE);
    const all = await request(store.getAll());
    const estimatedBytes = all.reduce((n, r) => n + JSON.stringify(r).length, 0);
    return { count: all.length, estimatedBytes };
  }

  // Fallback: chrome.storage.local-based store (for environments without IDB)
  const CHROME_KEY = "capsules_v5";

  async function putFallback(capsule) {
    const list = await listFallback();
    const existing = list.findIndex((x) => x.id === capsule.id);
    const record = { id: capsule.id, title: titleOf(capsule), site: (capsule.source && capsule.source.site) || "?", capturedAt: capsule.capturedAt, messages: (capsule.content && capsule.content.transcript && capsule.content.transcript.length) || 0, data: capsule };
    if (existing >= 0) list[existing] = record; else list.unshift(record);
    await chrome.storage.local.set({ [CHROME_KEY]: list });
    return { id: capsule.id };
  }

  async function getFallback(id) {
    const list = await listFallback();
    const found = list.find((x) => x.id === id);
    return found ? found.data : null;
  }

  async function listFallback() {
    const o = await chrome.storage.local.get(CHROME_KEY);
    return Array.isArray(o[CHROME_KEY]) ? o[CHROME_KEY] : [];
  }

  async function removeFallback(id) {
    const list = (await listFallback()).filter((x) => x.id !== id);
    await chrome.storage.local.set({ [CHROME_KEY]: list });
  }

  // Wrap with IDB-first, chrome.storage fallback
  async function withFallback(idbFn, fbFn) {
    if (typeof indexedDB !== "undefined") {
      try { return await idbFn(); } catch (e) { /* fall through */ }
    }
    if (typeof chrome !== "undefined" && chrome.storage) {
      return fbFn();
    }
    throw new Error("No storage available");
  }

  return {
    put: (c) => withFallback(() => put(c), () => putFallback(c)),
    get: (id) => withFallback(() => get(id), () => getFallback(id)),
    list: () => withFallback(() => list(), () => listFallback().then((l) => l.map((r) => ({ id: r.id, title: r.title, site: r.site, capturedAt: r.capturedAt, messages: r.messages, sizeBytes: JSON.stringify(r.data || {}).length })))),
    delete: (id) => withFallback(() => remove(id), () => removeFallback(id)),
    clear: () => withFallback(() => clear(), () => chrome.storage.local.remove(CHROME_KEY)),
    usage: () => withFallback(() => usage(), async () => { const l = await listFallback(); return { count: l.length, estimatedBytes: JSON.stringify(l).length }; }),
  };
});
