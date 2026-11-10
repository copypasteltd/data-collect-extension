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
export async function countAssets(sessionId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction("assets").objectStore("assets").index("session")
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
export async function putMany(store, values) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const results = values.map(() => true);
    const target = tx.objectStore(store);
    values.forEach((value, index) => {
      try {
        const request = target.put(value);
        request.onerror = (event) => {
          results[index] = false;
          event.preventDefault();
          event.stopPropagation();
        };
      } catch {
        results[index] = false;
      }
    });
    tx.oncomplete = () => resolve(results);
    tx.onabort = () => reject(tx.error || new Error("存储事务已中断"));
    tx.onerror = () => {};
  });
}
export async function putIdempotentEvents(values, capacity) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("events", "readwrite"), store = tx.objectStore("events");
    const results = values.map(() => "failed");
    let remaining = capacity, pendingReads = values.length;
    const sameEvent = (left, right) =>
      ["sessionId", "time", "kind", "tabId", "frameId", "documentId", "screenshotRequested", "batchSize"]
        .every((key) => left[key] === right[key]) && JSON.stringify(left.payload) === JSON.stringify(right.payload);
    const missing = [];
    const finishRead = () => {
      if (--pendingReads) return;
      if (results.includes("conflict")) {
        results.fill("conflict");
        return;
      }
      for (const index of missing) {
        if (remaining <= 0) { results[index] = "capacity"; continue; }
        remaining--;
        try {
          const write = store.put(values[index]);
          write.onsuccess = () => { results[index] = "created"; };
          write.onerror = (event) => { event.preventDefault(); event.stopPropagation(); };
        } catch {}
      }
    };
    values.forEach((value, index) => {
      try {
        const read = store.get(value.id);
        read.onerror = (event) => { event.preventDefault(); event.stopPropagation(); finishRead(); };
        read.onsuccess = () => {
          if (read.result) {
            results[index] = sameEvent(read.result, value) ? "existing" : "conflict";
          } else missing.push(index);
          finishRead();
        };
      } catch { finishRead(); }
    });
    tx.oncomplete = () => resolve(results);
    tx.onabort = () => reject(tx.error || new Error("存储事务已中断"));
    tx.onerror = () => {};
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
