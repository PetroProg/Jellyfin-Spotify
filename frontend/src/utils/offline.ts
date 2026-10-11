import { Track } from '../types';

const CACHE_NAME = 'jellyfin-spotify-audio-cache';
const OFFLINE_PLAYLISTS_KEY = 'offline_playlists_ids';

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

export async function downloadPlaylistOffline(
  playlistId: number,
  tracks: Track[],
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  if (!('caches' in window)) {
    throw new Error('Кеширование не поддерживается вашим браузером');
  }

  const cache = await caches.open(CACHE_NAME);
  let done = 0;

  for (const track of tracks) {
    const streamUrl = `/api/stream/${track.id}`;
    const match = await cache.match(streamUrl);
    if (!match) {
      try {
        const res = await fetch(streamUrl);
        if (res.ok || res.status === 206) {
          await cache.put(streamUrl, res);
        }
      } catch (err) {
        console.warn(`[Offline Cache] Error caching track ${track.title}:`, err);
      }
    }
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

export async function removePlaylistOffline(playlistId: number, tracks: Track[]): Promise<void> {
  if (!('caches' in window)) return;
  const cache = await caches.open(CACHE_NAME);

  for (const track of tracks) {
    await cache.delete(`/api/stream/${track.id}`);
  }

  const ids = getOfflinePlaylistIds().filter(id => id !== playlistId);
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
  localStorage.removeItem(OFFLINE_PLAYLISTS_KEY);
}
