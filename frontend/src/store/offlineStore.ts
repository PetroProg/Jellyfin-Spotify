import { create } from 'zustand';
import { Track } from '../types';
import {
  getOfflinePlaylistIds,
  downloadPlaylistOffline,
  removePlaylistOffline
} from '../utils/offline';

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
    // If already downloading this playlist, do not start duplicate
    if (get().progress[playlistId]?.inProgress) return;

    set((state) => ({
      progress: {
        ...state.progress,
        [playlistId]: { inProgress: true, done: 0, total: tracks.length }
      }
    }));

    try {
      await downloadPlaylistOffline(playlistId, tracks, (done, total) => {
        set((state) => ({
          progress: {
            ...state.progress,
            [playlistId]: { inProgress: true, done, total }
          }
        }));
      });

      // Download successfully completed
      set((state) => {
        const nextProgress = { ...state.progress };
        delete nextProgress[playlistId];
        return {
          downloadedIds: getOfflinePlaylistIds(),
          progress: nextProgress
        };
      });
    } catch (err: any) {
      console.error('[Offline Store Error]', err);
      set((state) => {
        const nextProgress = { ...state.progress };
        delete nextProgress[playlistId];
        return {
          downloadedIds: getOfflinePlaylistIds(),
          progress: nextProgress
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
        progress: nextProgress
      };
    });
  }
}));
