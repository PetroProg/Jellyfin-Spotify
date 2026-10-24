import { Playlist, Track } from '../types';
import { tr, td } from '../store/i18nStore';

export const CACHE_NAME = 'jellyfin-spotify-audio-cache';
export const OFFLINE_PLAYLISTS_KEY = 'offline_playlists_ids';
export const OFFLINE_PLAYLIST_PREFIX = 'jellyfy_offline_playlist_';
export const ALL_PLAYLISTS_CACHE_KEY = 'jellyfy_all_playlists_cache';
export const DOWNLOAD_QUEUE_KEY = 'jellyfy_download_queue';

// In-memory registry of active Blob URLs for zero-latency instant playback
const activeBlobUrls = new Map<number, string>();

export interface QueuedDownloadJob {
  playlistId: number;
  playlist?: Playlist;
  tracks: Track[];
  startedAt: number;
  totalTracks: number;
  status: 'downloading' | 'completed' | 'paused';
  usedBackgroundFetch?: boolean;
}

export function getSynchronousBlobUrl(trackId: number): string | null {
  return activeBlobUrls.get(trackId) || null;
}

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

export function markPlaylistDownloaded(playlistId: number): void {
  try {
    const ids = getOfflinePlaylistIds();
    if (!ids.includes(playlistId)) {
      ids.push(playlistId);
      localStorage.setItem(OFFLINE_PLAYLISTS_KEY, JSON.stringify(ids));
    }
  } catch (err) {
    console.warn('[Offline] Failed to mark playlist downloaded:', err);
  }
}

export function unmarkPlaylistDownloaded(playlistId: number): void {
  try {
    const ids = getOfflinePlaylistIds().filter((id) => id !== playlistId);
    localStorage.setItem(OFFLINE_PLAYLISTS_KEY, JSON.stringify(ids));
  } catch (err) {
    console.warn('[Offline] Failed to unmark playlist downloaded:', err);
  }
}

