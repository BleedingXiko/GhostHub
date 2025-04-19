// Service Worker for GhostHub PWA
const CACHE_NAME = 'ghosthub-pwa-v1';

// Install event - triggered when the service worker is installed
self.addEventListener('install', (event) => {
  console.log('Service Worker: Installed');
  
  // Skip waiting to ensure the new service worker activates immediately
  self.skipWaiting();
});

// Activate event - triggered when the service worker is activated
self.addEventListener('activate', (event) => {
  console.log('Service Worker: Activated');
  
  // Claim clients to ensure the service worker takes control immediately
  event.waitUntil(clients.claim());
});

// Fetch event - triggered when the app makes a network request
// Since we don't need offline functionality, we'll just pass through all requests
self.addEventListener('fetch', (event) => {
  // Pass through all requests to the network
  event.respondWith(fetch(event.request));
});
