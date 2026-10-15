import { Track } from '../types';

export const CACHE_NAME = 'jellyfin-spotify-audio-cache';
const OFFLINE_PLAYLISTS_KEY = 'offline_playlists_ids';

// In-memory registry of active Blob URLs for zero-latency instant playback
const activeBlobUrls = new Map<number, string>();

export function getOfflinePlaylistIds(): number[] {
  try {
    const raw = localStorage.getItem(OFFLINE_PLAYLISTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function isPlaylistDownloaded(playlistId: number): boolean {
  return getOfflinePlaylistIds().includes(playlistId);
}

/**
 * Returns a local blob URL for instant 0ms playback if track is in offline cache.
 * Returns null if not cached (falling back to remote streaming).
 */
export async function getCachedTrackUrl(trackId: number): Promise<string | null> {
  if (typeof window === 'undefined' || !('caches' in window)) return null;

  if (activeBlobUrls.has(trackId)) {
    return activeBlobUrls.get(trackId)!;
  }

  try {
    const cache = await caches.open(CACHE_NAME);
    const match = await cache.match(`/api/stream/${trackId}`);
    if (match) {
      const blob = await match.blob();
      if (blob && blob.size > 1024) {
        const blobUrl = URL.createObjectURL(blob);
        activeBlobUrls.set(trackId, blobUrl);
        return blobUrl;
      }
    }
  } catch (err) {
    console.warn('[Offline Cache lookup error]:', err);
  }
  return null;
}

/**
 * Checks whether track is already saved in local offline cache.
 */
export async function isTrackCached(trackId: number): Promise<boolean> {
  if (typeof window === 'undefined' || !('caches' in window)) return false;
  if (activeBlobUrls.has(trackId)) return true;

  try {
    const cache = await caches.open(CACHE_NAME);
    const match = await cache.match(`/api/stream/${trackId}`);
    return !!match;
  } catch {
    return false;
  }
}

/**
 * Downloads a single track cleanly into CacheStorage without partial range errors.
 */
export async function cacheTrackOffline(track: Track): Promise<boolean> {
  if (typeof window === 'undefined' || !('caches' in window) || !track || !track.id) return false;

  const streamUrl = `/api/stream/${track.id}`;
  try {
    const cache = await caches.open(CACHE_NAME);
    const existing = await cache.match(streamUrl);
    if (existing) {
      return true;
    }

    // Explicitly request full file without Range headers to obtain clean 200 response
    const res = await fetch(streamUrl, {
      headers: {
        'Cache-Control': 'no-cache',
      },
    });

    if (res.ok && (res.status === 200 || res.status === 0)) {
      await cache.put(streamUrl, res);

      // Cache cover art if available
      if (track.cover_url && !track.cover_url.startsWith('data:')) {
        try {
          const coverMatch = await cache.match(track.cover_url);
          if (!coverMatch) {
            const coverRes = await fetch(track.cover_url);
            if (coverRes.ok) {
              await cache.put(track.cover_url, coverRes);
            }
          }
        } catch (_) {}
      }

      return true;
    }
    return false;
  } catch (err) {
    console.warn(`[Offline Cache] Error caching track ${track.title}:`, err);
    return false;
  }
}

/**
 * Downloads all tracks in a playlist.
 */
export async function downloadPlaylistOffline(
  playlistId: number,
  tracks: Track[],
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  if (!('caches' in window)) {
    throw new Error('Кеширование не поддерживается вашим браузером');
  }

  let done = 0;
  for (const track of tracks) {
    await cacheTrackOffline(track);
    done++;
    if (onProgress) {
      onProgress(done, tracks.length);
    }
  }

  const ids = getOfflinePlaylistIds();
  if (!ids.includes(playlistId)) {
    ids.push(playlistId);
    localStorage.setItem(OFFLINE_PLAYLISTS_KEY, JSON.stringify(ids));
  }
}

/**
 * Syncs a downloaded playlist by fetching and caching only the tracks that are not yet stored locally.
 */
export async function syncDownloadedPlaylist(
  playlistId: number,
  tracks: Track[],
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  if (!isPlaylistDownloaded(playlistId) || !tracks || tracks.length === 0) return 0;
  if (!('caches' in window)) return 0;

  const missingTracks: Track[] = [];
  for (const t of tracks) {
    const cached = await isTrackCached(t.id);
    if (!cached) {
      missingTracks.push(t);
    }
  }

  if (missingTracks.length === 0) return 0;

  let downloadedCount = 0;
  for (const t of missingTracks) {
    const success = await cacheTrackOffline(t);
    if (success) downloadedCount++;
    if (onProgress) {
      onProgress(downloadedCount, missingTracks.length);
    }
  }

  return downloadedCount;
}

/**
 * Removes downloaded playlist and revokes its memory Blob URLs.
 */
export async function removePlaylistOffline(playlistId: number, tracks: Track[]): Promise<void> {
  if (!('caches' in window)) return;
  const cache = await caches.open(CACHE_NAME);

  for (const track of tracks) {
    const streamUrl = `/api/stream/${track.id}`;
    await cache.delete(streamUrl);
    const blobUrl = activeBlobUrls.get(track.id);
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      activeBlobUrls.delete(track.id);
    }
  }

  const ids = getOfflinePlaylistIds().filter((id) => id !== playlistId);
  localStorage.setItem(OFFLINE_PLAYLISTS_KEY, JSON.stringify(ids));
}

export async function getOfflineStorageUsage(): Promise<string> {
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    const usedMB = ((estimate.usage || 0) / (1024 * 1024)).toFixed(1);
    return `${usedMB} МБ`;
  }
  return 'Около 150 МБ';
}

export async function clearAllOfflineCache(): Promise<void> {
  if ('caches' in window) {
    await caches.delete(CACHE_NAME);
  }
  for (const url of activeBlobUrls.values()) {
    URL.revokeObjectURL(url);
  }
  activeBlobUrls.clear();
  localStorage.removeItem(OFFLINE_PLAYLISTS_KEY);
}
