/// <reference types="vite-plugin-pwa/client" />
import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { isPlaybackActive } from './store/playerStore';
import App from './App';
import './index.css';

// Flag indicating that an update was detected while songs were playing and must be deferred
let updatePostponed = false;

// PWA update handler: checks for updates on startup, focus, and back online
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    if (isPlaybackActive()) {
      console.log('[PWA] New version available, but songs are currently playing. Postponing update until browser reload.');
      updatePostponed = true;
      return;
    }
    console.log('[PWA] New version available, reloading to apply updates...');
    updateSW(true);
  },
  onOfflineReady() {
    console.log('[PWA] Application ready to work offline');
  },
  onRegistered(registration?: ServiceWorkerRegistration) {
    if (registration) {
      // If a new worker is waiting and no songs are playing, activate immediately
      if (registration.waiting && !isPlaybackActive()) {
        console.log('[PWA] Service worker waiting found on startup. Applying update...');
        updateSW(true);
      }

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
// Suppressed if music is currently playing or if the update was postponed until manual browser reload
if ('serviceWorker' in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    if (isPlaybackActive() || updatePostponed) {
      console.log('[PWA] Service worker updated, but playback is active or update was postponed. Reload suppressed until browser reload.');
      return;
    }
    refreshing = true;
    window.location.reload();
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
