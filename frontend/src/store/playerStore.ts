import { create } from 'zustand';
import { Track, RepeatMode } from '../types';
import { apiRequest } from '../api/client';

interface PlayerState {
  currentTrack: Track | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  queue: Track[];
  originalQueue: Track[];
  currentIndex: number;
  shuffle: boolean;
  smartShuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  isFullPlayerOpen: boolean;

  playTrack: (track: Track, newQueue?: Track[], index?: number) => void;
  togglePlay: () => void;
  pause: () => void;
  resume: () => void;
  nextTrack: () => void;
  prevTrack: () => void;
  seek: (seconds: number) => void;
  setVolume: (val: number) => void;
  toggleShuffle: () => void;
  toggleSmartShuffle: () => void;
  toggleRepeat: () => void;
  setFullPlayerOpen: (open: boolean) => void;
  addToQueue: (track: Track) => void;
  removeFromQueue: (index: number) => void;
  likedTrackIds: number[];
  loadLikes: () => Promise<void>;
  toggleLikeTrack: (trackId: number) => Promise<boolean>;
}

const STORAGE_KEY_VOLUME = 'jellyfy_player_volume';

const loadSavedVolume = (): number => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_VOLUME);
    if (saved !== null) {
      const parsed = parseFloat(saved);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
        return parsed;
      }
    }
  } catch (e) {}
  return 1;
};

// Global Audio Instance
const audio = new Audio();
audio.preload = 'auto';
const initialVolume = loadSavedVolume();
audio.volume = initialVolume;

