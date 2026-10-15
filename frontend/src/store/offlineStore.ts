import { create } from 'zustand';
import { Track } from '../types';
import {
  getOfflinePlaylistIds,
  downloadPlaylistOffline,
  removePlaylistOffline,
  cacheTrackOffline,
  syncDownloadedPlaylist,
} from '../utils/offline';
import { apiRequest } from '../api/client';

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
  startDownload: (playlistId: number, tracks: Track[]) => Promise<void>;
  removeDownload: (playlistId: number, tracks: Track[]) => Promise<void>;
  cacheTrack: (track: Track) => Promise<boolean>;
  syncPlaylist: (playlistId: number, tracks: Track[]) => Promise<void>;
  syncAllDownloadedPlaylists: () => Promise<void>;
}

export const useOfflineStore = create<OfflineStoreState>((set, get) => ({
  downloadedIds: getOfflinePlaylistIds(),
  progress: {},

  loadDownloaded: () => {
    set({ downloadedIds: getOfflinePlaylistIds() });
  },

  isDownloaded: (playlistId: number) => {
    return get().downloadedIds.includes(playlistId);
  },

  getProgress: (playlistId: number) => {
    return get().progress[playlistId] || null;
  },

  startDownload: async (playlistId: number, tracks: Track[]) => {
    if (!tracks || tracks.length === 0) return;
    if (get().progress[playlistId]?.inProgress) return;

    set((state) => ({
      progress: {
        ...state.progress,
        [playlistId]: { inProgress: true, done: 0, total: tracks.length },
      },
    }));

    try {
      await downloadPlaylistOffline(playlistId, tracks, (done, total) => {
        set((state) => ({
          progress: {
            ...state.progress,
            [playlistId]: { inProgress: true, done, total },
          },
        }));
      });

      set((state) => {
        const nextProgress = { ...state.progress };
        delete nextProgress[playlistId];
        return {
          downloadedIds: getOfflinePlaylistIds(),
          progress: nextProgress,
        };
      });
    } catch (err: any) {
      console.error('[Offline Store Error]', err);
      set((state) => {
        const nextProgress = { ...state.progress };
        delete nextProgress[playlistId];
        return {
          downloadedIds: getOfflinePlaylistIds(),
          progress: nextProgress,
        };
      });
      throw err;
    }
  },

  removeDownload: async (playlistId: number, tracks: Track[]) => {
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

  syncPlaylist: async (playlistId: number, tracks: Track[]) => {
    if (!get().isDownloaded(playlistId) || !tracks || tracks.length === 0) return;
    if (get().progress[playlistId]?.inProgress) return;

    try {
      await syncDownloadedPlaylist(playlistId, tracks, (done, total) => {
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
          // Liked songs
          const data = await apiRequest<{ tracks: Track[] }>('/likes');
          if (data.tracks && data.tracks.length > 0) {
            await get().syncPlaylist(-1, data.tracks);
          }
        } else {
          // Custom playlist
          const data = await apiRequest<{ tracks: Track[] }>(`/playlists/${pId}`);
          if (data.tracks && data.tracks.length > 0) {
            await get().syncPlaylist(pId, data.tracks);
          }
        }
      } catch (err) {
        console.warn(`[OfflineStore] Failed to auto-sync playlist ${pId}:`, err);
      }
    }
  },
}));
