const NAME = "logic-recorder";
let promise;
export function openDB() {
  if (!promise) {
    let opening;
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(NAME, 3);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        let events;
        if (event.oldVersion < 1) {
          db.createObjectStore("sessions", { keyPath: "id" });
          events = db.createObjectStore("events", { keyPath: "id" });
          events.createIndex("session", "sessionId");
          const assets = db.createObjectStore("assets", { keyPath: "id" });
          assets.createIndex("session", "sessionId");
        } else events = request.transaction.objectStore("events");
        if (!events.indexNames.contains("sessionSeq"))
          events.createIndex("sessionSeq", ["sessionId", "seq"]);
        if (!db.objectStoreNames.contains("imports"))
          db.createObjectStore("imports", { keyPath: "id" });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          if (promise === opening) promise = undefined;
        };
        resolve(db);
      };
      request.onerror = () => {
        if (promise === opening) promise = undefined;
        reject(request.error);
      };
    });
    promise = opening;
  }
  return promise;
}
export async function eventPage(sessionId, after = 0, limit = 20) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("events");
    const range = IDBKeyRange.bound(
      [sessionId, after],
      [sessionId, Number.MAX_SAFE_INTEGER],
      true,
      false,
    );
    const request = tx
      .objectStore("events")
      .index("sessionSeq")
      .openCursor(range);
    const results = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve(results);
    tx.onerror = () => reject(tx.error);
  });
}
export async function countEvents(sessionId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("events")
      .objectStore("events")
      .index("session")
      .count(IDBKeyRange.only(sessionId));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function put(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("存储事务已中断"));
  });
}
export async function get(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function all(store, sessionId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const source = db.transaction(store).objectStore(store);
    const req = sessionId
      ? source.index("session").getAll(sessionId)
      : source.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function saveImport(session, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["sessions", "imports"], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("保存事务已中断"));
    try {
      tx.objectStore("sessions").add(session);
      tx.objectStore("imports").add({ id: session.id, blob });
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}
export async function removeSession(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["sessions", "events", "assets", "imports"], "readwrite");
    tx.objectStore("sessions").delete(id);
    tx.objectStore("imports").delete(id);
    for (const name of ["events", "assets"]) {
      const request = tx
        .objectStore(name)
        .index("session")
        .openKeyCursor(IDBKeyRange.only(id));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          tx.objectStore(name).delete(cursor.primaryKey);
          cursor.continue();
        }
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