export const usePlayerStore = create<PlayerState>((set, get) => {
  // Sync Audio Events
  audio.ontimeupdate = () => {
    set({ currentTime: audio.currentTime });
  };

  audio.onloadedmetadata = () => {
    set({ duration: audio.duration || 0 });
  };

  audio.onended = () => {
    const { repeat, nextTrack } = get();
    if (repeat === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } else {
      nextTrack();
    }
  };

  // MediaSession Helper
  const updateMediaSession = (track: Track) => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album || 'Jellyfin Spotify',
        artwork: [
          { src: track.cover_url || '/favicon.svg', sizes: '512x512', type: 'image/png' }
        ]
      });

      navigator.mediaSession.setActionHandler('play', () => get().resume());
      navigator.mediaSession.setActionHandler('pause', () => get().pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => get().prevTrack());
      navigator.mediaSession.setActionHandler('nexttrack', () => get().nextTrack());
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime) get().seek(details.seekTime);
      });
    }
  };

  return {
    currentTrack: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    queue: [],
    originalQueue: [],
    currentIndex: -1,
    shuffle: false,
    smartShuffle: true,
    repeat: 'off',
    volume: initialVolume,
    isFullPlayerOpen: false,

    playTrack: (track, newQueue, index) => {
      let q = newQueue ? [...newQueue] : get().queue;
      let idx = index !== undefined ? index : q.findIndex((t) => t.id === track.id);

      if (idx === -1) {
        q = [track, ...q];
        idx = 0;
      }

      set({
        currentTrack: track,
        queue: q,
        originalQueue: newQueue ? [...newQueue] : get().originalQueue,
        currentIndex: idx,
        isPlaying: true,
      });

      audio.src = `/api/stream/${track.id}`;
      audio.play().catch((err) => console.warn('[Audio play interrupted]:', err));
      updateMediaSession(track);
    },

    togglePlay: () => {
      const { isPlaying, currentTrack } = get();
      if (!currentTrack) return;

      if (isPlaying) {
        audio.pause();
        set({ isPlaying: false });
      } else {
        audio.play().catch(() => {});
        set({ isPlaying: true });
      }
    },

    pause: () => {
      audio.pause();
      set({ isPlaying: false });
    },

    resume: () => {
      if (get().currentTrack) {
        audio.play().catch(() => {});
        set({ isPlaying: true });
      }
    },

    nextTrack: async () => {
      const { queue, currentIndex, repeat, smartShuffle, playTrack } = get();
      if (queue.length === 0) return;

      let nextIndex = currentIndex + 1;

      if (nextIndex >= queue.length) {
        if (smartShuffle) {
          // Pre-fetch similar recommendations
          try {
            const current = queue[currentIndex];
            const data = await apiRequest<{ recommendations: any[] }>(
              `/recommendations?artists=${encodeURIComponent(current?.artist || '')}`
            );
            if (data.recommendations && data.recommendations.length > 0) {
              const newTracks = data.recommendations.map((r) => ({
                id: r.id,
                title: r.title,
                artist: r.artist,
                album: r.album,
                duration_ms: r.duration_ms,
                cover_url: r.cover_url,
              }));
              const updatedQueue = [...queue, ...newTracks];
              set({ queue: updatedQueue });
              playTrack(newTracks[0], updatedQueue, nextIndex);
              return;
            }
          } catch (e) {
            console.warn('[Smart shuffle error]:', e);
          }
        }

        if (repeat === 'all') {
          nextIndex = 0;
        } else {
          set({ isPlaying: false });
          return;
        }
      }

      const next = queue[nextIndex];
      playTrack(next, queue, nextIndex);
    },

    prevTrack: () => {
      const { queue, currentIndex, currentTime, playTrack } = get();
      if (currentTime > 3) {
        audio.currentTime = 0;
        return;
      }
      if (currentIndex > 0) {
        const prevIndex = currentIndex - 1;
        playTrack(queue[prevIndex], queue, prevIndex);
      } else {
        audio.currentTime = 0;
      }
    },

    seek: (seconds) => {
      audio.currentTime = seconds;
      set({ currentTime: seconds });
    },

    setVolume: (val) => {
      const clamped = Math.max(0, Math.min(1, val));
      audio.volume = clamped;
      try {
        localStorage.setItem(STORAGE_KEY_VOLUME, clamped.toString());
      } catch (e) {}
      set({ volume: clamped });
    },

    toggleShuffle: () => {
      const { shuffle, queue, currentTrack, originalQueue } = get();
      if (!shuffle) {
        // Turn on shuffle
        const shuffled = [...queue].sort(() => Math.random() - 0.5);
        if (currentTrack) {
          const idx = shuffled.findIndex((t) => t.id === currentTrack.id);
          if (idx > -1) {
            shuffled.splice(idx, 1);
            shuffled.unshift(currentTrack);
          }
        }
        set({ shuffle: true, queue: shuffled, currentIndex: 0 });
      } else {
        // Turn off shuffle
        set({ shuffle: false, queue: [...originalQueue] });
      }
    },

    toggleSmartShuffle: () => {
      set((state) => ({ smartShuffle: !state.smartShuffle }));
    },

    toggleRepeat: () => {
      const current = get().repeat;
      const next: RepeatMode = current === 'off' ? 'all' : current === 'all' ? 'one' : 'off';
      set({ repeat: next });
    },

    setFullPlayerOpen: (open) => {
      set({ isFullPlayerOpen: open });
    },

    addToQueue: (track) => {
      set((state) => ({ queue: [...state.queue, track] }));
    },

    removeFromQueue: (index) => {
      set((state) => {
        const newQueue = [...state.queue];
        newQueue.splice(index, 1);
        return { queue: newQueue };
      });
    },

    likedTrackIds: [],

    loadLikes: async () => {
      try {
        const data = await apiRequest<{ tracks: Track[] }>('/likes');
        set({ likedTrackIds: (data.tracks || []).map((t) => t.id) });
      } catch (e) {
        // Ignored if not yet authenticated
      }
    },

    toggleLikeTrack: async (trackId: number) => {
      const { likedTrackIds } = get();
      const isCurrentlyLiked = likedTrackIds.includes(trackId);
      const newLiked = isCurrentlyLiked
        ? likedTrackIds.filter((id) => id !== trackId)
        : [...likedTrackIds, trackId];

      // Optimistic update
      set({ likedTrackIds: newLiked });

      try {
        const res = await apiRequest<{ liked: boolean }>(`/likes/${trackId}`, { method: 'POST' });
        const updated = res.liked
          ? Array.from(new Set([...get().likedTrackIds, trackId]))
          : get().likedTrackIds.filter((id) => id !== trackId);
        set({ likedTrackIds: updated });
        return res.liked;
      } catch (err) {
        // Rollback on error
        set({ likedTrackIds });
        throw err;
      }
    },
  };
});
