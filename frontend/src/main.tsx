/// <reference types="vite-plugin-pwa/client" />
import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './index.css';

// Instant PWA Auto-update handler: checks for updates on startup, focus, and back online
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    console.log('[PWA] New version available, reloading to apply updates...');
    updateSW(true);
  },
  onOfflineReady() {
    console.log('[PWA] Application ready to work offline');
  },
  onRegistered(registration?: ServiceWorkerRegistration) {
    if (registration) {
      // 1. Immediately trigger an update check on startup
      registration.update().catch(() => {});

      // 2. Check for updates whenever user returns to the app / focuses the tab
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          registration.update().catch(() => {});
        }
      });

      // 3. Check for updates whenever internet connectivity returns
      window.addEventListener('online', () => {
        registration.update().catch(() => {});
      });

      // 4. Periodic background update check every 10 minutes
      setInterval(() => {
        registration.update().catch(() => {});
      }, 10 * 60 * 1000);
    }
  },
});

// Auto-reload once new service worker takes over clients
if ('serviceWorker' in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