export function getDownloadQueue(): Record<number, QueuedDownloadJob> {
  try {
    const raw = localStorage.getItem(DOWNLOAD_QUEUE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveDownloadQueue(queue: Record<number, QueuedDownloadJob>): void {
  try {
    localStorage.setItem(DOWNLOAD_QUEUE_KEY, JSON.stringify(queue));
  } catch (err) {
    console.warn('[Offline] Failed to save download queue:', err);
  }
}

export function removeDownloadQueueItem(playlistId: number): void {
  const queue = getDownloadQueue();
  if (queue[playlistId]) {
    delete queue[playlistId];
    saveDownloadQueue(queue);
  }
}

export function saveAllPlaylistsCache(playlists: Playlist[]): void {
  try {
    localStorage.setItem(ALL_PLAYLISTS_CACHE_KEY, JSON.stringify(playlists));
  } catch (err) {
    console.warn('[Offline] Failed to save all playlists cache:', err);
  }
}

export function getAllPlaylistsCache(): Playlist[] {
  try {
    const raw = localStorage.getItem(ALL_PLAYLISTS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveOfflinePlaylistData(
  playlist: Playlist,
  tracks: Track[],
  markDownloaded = false
): void {
  try {
    const key = `${OFFLINE_PLAYLIST_PREFIX}${playlist.id}`;
    const payload = {
      playlist,
      tracks,
      updatedAt: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(payload));

    if (markDownloaded) {
      markPlaylistDownloaded(playlist.id);
    }
  } catch (err) {
    console.warn(`[Offline] Failed to save offline playlist data for ${playlist.id}:`, err);
  }
}

export function getOfflinePlaylistData(
  playlistId: number
): { playlist: Playlist; tracks: Track[] } | null {
  try {
    const raw = localStorage.getItem(`${OFFLINE_PLAYLIST_PREFIX}${playlistId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function addTrackToOfflinePlaylist(
  playlistId: number,
  track: Track,
  playlistFallback?: Playlist
): void {
  try {
    const existing = getOfflinePlaylistData(playlistId);
    let playlist = existing?.playlist || playlistFallback;
    if (!playlist) {
      if (playlistId === -1) {
        playlist = {
          id: -1,
          name: tr('Liked Songs', 'Любимые треки'),
          description: tr('Your library of saved tracks', 'Ваша медиатека сохраненных композиций'),
          created_at: new Date().toISOString(),
          track_count: 0,
        };
      } else {
        playlist = {
          id: playlistId,
          name: tr('Playlist', 'Плейлист'),
          created_at: new Date().toISOString(),
          track_count: 0,
        };
      }
    }
    const currentTracks = existing?.tracks || [];
    if (!currentTracks.some((t) => t.id === track.id)) {
      const updatedTracks = [track, ...currentTracks];
      const updatedPlaylist = { ...playlist, track_count: updatedTracks.length };
      saveOfflinePlaylistData(updatedPlaylist, updatedTracks);
    }
  } catch (err) {
    console.warn(`[Offline] Failed to add track to offline playlist ${playlistId}:`, err);
  }
}

export function removeTrackFromOfflinePlaylist(playlistId: number, trackId: number): void {
  try {
    const existing = getOfflinePlaylistData(playlistId);
    if (!existing) return;
    const updatedTracks = existing.tracks.filter((t) => t.id !== trackId);
    const updatedPlaylist = { ...existing.playlist, track_count: updatedTracks.length };
    saveOfflinePlaylistData(updatedPlaylist, updatedTracks);
  } catch (err) {
    console.warn(`[Offline] Failed to remove track from offline playlist ${playlistId}:`, err);
  }
}

/**
 * Checks whether a track should be automatically downloaded to device cache
 * based on whether downloading is enabled in the target playlist, liked tracks,
 * or ANY playlist currently saved for offline playback.
 */
export function shouldTrackBeCachedOffline(
  trackId: number,
  targetPlaylistId?: number,
  likedTrackIds?: number[]
): boolean {
  try {
    const downloadedIds = getOfflinePlaylistIds();
    if (!downloadedIds || downloadedIds.length === 0) return false;

    // 1. If target playlist has offline download enabled
    if (targetPlaylistId !== undefined && downloadedIds.includes(targetPlaylistId)) {
      return true;
    }

    // 2. If Liked Songs (-1) has offline download enabled
    if (downloadedIds.includes(-1)) {
      if (targetPlaylistId === -1) return true;
      if (likedTrackIds && likedTrackIds.includes(trackId)) return true;
    }

    // 3. If track exists in ANY currently saved offline playlist on this device
    for (const pId of downloadedIds) {
      const data = getOfflinePlaylistData(pId);
      if (data && data.tracks && data.tracks.some((t) => t.id === trackId)) {
        return true;
      }
    }

    return false;
  } catch (err) {
    console.warn('[Offline] shouldTrackBeCachedOffline error:', err);
    return false;
  }
}

export function getAllOfflinePlaylists(): Playlist[] {
  const ids = getOfflinePlaylistIds();
  const list: Playlist[] = [];
  for (const id of ids) {
    if (id === -1) {
      const data = getOfflinePlaylistData(-1);
      if (data && data.playlist) {
        list.push(data.playlist);
      } else {
        list.push({
          id: -1,
          name: tr('Liked Songs', 'Любимые треки'),
          description: tr('Your library of saved tracks', 'Ваша медиатека сохраненных композиций'),
          created_at: new Date().toISOString(),
          track_count: data?.tracks?.length || 0,
        });
      }
    } else {
      const data = getOfflinePlaylistData(id);
      if (data && data.playlist) {
        list.push(data.playlist);
      }
    }
  }
  return list;
}

/**
 * Attempts to trigger the standard Background Fetch API (supported in Chromium browsers & Android PWAs).
 * This allows downloads to continue seamlessly via the OS download manager even if the user
 * completely closes the browser or swipes away the PWA.
 */
export async function tryStartBackgroundFetch(
  playlistId: number,
  tracks: Track[],
  playlistName?: string
): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return false;
  try {
    const reg: any = await navigator.serviceWorker.ready;
    if (!reg || !('backgroundFetch' in reg)) return false;

    const bgFetchId = `jellyfy-dl-${playlistId}`;
    try {
      const existing = await reg.backgroundFetch.get(bgFetchId);
      if (existing) {
        return true;
      }
    } catch (_) {}

    const requests = tracks.map((t) => `/api/stream/${t.id}`);
    const displayTitle = playlistName
      ? tr(`Downloading: ${td(playlistName)}`, `Загрузка: ${playlistName}`)
      : tr('Downloading music for offline', 'Загрузка музыки в оффлайн');
    await reg.backgroundFetch.fetch(bgFetchId, requests, {
      title: displayTitle,
      icons: [{ src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' }],
      downloadTotal: tracks.length * 4 * 1024 * 1024, // Estimate ~4MB per track
    });

    return true;
  } catch (err) {
    console.warn('[Offline] BackgroundFetch not available or denied:', err);
    return false;
  }
}

/**
 * Checks how many tracks from the list are already present in CacheStorage.
 */
export async function countCachedTracks(tracks: Track[]): Promise<number> {
  if (typeof window === 'undefined' || !('caches' in window) || !tracks || tracks.length === 0) return 0;
  try {
    const cache = await caches.open(CACHE_NAME);
    let count = 0;
    for (const track of tracks) {
      if (activeBlobUrls.has(track.id)) {
        count++;
        continue;
      }
      const match = await cache.match(`/api/stream/${track.id}`);
      if (match) count++;
    }
    return count;
  } catch {
    return 0;
  }
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
        // Keep up to 6 blob URLs active in memory for seamless queue prebuffering
        if (activeBlobUrls.size >= 6) {
          const oldestKey = activeBlobUrls.keys().next().value;
          if (oldestKey !== undefined) {
            try {
              URL.revokeObjectURL(activeBlobUrls.get(oldestKey)!);
            } catch (_) {}
            activeBlobUrls.delete(oldestKey);
          }
        }
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
 * Downloads a single track cleanly into CacheStorage without partial range errors,
 * with timeout and abort resilience.
 */
export async function cacheTrackOffline(
  track: Track,
  timeoutMs = 25000,
  externalSignal?: AbortSignal
): Promise<boolean> {
  if (typeof window === 'undefined' || !('caches' in window) || !track || !track.id) return false;

  const streamUrl = `/api/stream/${track.id}`;
  try {
    const cache = await caches.open(CACHE_NAME);
    const existing = await cache.match(streamUrl);
    if (existing) {
      return true;
    }

    if (externalSignal && externalSignal.aborted) {
      return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const onExternalAbort = () => {
      clearTimeout(timer);
      controller.abort();
    };

    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      // Explicitly request full file without Range headers to obtain clean 200 response
      const res = await fetch(streamUrl, {
        signal: controller.signal,
        headers: {
          'Cache-Control': 'no-cache',
        },
      });

      if (res.ok && (res.status === 200 || res.status === 0)) {
        await cache.put(streamUrl, res);

        // Preload cover art non-blockingly
        if (track.cover_url && !track.cover_url.startsWith('data:')) {
          cache.match(track.cover_url).then((coverMatch) => {
            if (!coverMatch) {
              fetch(track.cover_url!, { signal: AbortSignal.timeout(6000) })
                .then((cRes) => {
                  if (cRes.ok) cache.put(track.cover_url!, cRes);
                })
                .catch(() => {});
            }
          }).catch(() => {});
        }

        return true;
      }
      return false;
    } finally {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      console.warn(`[Offline Cache] Error caching track ${track.title}:`, err);
    }
    return false;
  }
}

/**
 * Proactively pre-warms Blob URLs in memory for upcoming tracks in queue
 */
export function prewarmQueueBlobUrls(tracks: Track[], startIndex: number, count = 2): void {
  if (typeof window === 'undefined' || !tracks || tracks.length === 0) return;
  const end = Math.min(tracks.length, startIndex + count);
  for (let i = startIndex; i < end; i++) {
    const t = tracks[i];
    if (t && t.id) {
      getCachedTrackUrl(t.id).catch(() => {});
    }
  }
}

/**
 * Downloads all tracks in a playlist and persists its metadata locally for offline access.
 */
export async function downloadPlaylistOffline(
  playlistId: number,
  tracks: Track[],
  playlist?: Playlist,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  if (!('caches' in window)) {
    throw new Error(tr('Caching is not supported by your browser', 'Кеширование не поддерживается вашим браузером'));
  }

  // Pre-save metadata so offline views are immediately populated
  if (playlist) {
    saveOfflinePlaylistData(playlist, tracks);
  }

  let done = await countCachedTracks(tracks);
  if (onProgress) {
    onProgress(done, tracks.length);
  }

  for (const track of tracks) {
    const isCached = await isTrackCached(track.id);
    if (!isCached) {
      await cacheTrackOffline(track);
      done++;
      if (onProgress) {
        onProgress(done, tracks.length);
      }
    }
  }

  markPlaylistDownloaded(playlistId);
  removeDownloadQueueItem(playlistId);
  if (playlist) {
    saveOfflinePlaylistData(playlist, tracks, true);
  }
}

/**
 * Syncs a downloaded playlist by fetching and caching only the tracks that are not yet stored locally.
 */
export async function syncDownloadedPlaylist(
  playlistId: number,
  tracks: Track[],
  playlist?: Playlist,
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  if (!isPlaylistDownloaded(playlistId) || !tracks || tracks.length === 0) return 0;
  if (!('caches' in window)) return 0;

  if (playlist) {
    saveOfflinePlaylistData(playlist, tracks);
  }

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
    await cache.delete(streamUrl).catch(() => {});
    const blobUrl = activeBlobUrls.get(track.id);
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      activeBlobUrls.delete(track.id);
    }
  }

  unmarkPlaylistDownloaded(playlistId);
  removeDownloadQueueItem(playlistId);
  try {
    localStorage.removeItem(`${OFFLINE_PLAYLIST_PREFIX}${playlistId}`);
  } catch (_) {}
}

export async function getOfflineStorageUsage(): Promise<string> {
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    const usedMB = ((estimate.usage || 0) / (1024 * 1024)).toFixed(1);
    return tr(`${usedMB} MB`, `${usedMB} МБ`);
  }
  return tr('About 150 MB', 'Около 150 МБ');
}

export async function clearAllOfflineCache(): Promise<void> {
  if ('caches' in window) {
    await caches.delete(CACHE_NAME);
  }
  for (const url of activeBlobUrls.values()) {
    URL.revokeObjectURL(url);
  }
  activeBlobUrls.clear();

  const ids = getOfflinePlaylistIds();
  for (const id of ids) {
    try {
      localStorage.removeItem(`${OFFLINE_PLAYLIST_PREFIX}${id}`);
    } catch (_) {}
  }
  localStorage.removeItem(OFFLINE_PLAYLISTS_KEY);
  localStorage.removeItem(ALL_PLAYLISTS_CACHE_KEY);
  localStorage.removeItem(DOWNLOAD_QUEUE_KEY);
}
