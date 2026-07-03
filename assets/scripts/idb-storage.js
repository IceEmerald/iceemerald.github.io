(function () {
    const DB_NAME = 'emeraldnetwork_client_storage';
    const DB_VERSION = 1;
    const STORE_NAME = 'kv';
    const cache = new Map();
    const subscribers = new Set();
    const tabId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const channel = typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel('emeraldnetwork-idb-storage')
        : null;
    let db = null;
    let ready = false;

    function canUseIndexedDB() {
        return typeof indexedDB !== 'undefined';
    }

    function openDatabase() {
        return new Promise((resolve, reject) => {
            if (!canUseIndexedDB()) {
                resolve(null);
                return;
            }

            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    database.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => console.warn('IndexedDB upgrade blocked for EmeraldNetwork storage.');
        });
    }

    function requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function loadCache() {
        if (!db) return;
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const all = await requestToPromise(store.getAll());
        all.forEach((entry) => {
            if (entry && typeof entry.key === 'string') cache.set(entry.key, entry.value);
        });
    }

    async function refreshKey(key) {
        await readyPromise;
        if (!db) return;
        const tx = db.transaction(STORE_NAME, 'readonly');
        const entry = await requestToPromise(tx.objectStore(STORE_NAME).get(key));
        if (entry && typeof entry.key === 'string') {
            cache.set(entry.key, entry.value);
        } else {
            cache.delete(key);
        }
    }

    function notify(change) {
        subscribers.forEach((callback) => {
            try { callback(change); } catch (error) { console.warn('Storage subscriber failed:', error); }
        });
    }

    function broadcast(change) {
        const message = { ...change, source: tabId, at: Date.now() };
        if (channel) channel.postMessage(message);
    }

    function putRaw(key, value) {
        cache.set(key, value);
        if (!db) return Promise.resolve();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ key, value, updatedAt: Date.now() });
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    function deleteRaw(key) {
        cache.delete(key);
        try { localStorage.removeItem(key); } catch (_) {}
        if (!db) return Promise.resolve();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => {
                broadcast({ key, type: 'delete' });
                resolve();
            };
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    }

    const readyPromise = openDatabase()
        .then((database) => {
            db = database;
            return loadCache();
        })
        .catch((error) => {
            console.warn('IndexedDB unavailable. Persistent app storage is disabled for this session.', error);
            db = null;
        })
        .finally(() => { ready = true; });

    function readLocalRaw(key) {
        try { return localStorage.getItem(key); } catch (_) { return null; }
    }

    function readRawSync(key) {
        if (cache.has(key)) return cache.get(key);
        return readLocalRaw(key);
    }

    async function getJSON(key) {
        await readyPromise;
        const raw = readRawSync(key);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (_) { return null; }
    }

    async function setJSON(key, value, options = {}) {
        const raw = JSON.stringify(value);
        await readyPromise;
        await putRaw(key, raw);
        try { localStorage.removeItem(key); } catch (_) {}
        broadcast({ key, type: 'set' });
    }

    function setJSONSync(key, value, options = {}) {
        const raw = JSON.stringify(value);
        cache.set(key, raw);

        readyPromise.then(() => {
            return putRaw(key, raw).then(() => {
                try { localStorage.removeItem(key); } catch (_) {}
                broadcast({ key, type: 'set' });
            });
        }).catch((error) => {
            console.warn('Failed to write IndexedDB value:', key, error);
        });
    }

    function getJSONSync(key) {
        const raw = readRawSync(key);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (_) { return null; }
    }

    async function migrateLocalJSON(key, options = {}) {
        await readyPromise;
        if (!db || cache.has(key)) return getJSON(key);

        const raw = readLocalRaw(key);
        if (!raw) return null;
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { return null; }

        await putRaw(key, raw);
        if (options.removeLocal !== false) {
            try { localStorage.removeItem(key); } catch (_) {}
        }
        broadcast({ key, type: 'set' });
        return parsed;
    }

    function createJSONStore(options = {}) {
        return {
            get: getJSONSync,
            set(key, value) { setJSONSync(key, value); },
            del(key) { deleteRaw(key).catch(() => {}); }
        };
    }

    if (channel) {
        channel.onmessage = (event) => {
            const message = event.data || {};
            if (!message.key || message.source === tabId) return;
            refreshKey(message.key).then(() => notify(message)).catch((error) => {
                console.warn('Failed to refresh IndexedDB cache:', error);
            });
        };
    }

    window.EmeraldIDBStorage = {
        ready: () => readyPromise,
        isReady: () => ready,
        usingIndexedDB: () => !!db,
        getJSON,
        getJSONSync,
        setJSON,
        setJSONSync,
        delete: deleteRaw,
        migrateLocalJSON,
        createJSONStore,
        subscribe(callback) {
            subscribers.add(callback);
            return () => subscribers.delete(callback);
        }
    };
}());