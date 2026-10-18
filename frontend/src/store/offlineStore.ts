import { create } from 'zustand';
import { Playlist, Track } from '../types';
import {
  getOfflinePlaylistIds,
  downloadPlaylistOffline,
  removePlaylistOffline,
  cacheTrackOffline,
  syncDownloadedPlaylist,
  saveOfflinePlaylistData,
  getDownloadQueue,
  saveDownloadQueue,
  removeDownloadQueueItem,
  tryStartBackgroundFetch,
  countCachedTracks,
  isTrackCached,
  markPlaylistDownloaded,
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
  syncPlaylist: (playlistId: number, tracks: Track[], playlist?: Playlist) => Promise<void>;
  syncAllDownloadedPlaylists: () => Promise<void>;
  resumePendingDownloads: () => Promise<void>;
}

// Active abort controllers for cancellable in-flight window downloads
const activeAbortControllers = new Map<number, AbortController>();

async function runQueueWorker(playlistId: number, tracks: Track[], playlist?: Playlist): Promise<void> {
  if (activeAbortControllers.has(playlistId)) return;

  const abortController = new AbortController();
  activeAbortControllers.set(playlistId, abortController);

  try {
    let done = await countCachedTracks(tracks);
    useOfflineStore.getState().updateProgress(playlistId, done, tracks.length);

    for (let i = 0; i < tracks.length; i++) {
      if (abortController.signal.aborted) {
        break;
      }

      const track = tracks[i];
      const isCached = await isTrackCached(track.id);
      if (!isCached) {
        await cacheTrackOffline(track);
        done++;
        useOfflineStore.getState().updateProgress(playlistId, done, tracks.length);
      }
    }

    if (!abortController.signal.aborted) {
      markPlaylistDownloaded(playlistId);
      removeDownloadQueueItem(playlistId);
      if (playlist) {
        saveOfflinePlaylistData(playlist, tracks, true);
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
    set((state) => ({
      progress: {
        ...state.progress,
        [playlistId]: { inProgress: true, done, total },
      },
    }));
  },

  startDownload: async (playlistId: number, tracks: Track[], playlist?: Playlist) => {
    if (!tracks || tracks.length === 0) return;
    if (get().progress[playlistId]?.inProgress) return;

    // 1. Immediately save playlist metadata to offline cache for instant UI display
    if (playlist) {
      saveOfflinePlaylistData(playlist, tracks, false);
    }

    // 2. Persist download task into localStorage queue so closing the app does not lose intent
    const queue = getDownloadQueue();
    queue[playlistId] = {
      playlistId,
      playlist,
      tracks,
      startedAt: Date.now(),
      totalTracks: tracks.length,
      status: 'downloading',
    };
    saveDownloadQueue(queue);

    const initialCached = await countCachedTracks(tracks);
    set((state) => ({
      progress: {
        ...state.progress,
        [playlistId]: { inProgress: true, done: initialCached, total: tracks.length },
      },
    }));

    // 3. Try standard Background Fetch API (Android Chrome / Chromium PWA)
    // This allows downloads to continue in the background via OS download manager even if app is closed
    const usedBgFetch = await tryStartBackgroundFetch(playlistId, tracks, playlist?.name);
    if (usedBgFetch) {
      queue[playlistId].usedBackgroundFetch = true;
      saveDownloadQueue(queue);
    }

    // 4. Also instruct Service Worker to keep alive with event.waitUntil while tab is backgrounded
    if (typeof navigator !== 'undefined' && navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'CACHE_TRACKS_IN_BACKGROUND',
        playlistId,
        tracks,
      });
    }

    // 5. Run active queue worker in background
    runQueueWorker(playlistId, tracks, playlist);
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
    if (!track || !track.id) return false;
    return await cacheTrackOffline(track);
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

      if (activeAbortControllers.has(pId)) {
        continue;
      }

      const total = item.tracks.length;
      const cachedCount = await countCachedTracks(item.tracks);

      if (cachedCount >= total) {
        // All tracks downloaded while app was closed or in background!
        markPlaylistDownloaded(pId);
        removeDownloadQueueItem(pId);
        if (item.playlist) {
          saveOfflinePlaylistData(item.playlist, item.tracks, true);
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
        // Partially downloaded - automatically resume downloading remaining tracks!
        set((state) => ({
          progress: {
            ...state.progress,
            [pId]: { inProgress: true, done: cachedCount, total },
          },
        }));

        tryStartBackgroundFetch(pId, item.tracks, item.playlist?.name);
        runQueueWorker(pId, item.tracks, item.playlist);
      }
    }
  },

  syncPlaylist: async (playlistId: number, tracks: Track[], playlist?: Playlist) => {
    if (!get().isDownloaded(playlistId) || !tracks || tracks.length === 0) return;
    if (get().progress[playlistId]?.inProgress) return;

    if (playlist) {
      saveOfflinePlaylistData(playlist, tracks);
    }

    try {
      await syncDownloadedPlaylist(playlistId, tracks, playlist, (done, total) => {
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
      set((state) => {
        const nextProgress = { ...state.progress };
        delete nextProgress[playlistId];
        return { progress: nextProgress };
      });
    }
  },

  syncAllDownloadedPlaylists: async () => {
    const downloadedIds = get().downloadedIds;
    if (!downloadedIds || downloadedIds.length === 0) return;

    for (const pId of downloadedIds) {
      try {
        if (pId === -1) {
          const data = await apiRequest<{ tracks: Track[] }>('/likes');
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
          const data = await apiRequest<{ playlist: Playlist; tracks: Track[] }>(`/playlists/${pId}`);
          if (data.tracks && data.tracks.length > 0) {
            await get().syncPlaylist(pId, data.tracks, data.playlist);
          }
        }
      } catch (err) {
        console.warn(`[OfflineStore] Failed to auto-sync playlist ${pId}:`, err);
      }
    }
  },
}));

// Listen to Service Worker background messages to update client progress and state
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (!event.data) return;
    if (event.data.type === 'BG_CACHE_PROGRESS') {
      const { playlistId, done, total } = event.data;
      if (playlistId !== undefined && done !== undefined && total !== undefined) {
        useOfflineStore.getState().updateProgress(playlistId, done, total);
      }
    } else if (event.data.type === 'BG_FETCH_SUCCESS' || event.data.type === 'BG_CACHE_COMPLETE') {
      useOfflineStore.getState().resumePendingDownloads();
    }
  });
}
