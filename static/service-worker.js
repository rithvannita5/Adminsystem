// static/service-worker.js
// ============================================================
// SERVICE WORKER - គ្រប់គ្រង Offline Cache & Sync
// ============================================================

const CACHE_NAME = 'admin-system-v1';
const OFFLINE_URL = '/offline';

// ===== បញ្ជីឯកសារដែលត្រូវ Cache =====
const STATIC_FILES = [
    '/',
    '/dashboard',
    '/income',
    '/expense',
    '/income-budget',
    '/expense-budget',
    '/total-budget',
    '/customers',
    '/info',
    '/employees',
    '/settings',
    '/offline',
    '/static/manifest.json',
    // CSS & Fonts
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
    'https://fonts.googleapis.com/css2?family=Khmer&display=swap',
    'https://cdn.jsdelivr.net/npm/chart.js',
];

// ===== INSTALL: Cache static files =====
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[SW] Caching static assets...');
                return cache.addAll(STATIC_FILES);
            })
            .then(() => self.skipWaiting())
    );
});

// ===== ACTIVATE: Clean old caches =====
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(name => {
                    if (name !== CACHE_NAME) {
                        console.log('[SW] Deleting old cache:', name);
                        return caches.delete(name);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// ===== FETCH: Network-first with offline fallback =====
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // ===== API Requests: Offline queue via IndexedDB =====
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(handleApiRequest(event.request));
        return;
    }

    // ===== Static Assets: Cache-first =====
    if (url.pathname.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf)$/)) {
        event.respondWith(handleStaticRequest(event.request));
        return;
    }

    // ===== HTML Pages: Network-first with offline fallback =====
    event.respondWith(handlePageRequest(event.request));
});

// ===== គ្រប់គ្រង API Request =====
async function handleApiRequest(request) {
    try {
        // ព្យាយាមភ្ជាប់ទៅ Server
        const response = await fetch(request.clone());
        
        // ប្រសិនបើជា POST/PUT/DELETE និងជោគជ័យ → លុបចេញពី Queue
        if (request.method !== 'GET') {
            await removeFromQueue(request);
        }
        
        return response;
    } catch (error) {
        // ===== Offline: រក្សាទុកសំណើរក្នុង Queue =====
        if (request.method !== 'GET') {
            await addToQueue(request);
            return new Response(JSON.stringify({
                success: true,
                offline: true,
                message: 'រក្សាទុកក្នុង Offline Queue រួចរាល់! នឹង Sync ពេលមានបណ្តាញ'
            }), {
                headers: { 'Content-Type': 'application/json' },
                status: 200
            });
        }

        // GET API → ព្យាយាមយកពី Cache
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }

        // ប្រសិនបើគ្មាន Cache → ត្រឡប់ទទេ
        return new Response(JSON.stringify([]), {
            headers: { 'Content-Type': 'application/json' },
            status: 200
        });
    }
}

// ===== គ្រប់គ្រង Static Request =====
async function handleStaticRequest(request) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
        return cachedResponse;
    }

    try {
        const response = await fetch(request);
        if (response.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        return new Response('Resource not available offline', { status: 404 });
    }
}

// ===== គ្រប់គ្រង Page Request =====
async function handlePageRequest(request) {
    try {
        const response = await fetch(request);
        if (response.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }
        // ប្រសិនបើគ្មាន Cache → បង្ហាញទំព័រ Offline
        return caches.match('/offline') || new Response('Offline - គ្មានការតភ្ជាប់', { status: 503 });
    }
}

// ============================================================
// INDEXEDDB - Offline Queue
// ============================================================
const DB_NAME = 'OfflineQueueDB';
const STORE_NAME = 'requests';
const DB_VERSION = 1;

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
    });
}

async function addToQueue(request) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        // ចម្លង Request Body
        let body = null;
        if (request.method !== 'GET') {
            try {
                body = await request.clone().text();
            } catch (e) {
                body = null;
            }
        }

        const entry = {
            url: request.url,
            method: request.method,
            headers: Object.fromEntries(request.headers.entries()),
            body: body,
            timestamp: new Date().toISOString()
        };

        store.add(entry);
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = reject;
        });

        console.log('[SW] Added to offline queue:', request.url);
    } catch (error) {
        console.error('[SW] Error adding to queue:', error);
    }
}

async function removeFromQueue(request) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        // ស្វែងរកនិងលុបតាម URL & Method
        const index = store.index('url_method');
        // យើងនឹងប្រើ cursor ដើម្បីស្វែងរក
        const all = await new Promise((resolve) => {
            const result = [];
            const cursor = store.openCursor();
            cursor.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    result.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(result);
                }
            };
        });

        for (const item of all) {
            if (item.url === request.url && item.method === request.method) {
                store.delete(item.id);
            }
        }

        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = reject;
        });
    } catch (error) {
        console.error('[SW] Error removing from queue:', error);
    }
}

// ===== SYNC: ពេលមានបណ្តាញឡើងវិញ =====
self.addEventListener('online', () => {
    console.log('[SW] Online detected, syncing offline queue...');
    syncOfflineQueue();
});

// ===== ស្តាប់ Sync ពី Client =====
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SYNC_OFFLINE') {
        syncOfflineQueue();
    }
});

async function syncOfflineQueue() {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);

        const items = await new Promise((resolve) => {
            const result = [];
            const cursor = store.openCursor();
            cursor.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    result.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(result);
                }
            };
        });

        if (items.length === 0) {
            console.log('[SW] No offline items to sync');
            return;
        }

        console.log(`[SW] Syncing ${items.length} items...`);

        for (const item of items) {
            try {
                const response = await fetch(item.url, {
                    method: item.method,
                    headers: item.headers,
                    body: item.body
                });

                if (response.ok) {
                    // លុបចេញពី Queue
                    const delTx = db.transaction(STORE_NAME, 'readwrite');
                    const delStore = delTx.objectStore(STORE_NAME);
                    delStore.delete(item.id);
                    await new Promise((resolve) => { delTx.oncomplete = resolve; });
                    console.log(`[SW] Synced: ${item.url}`);
                } else {
                    console.warn(`[SW] Sync failed (${response.status}): ${item.url}`);
                }
            } catch (error) {
                console.error(`[SW] Error syncing ${item.url}:`, error);
            }
        }

        // ជូនដំណឹងទៅ Client
        const clients = await self.clients.matchAll();
        clients.forEach(client => {
            client.postMessage({
                type: 'SYNC_COMPLETE',
                count: items.length
            });
        });

    } catch (error) {
        console.error('[SW] Sync error:', error);
    }
}

// ===== ស្តាប់ Sync Trigger ពី Periodic =====
// ពិនិត្យ Sync រៀងរាល់ 30 វិនាទី (ប្រសិនបើ Online)
setInterval(() => {
    if (navigator.onLine) {
        syncOfflineQueue();
    }
}, 30000);

console.log('[SW] Service Worker initialized');