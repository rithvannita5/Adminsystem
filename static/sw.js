// ============================================================
// SERVICE WORKER - Online/Offline + Sync
// ============================================================

const CACHE_NAME = 'admin-system-v2';
const OFFLINE_URL = '/offline';

// ===== ឯកសារដែលត្រូវ Cache =====
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
    '/manifest.json',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
    'https://fonts.googleapis.com/css2?family=Khmer&display=swap',
    'https://cdn.jsdelivr.net/npm/chart.js'
];

// ============================================================
// OFFLINE QUEUE - IndexedDB
// ============================================================
const DB_NAME = 'OfflineQueueDB';
const STORE_NAME = 'requests';

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
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

async function saveOfflineRequest(request, body) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        
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
        
        console.log('[SW] ✅ Saved offline request:', request.url);
        return true;
    } catch (error) {
        console.error('[SW] ❌ Error saving offline request:', error);
        return false;
    }
}

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
            console.log('[SW] 📭 No offline items to sync');
            return;
        }
        
        console.log(`[SW] 🔄 Syncing ${items.length} items...`);
        
        let syncedCount = 0;
        for (const item of items) {
            try {
                const response = await fetch(item.url, {
                    method: item.method,
                    headers: item.headers,
                    body: item.body
                });
                
                if (response.ok) {
                    const delTx = db.transaction(STORE_NAME, 'readwrite');
                    const delStore = delTx.objectStore(STORE_NAME);
                    delStore.delete(item.id);
                    await new Promise((resolve) => { delTx.oncomplete = resolve; });
                    syncedCount++;
                    console.log(`[SW] ✅ Synced: ${item.url}`);
                } else {
                    console.warn(`[SW] ⚠️ Sync failed (${response.status}): ${item.url}`);
                }
            } catch (error) {
                console.error(`[SW] ❌ Error syncing ${item.url}:`, error);
            }
        }
        
        if (syncedCount > 0) {
            const clients = await self.clients.matchAll();
            clients.forEach(client => {
                client.postMessage({
                    type: 'SYNC_COMPLETE',
                    count: syncedCount,
                    message: `✅ Sync បាន ${syncedCount} កំណត់ត្រារួចរាល់!`
                });
            });
        }
        
    } catch (error) {
        console.error('[SW] ❌ Sync error:', error);
    }
}

// ============================================================
// INSTALL
// ============================================================
self.addEventListener('install', event => {
    console.log('[SW] 📦 Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[SW] 💾 Caching static assets...');
                return cache.addAll(STATIC_FILES);
            })
            .then(() => {
                console.log('[SW] ✅ Installation complete!');
                return self.skipWaiting();
            })
            .catch(error => {
                console.error('[SW] ❌ Installation failed:', error);
            })
    );
});

// ============================================================
// ACTIVATE
// ============================================================
self.addEventListener('activate', event => {
    console.log('[SW] 🚀 Activating...');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(name => {
                    if (name !== CACHE_NAME) {
                        console.log('[SW] 🗑️ Deleting old cache:', name);
                        return caches.delete(name);
                    }
                })
            );
        }).then(() => {
            console.log('[SW] ✅ Activation complete!');
            return self.clients.claim();
        })
    );
});

// ============================================================
// FETCH - Main Request Handler
// ============================================================
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // ===== API Requests: Network-first with offline queue =====
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(handleApiRequest(event.request));
        return;
    }

    // ===== Static Assets: Cache-first =====
    if (url.pathname.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/)) {
        event.respondWith(handleStaticRequest(event.request));
        return;
    }

    // ===== HTML Pages: Network-first with cache fallback =====
    event.respondWith(handlePageRequest(event.request));
});

// ============================================================
// REQUEST HANDLERS
// ============================================================

// ===== API Request Handler =====
async function handleApiRequest(request) {
    // Clone request for potential offline storage
    let requestClone = request.clone();
    let body = null;
    
    try {
        // Try to fetch from network
        const response = await fetch(request);
        return response;
    } catch (error) {
        console.log('[SW] 📡 Offline - Saving API request to queue');
        
        // Save request to offline queue
        try {
            body = await requestClone.text();
        } catch (e) {
            body = null;
        }
        
        await saveOfflineRequest(requestClone, body);
        
        // Return offline response
        return new Response(JSON.stringify({
            success: true,
            offline: true,
            queued: true,
            message: '📡 គ្មានបណ្តាញ! ទិន្នន័យត្រូវបានរក្សាទុកក្នុងស្រុក នឹង Sync ពេលមានបណ្តាញ'
        }), {
            headers: { 
                'Content-Type': 'application/json',
                'X-Offline': 'true'
            },
            status: 200
        });
    }
}

// ===== Static Request Handler =====
async function handleStaticRequest(request) {
    // Try cache first
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
        console.log('[SW] ❌ Static resource not available offline:', request.url);
        return new Response('Resource not available offline', { status: 404 });
    }
}

