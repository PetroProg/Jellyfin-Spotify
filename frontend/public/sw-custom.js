// Jellyfy Custom Service Worker Extensions
// Handles Background Fetch API and background offline caching

const AUDIO_CACHE_NAME = 'jellyfin-spotify-audio-cache';

// 1. Background Fetch API events (for Chromium browsers / Android PWA)
// Allows downloading to continue even after the app/browser is closed!
self.addEventListener('backgroundfetchsuccess', (event) => {
  const bgFetch = event.registration;
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(AUDIO_CACHE_NAME);
        const records = await bgFetch.matchAll();

        for (const record of records) {
          try {
            const response = await record.responseReady;
            if (response && (response.ok || response.status === 200 || response.status === 0)) {
              await cache.put(record.request, response);
            }
          } catch (recErr) {
            console.warn('[SW BG Fetch] Failed to write record to cache:', recErr);
          }
        }

        try {
          await bgFetch.updateUI({ title: 'Загрузка плейлиста завершена' });
        } catch (_) {}

        // Broadcast to all open clients that background fetch is complete
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clients) {
          client.postMessage({
            type: 'BG_FETCH_SUCCESS',
            id: bgFetch.id,
          });
        }
      } catch (err) {
        console.error('[SW BG Fetch Error]:', err);
      }
    })()
  );
});

self.addEventListener('backgroundfetchfail', (event) => {
  console.warn('[SW BG Fetch Failed]:', event.registration.id);
});

self.addEventListener('backgroundfetchabort', (event) => {
  console.warn('[SW BG Fetch Aborted]:', event.registration.id);
});

self.addEventListener('backgroundfetchclick', (event) => {
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.length > 0) {
        return clients[0].focus();
      }
      return self.clients.openWindow('/');
    })()
  );
});

// 2. Direct Service Worker caching with event.waitUntil
// Keeps the Service Worker alive while downloading tracks when client sends message
self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'CACHE_TRACKS_IN_BACKGROUND') {
    const { tracks, playlistId } = event.data;
    if (!tracks || !Array.isArray(tracks)) return;

    event.waitUntil(
      (async () => {
        try {
          const cache = await caches.open(AUDIO_CACHE_NAME);
          for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            const streamUrl = `/api/stream/${track.id}`;
            const existing = await cache.match(streamUrl);

            if (!existing) {
              try {
                const res = await fetch(streamUrl, {
                  headers: { 'Cache-Control': 'no-cache' },
                });
                if (res.ok && (res.status === 200 || res.status === 0)) {
                  await cache.put(streamUrl, res);
                }
              } catch (err) {
                console.warn('[SW BG Cache] Failed to cache track:', track.id, err);
              }
            }

            // Post progress update
            const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            for (const client of clients) {
              client.postMessage({
                type: 'BG_CACHE_PROGRESS',
                playlistId,
                done: i + 1,
                total: tracks.length,
                trackId: track.id,
              });
            }
          }

          // Complete
          const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          for (const client of clients) {
            client.postMessage({
              type: 'BG_CACHE_COMPLETE',
              playlistId,
            });
          }
        } catch (err) {
          console.error('[SW BG Cache Error]:', err);
        }
      })()
    );
  }
});
