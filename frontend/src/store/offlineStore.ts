import { create } from 'zustand';
import { Playlist, Track } from '../types';
import {
  getOfflinePlaylistIds,
  removePlaylistOffline,
  cacheTrackOffline,
  cacheTrackWithRetry,
  syncDownloadedPlaylist,
  saveOfflinePlaylistData,
  addTrackToOfflinePlaylist,
  removeTrackFromOfflinePlaylist,
  getDownloadQueue,
  saveDownloadQueue,
  removeDownloadQueueItem,
  tryStartBackgroundFetch,
  partitionCachedTracks,
  clearFailedTrackCooldowns,
  isTrackInFailedCooldown,
  isTrackCached,
  markPlaylistDownloaded,
  addCachedTrackId,
} from '../utils/offline';
import { apiRequest } from '../api/client';
import { toast } from './toastStore';
import { tr, td } from './i18nStore';

export interface OfflineJobProgress {
  inProgress: boolean;
  done: number;
  total: number;
}

interface OfflineStoreState {
  downloadedIds: number[];
  progress: Record<number, OfflineJobProgress>;

  loadDownloaded: () => void;
  isDownloaded: (playlistId: number) => boolean;
  getProgress: (playlistId: number) => OfflineJobProgress | null;
  updateProgress: (playlistId: number, done: number, total: number) => void;
  startDownload: (playlistId: number, tracks: Track[], playlist?: Playlist) => Promise<void>;
  removeDownload: (playlistId: number, tracks: Track[]) => Promise<void>;
  cacheTrack: (track: Track) => Promise<boolean>;
  addTrackToOffline: (playlistId: number, track: Track, playlist?: Playlist) => Promise<boolean>;
  removeTrackFromOffline: (playlistId: number, trackId: number) => void;
  syncPlaylist: (playlistId: number, tracks: Track[], playlist?: Playlist) => Promise<void>;
  syncAllDownloadedPlaylists: () => Promise<void>;
  resumePendingDownloads: () => Promise<void>;
}

// Active abort controllers for cancellable in-flight window downloads
const activeAbortControllers = new Map<number, AbortController>();
const activeSyncPlaylists = new Set<number>();
let isSyncingAllPlaylists = false;

async function runQueueWorker(playlistId: number, tracks: Track[], playlist?: Playlist): Promise<void> {
  if (activeAbortControllers.has(playlistId)) return;

  const abortController = new AbortController();
  activeAbortControllers.set(playlistId, abortController);

  try {
    const validTracks = tracks.filter((t) => t && t.id > 0);
    const { missingTracks, cachedCount } = await partitionCachedTracks(validTracks);
    let done = cachedCount;
    const total = validTracks.length;

    useOfflineStore.getState().updateProgress(playlistId, done, total);

    for (let i = 0; i < missingTracks.length; i++) {
      if (abortController.signal.aborted) {
        break;
      }

      const track = missingTracks[i];
      const alreadyCached = await isTrackCached(track.id);
      if (alreadyCached) {
        done = Math.min(total, done + 1);
        useOfflineStore.getState().updateProgress(playlistId, done, total);
        continue;
      }

      const ok = await cacheTrackOffline(track, 30000, abortController.signal);
      if (ok) {
        done = Math.min(total, done + 1);
      }
      useOfflineStore.getState().updateProgress(playlistId, done, total);
    }

    if (!abortController.signal.aborted) {
      markPlaylistDownloaded(playlistId);
      removeDownloadQueueItem(playlistId);
      if (playlist) {
        saveOfflinePlaylistData(playlist, validTracks, true);
      }

      useOfflineStore.setState((state) => {
        const nextProgress = { ...state.progress };
        delete nextProgress[playlistId];
        return {
          downloadedIds: getOfflinePlaylistIds(),
          progress: nextProgress,
        };
      });

      const name = playlist?.name ? td(playlist.name) : tr('Playlist', 'Плейлист');
      toast.success(
        tr(`"${name}" downloaded for offline playback`, `«${name}» успешно скачан для оффлайн доступа`)
      );
    }
  } catch (err) {
    console.warn(`[Offline Queue Worker Error for ${playlistId}]:`, err);
  } finally {
    activeAbortControllers.delete(playlistId);
  }
}