// ===== Page Request Handler =====
async function handlePageRequest(request) {
    try {
        // Try network first
        const response = await fetch(request);
        if (response.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
        }
        return response;
    } catch (error) {
        console.log('[SW] 📡 Offline - Serving cached page');
        
        // Try cache
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }
        
        // Fallback to offline page
        const offlineResponse = await caches.match('/offline');
        if (offlineResponse) {
            return offlineResponse;
        }
        
        // Final fallback
        return new Response(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Offline</title>
                <style>
                    body {
                        font-family: 'Khmer', 'Khmer OS', sans-serif;
                        background: #1a1a2e;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        min-height: 100vh;
                        margin: 0;
                        color: white;
                        text-align: center;
                        padding: 20px;
                    }
                    .box {
                        background: rgba(255,255,255,0.05);
                        padding: 50px 40px;
                        border-radius: 20px;
                        border: 1px solid rgba(255,255,255,0.08);
                        max-width: 400px;
                    }
                    .box i {
                        font-size: 64px;
                        color: #FFD700;
                        margin-bottom: 20px;
                    }
                    .box h1 {
                        font-size: 28px;
                        margin-bottom: 10px;
                    }
                    .box p {
                        color: rgba(255,255,255,0.5);
                        font-size: 14px;
                        line-height: 1.6;
                    }
                    .box .btn {
                        display: inline-block;
                        margin-top: 20px;
                        padding: 12px 30px;
                        background: #FFD700;
                        color: #1a1a2e;
                        text-decoration: none;
                        border-radius: 10px;
                        font-weight: bold;
                        font-family: 'Khmer', 'Khmer OS', sans-serif;
                    }
                    .box .btn:hover {
                        background: #f0c000;
                    }
                </style>
            </head>
            <body>
                <div class="box">
                    <i class="fas fa-wifi-slash"></i>
                    <h1>📡 គ្មានការតភ្ជាប់</h1>
                    <p>សូមពិនិត្យមើលការតភ្ជាប់អ៊ីនធឺណិតរបស់អ្នក<br>
                    ទិន្នន័យនឹងត្រូវបានរក្សាទុកក្នុងស្រុក និង Sync ស្វ័យប្រវត្តិពេលមានបណ្តាញ</p>
                    <a href="/dashboard" class="btn"><i class="fas fa-arrow-left"></i> ត្រឡប់ទៅ Dashboard</a>
                </div>
            </body>
            </html>
        `, {
            headers: { 'Content-Type': 'text/html' },
            status: 503
        });
    }
}

// ============================================================
// NETWORK STATUS EVENTS
// ============================================================

// ===== Online - Sync immediately =====
self.addEventListener('online', () => {
    console.log('[SW] 📡 Online detected!');
    // Notify clients
    self.clients.matchAll().then(clients => {
        clients.forEach(client => {
            client.postMessage({
                type: 'ONLINE',
                message: '✅ បណ្តាញត្រឡប់មកវិញហើយ! កំពុង Sync...'
            });
        });
    });
    // Sync offline queue
    syncOfflineQueue();
});

// ===== Offline - Notify clients =====
self.addEventListener('offline', () => {
    console.log('[SW] 📡 Offline detected');
    self.clients.matchAll().then(clients => {
        clients.forEach(client => {
            client.postMessage({
                type: 'OFFLINE',
                message: '📡 គ្មានបណ្តាញ! ទិន្នន័យនឹងត្រូវរក្សាទុកក្នុងស្រុក'
            });
        });
    });
});

// ============================================================
// MESSAGE HANDLER
// ============================================================
self.addEventListener('message', event => {
    if (event.data) {
        switch (event.data.type) {
            case 'SKIP_WAITING':
                self.skipWaiting();
                break;
            case 'SYNC_OFFLINE':
                console.log('[SW] 🔄 Manual sync triggered');
                syncOfflineQueue();
                break;
            case 'GET_QUEUE_STATUS':
                getQueueStatus(event);
                break;
        }
    }
});

// ===== Get queue status =====
async function getQueueStatus(event) {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        
        const count = await new Promise((resolve) => {
            const request = store.count();
            request.onsuccess = () => resolve(request.result);
        });
        
        event.ports[0].postMessage({
            queueSize: count,
            online: navigator.onLine
        });
    } catch (error) {
        event.ports[0].postMessage({
            queueSize: 0,
            online: navigator.onLine,
            error: error.message
        });
    }
}

// ============================================================
// PERIODIC SYNC (every 30 seconds)
// ============================================================
setInterval(() => {
    if (navigator.onLine) {
        syncOfflineQueue();
    }
}, 30000);

// ============================================================
// LOG
// ============================================================
console.log('[SW] ✅ Service Worker initialized successfully!');
console.log('[SW] 📦 Cache Name:', CACHE_NAME);
console.log('[SW] 📡 Online:', navigator.onLine);