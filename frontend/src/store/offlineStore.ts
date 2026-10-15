import { create } from 'zustand';
import { Playlist, Track } from '../types';
import {
  getOfflinePlaylistIds,
  downloadPlaylistOffline,
  removePlaylistOffline,
  cacheTrackOffline,
  syncDownloadedPlaylist,
  saveOfflinePlaylistData,
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
  startDownload: (playlistId: number, tracks: Track[], playlist?: Playlist) => Promise<void>;
  removeDownload: (playlistId: number, tracks: Track[]) => Promise<void>;
  cacheTrack: (track: Track) => Promise<boolean>;
  syncPlaylist: (playlistId: number, tracks: Track[], playlist?: Playlist) => Promise<void>;
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

  startDownload: async (playlistId: number, tracks: Track[], playlist?: Playlist) => {
    if (!tracks || tracks.length === 0) return;
    if (get().progress[playlistId]?.inProgress) return;

    if (playlist) {
      saveOfflinePlaylistData(playlist, tracks);
    }

    set((state) => ({
      progress: {
        ...state.progress,
        [playlistId]: { inProgress: true, done: 0, total: tracks.length },
      },
    }));

    try {
      await downloadPlaylistOffline(playlistId, tracks, playlist, (done, total) => {
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
          // Liked songs
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
          // Custom playlist
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
