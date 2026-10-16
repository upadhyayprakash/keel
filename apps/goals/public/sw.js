// Goals service worker. For now it only makes the app installable; the offline
// shell and push handling come with their features (ADR 0004).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