export const useOfflineStore = create<OfflineStoreState>((set, get) => ({
  downloadedIds: getOfflinePlaylistIds(),
  progress: {},

  loadDownloaded: () => {
    set({ downloadedIds: getOfflinePlaylistIds() });
    get().resumePendingDownloads();
  },

  isDownloaded: (playlistId: number) => {
    return get().downloadedIds.includes(playlistId);
  },

  getProgress: (playlistId: number) => {
    return get().progress[playlistId] || null;
  },

  updateProgress: (playlistId: number, done: number, total: number) => {
    set((state) => {
      const prev = state.progress[playlistId];
      // Prevent progress counter from jumping backwards if SW and window worker report out of order
      const monotonicDone = prev && prev.total === total ? Math.max(prev.done, done) : done;
      return {
        progress: {
          ...state.progress,
          [playlistId]: { inProgress: true, done: monotonicDone, total },
        },
      };
    });
  },

  startDownload: async (playlistId: number, tracks: Track[], playlist?: Playlist) => {
    const validTracks = (tracks || []).filter((t) => t && t.id > 0);
    if (validTracks.length === 0) return;
    if (get().progress[playlistId]?.inProgress || activeAbortControllers.has(playlistId)) return;

    // Reset any previous failure cooldowns since the user explicitly initiated download
    clearFailedTrackCooldowns(validTracks);

    // 1. Immediately save playlist metadata to offline cache for instant UI display
    if (playlist) {
      saveOfflinePlaylistData(playlist, validTracks, false);
    }

    // 2. Check which tracks are already on the device vs missing
    const { missingTracks, cachedCount } = await partitionCachedTracks(validTracks);
    if (missingTracks.length === 0) {
      markPlaylistDownloaded(playlistId);
      removeDownloadQueueItem(playlistId);
      if (playlist) {
        saveOfflinePlaylistData(playlist, validTracks, true);
      }
      set({ downloadedIds: getOfflinePlaylistIds() });
      const name = playlist?.name ? td(playlist.name) : tr('Playlist', 'Плейлист');
      toast.success(
        tr(`All tracks of "${name}" are already on your device`, `Все треки «${name}» уже скачаны на устройство`)
      );
      return;
    }

    // 3. Persist download task into localStorage queue so closing the app does not lose intent
    const queue = getDownloadQueue();
    queue[playlistId] = {
      playlistId,
      playlist,
      tracks: validTracks,
      startedAt: Date.now(),
      totalTracks: validTracks.length,
      status: 'downloading',
    };
    saveDownloadQueue(queue);

    set((state) => ({
      progress: {
        ...state.progress,
        [playlistId]: { inProgress: true, done: cachedCount, total: validTracks.length },
      },
    }));

    // 4. Try standard Background Fetch API for ONLY the missing tracks
    const usedBgFetch = await tryStartBackgroundFetch(playlistId, missingTracks, playlist?.name);
    if (usedBgFetch) {
      queue[playlistId].usedBackgroundFetch = true;
      saveDownloadQueue(queue);
    }

    // 5. Run coordinated queue worker in main thread (only delegating to SW if tab is hidden)
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'CACHE_TRACKS_IN_BACKGROUND',
        playlistId,
        tracks: missingTracks,
        initialDone: cachedCount,
        totalTracks: validTracks.length,
      });
    }

    runQueueWorker(playlistId, validTracks, playlist);
  },

  removeDownload: async (playlistId: number, tracks: Track[]) => {
    // Abort active controller if currently downloading
    const controller = activeAbortControllers.get(playlistId);
    if (controller) {
      controller.abort();
      activeAbortControllers.delete(playlistId);
    }

    removeDownloadQueueItem(playlistId);
    await removePlaylistOffline(playlistId, tracks);

    set((state) => {
      const nextProgress = { ...state.progress };
      delete nextProgress[playlistId];
      return {
        downloadedIds: getOfflinePlaylistIds(),
        progress: nextProgress,
      };
    });
  },

  cacheTrack: async (track: Track) => {
    if (!track || !track.id || track.id <= 0) return false;
    return await cacheTrackWithRetry(track);
  },

  addTrackToOffline: async (playlistId: number, track: Track, playlist?: Playlist) => {
    if (!track || !track.id || track.id <= 0) return false;
    addTrackToOfflinePlaylist(playlistId, track, playlist);
    if (get().isDownloaded(playlistId)) {
      return await cacheTrackWithRetry(track);
    }
    return false;
  },

  removeTrackFromOffline: (playlistId: number, trackId: number) => {
    removeTrackFromOfflinePlaylist(playlistId, trackId);
  },

  resumePendingDownloads: async () => {
    const queue = getDownloadQueue();
    const queuedIds = Object.keys(queue).map(Number);
    if (queuedIds.length === 0) return;

    for (const pId of queuedIds) {
      const item = queue[pId];
      if (!item || !item.tracks || item.tracks.length === 0) {
        removeDownloadQueueItem(pId);
        continue;
      }

      if (activeAbortControllers.has(pId) || activeSyncPlaylists.has(pId)) {
        continue;
      }

      const validTracks = item.tracks.filter((t) => t && t.id > 0);
      const total = validTracks.length;
      const { missingTracks, cachedCount } = await partitionCachedTracks(validTracks);
      const actionableMissing = missingTracks.filter((t) => !isTrackInFailedCooldown(t.id));

      if (cachedCount >= total || actionableMissing.length === 0) {
        // All downloadable tracks finished! Cleanly finalize and remove from queue so it never restarts
        markPlaylistDownloaded(pId);
        removeDownloadQueueItem(pId);
        if (item.playlist) {
          saveOfflinePlaylistData(item.playlist, validTracks, true);
        }

        set((state) => {
          const nextProgress = { ...state.progress };
          delete nextProgress[pId];
          return {
            downloadedIds: getOfflinePlaylistIds(),
            progress: nextProgress,
          };
        });
      } else {
        // Partially downloaded - resume only the missing tracks
        set((state) => ({
          progress: {
            ...state.progress,
            [pId]: { inProgress: true, done: cachedCount, total },
          },
        }));

        runQueueWorker(pId, validTracks, item.playlist);
      }
    }
  },

  syncPlaylist: async (playlistId: number, tracks: Track[], playlist?: Playlist) => {
    if (!get().isDownloaded(playlistId) || !tracks || tracks.length === 0) return;
    if (
      get().progress[playlistId]?.inProgress ||
      activeAbortControllers.has(playlistId) ||
      activeSyncPlaylists.has(playlistId)
    ) {
      return;
    }

    const validTracks = tracks.filter((t) => t && t.id > 0);
    if (playlist) {
      saveOfflinePlaylistData(playlist, validTracks);
    }

    // Check if there are any actionable missing tracks BEFORE showing any progress bar!
    const { missingTracks } = await partitionCachedTracks(validTracks);
    const actionableMissing = missingTracks.filter((t) => !isTrackInFailedCooldown(t.id));
    if (actionableMissing.length === 0) {
      return;
    }

    activeSyncPlaylists.add(playlistId);
    try {
      await syncDownloadedPlaylist(playlistId, validTracks, playlist, (done, total) => {
        set((state) => ({
          progress: {
            ...state.progress,
            [playlistId]: { inProgress: true, done, total },
          },
        }));
      });
    } catch (err) {
      console.warn(`[OfflineStore] syncPlaylist error:`, err);
    } finally {
      activeSyncPlaylists.delete(playlistId);
      set((state) => {
        const nextProgress = { ...state.progress };
        delete nextProgress[playlistId];
        return { progress: nextProgress };
      });
    }
  },

  syncAllDownloadedPlaylists: async () => {
    if (isSyncingAllPlaylists) return;
    const downloadedIds = get().downloadedIds;
    if (!downloadedIds || downloadedIds.length === 0) return;

    isSyncingAllPlaylists = true;
    try {
      for (const pId of downloadedIds) {
        try {
          if (pId === -1) {
            const data = await apiRequest<{ tracks: Track[] }>('/likes', { silentOffline: true });
            if (data.tracks && data.tracks.length > 0) {
              const likedPl: Playlist = {
                id: -1,
                name: 'Любимые треки',
                description: 'Ваша медиатека сохраненных композиций',
                track_count: data.tracks.length,
                created_at: new Date().toISOString(),
              };
              await get().syncPlaylist(-1, data.tracks, likedPl);
            }
          } else {
            const data = await apiRequest<{ playlist: Playlist; tracks: Track[] }>(`/playlists/${pId}`, {
              silentOffline: true,
            });
            if (data.tracks && data.tracks.length > 0) {
              await get().syncPlaylist(pId, data.tracks, data.playlist);
            }
          }
        } catch (err) {
          console.warn(`[OfflineStore] Failed to auto-sync playlist ${pId}:`, err);
        }
      }
    } finally {
      isSyncingAllPlaylists = false;
    }
  },
}));

// Listen to Service Worker background messages to update client progress and state without recursion
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (!event.data) return;
    if (event.data.type === 'BG_CACHE_PROGRESS') {
      const { playlistId, done, total, trackId } = event.data;
      if (trackId) addCachedTrackId(Number(trackId));
      if (playlistId !== undefined && done !== undefined && total !== undefined) {
        useOfflineStore.getState().updateProgress(playlistId, done, total);
      }
    } else if (event.data.type === 'BG_FETCH_SUCCESS' || event.data.type === 'BG_CACHE_COMPLETE') {
      const pId = event.data.playlistId;
      // Only resume/finalize if no active window worker is already handling this playlist
      if (pId === undefined || !activeAbortControllers.has(Number(pId))) {
        useOfflineStore.getState().resumePendingDownloads();
      }
    }
  });
}
