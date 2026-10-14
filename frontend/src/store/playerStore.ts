import { create } from 'zustand';
import { Track, RepeatMode } from '../types';
import { apiRequest } from '../api/client';

export const EQ_FREQUENCIES = [60, 230, 910, 3600, 14000];

export const EQ_PRESETS: Record<string, { label: string; bands: number[] }> = {
  flat: { label: 'Оригинал (Flat)', bands: [0, 0, 0, 0, 0] },
  bass: { label: 'Усиление басов', bands: [6, 4, 1, 0, 0] },
  rock: { label: 'Рок', bands: [5, 2, -1, 3, 5] },
  pop: { label: 'Поп', bands: [-1, 2, 4, 3, 1] },
  vocal: { label: 'Чистый вокал', bands: [-2, 0, 5, 4, 2] },
  electronic: { label: 'Электроника', bands: [6, 4, -1, 3, 6] },
  hiphop: { label: 'Хип-хоп', bands: [7, 4, 0, 2, 3] },
};

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

  // Equalizer & Studio Sound
  isEqualizerOpen: boolean;
  eqBands: number[];
  eqPreset: string;
  isNormalizerEnabled: boolean;

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
  blacklistTrack: (track: Track) => Promise<void>;

  setEqGain: (bandIndex: number, gain: number) => void;
  setEqPreset: (presetId: string) => void;
  toggleNormalizer: () => void;
  setEqualizerOpen: (open: boolean) => void;
  resetEqualizer: () => void;
}

const STORAGE_KEY_VOLUME = 'jellyfy_player_volume';
const STORAGE_KEY_EQ_BANDS = 'jellyfy_eq_bands';
const STORAGE_KEY_EQ_PRESET = 'jellyfy_eq_preset';
const STORAGE_KEY_NORMALIZER = 'jellyfy_normalizer_enabled';

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

const loadSavedEqBands = (): number[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_EQ_BANDS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length === 5) return parsed;
    }
  } catch (_) {}
  return [0, 0, 0, 0, 0];
};

const loadSavedEqPreset = (): string => {
  return localStorage.getItem(STORAGE_KEY_EQ_PRESET) || 'flat';
};

const loadSavedNormalizer = (): boolean => {
  const val = localStorage.getItem(STORAGE_KEY_NORMALIZER);
  return val === null ? true : val === 'true';
};

// Global Audio Instance
const audio = new Audio();
audio.preload = 'auto';
audio.crossOrigin = 'anonymous';
const initialVolume = loadSavedVolume();
audio.volume = initialVolume;

// Web Audio API Graph
let audioCtx: AudioContext | null = null;
let sourceNode: MediaElementAudioSourceNode | null = null;
let compressorNode: DynamicsCompressorNode | null = null;
let eqFilters: BiquadFilterNode[] = [];

function ensureAudioGraph() {
  if (audioCtx) return;
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    audioCtx = new AudioContextClass();
    sourceNode = audioCtx.createMediaElementSource(audio);

    // 5-Band Equalizer filters
    eqFilters = EQ_FREQUENCIES.map((freq, idx) => {
      const filter = audioCtx!.createBiquadFilter();
      if (idx === 0) {
        filter.type = 'lowshelf';
      } else if (idx === EQ_FREQUENCIES.length - 1) {
        filter.type = 'highshelf';
      } else {
        filter.type = 'peaking';
        filter.Q.value = 1.0;
      }
      filter.frequency.value = freq;
      filter.gain.value = 0;
      return filter;
    });

    // Dynamics Compressor (Spotify-like Loudness Normalizer)
    compressorNode = audioCtx.createDynamicsCompressor();
    compressorNode.threshold.value = -24;
    compressorNode.knee.value = 30;
    compressorNode.ratio.value = 12;
    compressorNode.attack.value = 0.003;
    compressorNode.release.value = 0.25;

    // Connect audio chain: source -> eqFilters[0..4] -> compressor -> destination
    let lastNode: AudioNode = sourceNode;
    for (const filter of eqFilters) {
      lastNode.connect(filter);
      lastNode = filter;
    }
    lastNode.connect(compressorNode);
    compressorNode.connect(audioCtx.destination);

    // Apply saved bands
    const savedBands = loadSavedEqBands();
    savedBands.forEach((gain, i) => {
      if (eqFilters[i]) eqFilters[i].gain.value = gain;
    });

    // Apply saved normalizer state
    const isNorm = loadSavedNormalizer();
    if (!isNorm) {
      compressorNode.threshold.value = 0;
      compressorNode.ratio.value = 1;
    }
  } catch (err) {
    console.warn('[Web Audio API Init Error]:', err);
  }
}

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

    isEqualizerOpen: false,
    eqBands: loadSavedEqBands(),
    eqPreset: loadSavedEqPreset(),
    isNormalizerEnabled: loadSavedNormalizer(),

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

      ensureAudioGraph();
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }

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
        ensureAudioGraph();
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
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
        ensureAudioGraph();
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
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

      playTrack(queue[nextIndex], queue, nextIndex);
    },

    prevTrack: () => {
      const { queue, currentIndex, playTrack } = get();
      if (queue.length === 0) return;

      if (audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
      }

      let prevIndex = currentIndex - 1;
      if (prevIndex < 0) {
        prevIndex = queue.length - 1;
      }
      playTrack(queue[prevIndex], queue, prevIndex);
    },

    seek: (seconds: number) => {
      audio.currentTime = seconds;
      set({ currentTime: seconds });
    },

    setVolume: (val: number) => {
      const clamped = Math.max(0, Math.min(1, val));
      audio.volume = clamped;
      localStorage.setItem(STORAGE_KEY_VOLUME, clamped.toString());
      set({ volume: clamped });
    },

    toggleShuffle: () => {
      const { shuffle, queue, currentTrack } = get();
      const nextShuffle = !shuffle;

      if (nextShuffle) {
        const withoutCurrent = queue.filter((t) => t.id !== currentTrack?.id);
        for (let i = withoutCurrent.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [withoutCurrent[i], withoutCurrent[j]] = [withoutCurrent[j], withoutCurrent[i]];
        }
        const newQueue = currentTrack ? [currentTrack, ...withoutCurrent] : withoutCurrent;
        set({ shuffle: true, queue: newQueue, currentIndex: currentTrack ? 0 : -1 });
      } else {
        const orig = get().originalQueue;
        const newIdx = currentTrack ? orig.findIndex((t) => t.id === currentTrack.id) : 0;
        set({ shuffle: false, queue: orig, currentIndex: newIdx !== -1 ? newIdx : 0 });
      }
    },

    toggleSmartShuffle: () => {
      set({ smartShuffle: !get().smartShuffle });
    },

    toggleRepeat: () => {
      const current = get().repeat;
      const modes: RepeatMode[] = ['off', 'all', 'one'];
      const nextIdx = (modes.indexOf(current) + 1) % modes.length;
      set({ repeat: modes[nextIdx] });
    },

    setFullPlayerOpen: (open: boolean) => {
      set({ isFullPlayerOpen: open });
    },

    addToQueue: (track: Track) => {
      const { queue } = get();
      set({ queue: [...queue, track] });
    },

    removeFromQueue: (index: number) => {
      const { queue, currentIndex } = get();
      const updated = queue.filter((_, i) => i !== index);
      let newIdx = currentIndex;
      if (index < currentIndex) {
        newIdx--;
      } else if (index === currentIndex && index >= updated.length) {
        newIdx = Math.max(0, updated.length - 1);
      }
      set({ queue: updated, currentIndex: newIdx });
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

      set({ likedTrackIds: newLiked });

      try {
        const res = await apiRequest<{ liked: boolean }>(`/likes/${trackId}`, { method: 'POST' });
        const updated = res.liked
          ? Array.from(new Set([...get().likedTrackIds, trackId]))
          : get().likedTrackIds.filter((id) => id !== trackId);
        set({ likedTrackIds: updated });
        return res.liked;
      } catch (err) {
        set({ likedTrackIds });
        throw err;
      }
    },

    blacklistTrack: async (track: Track) => {
      await apiRequest('/blacklist', {
        method: 'POST',
        body: JSON.stringify({
          title: track.title,
          artist: track.artist,
          track_id: track.id,
          spotify_id: track.spotify_id,
        }),
      });

      // 1. Remove from liked tracks state
      set((state) => ({
        likedTrackIds: state.likedTrackIds.filter((id) => id !== track.id),
      }));

      // 2. Filter current queue
      const { currentTrack, queue, originalQueue, currentIndex, playTrack } = get();
      const isCurrent =
        currentTrack &&
        (currentTrack.id === track.id ||
          (currentTrack.title.toLowerCase() === track.title.toLowerCase() &&
            currentTrack.artist.toLowerCase() === track.artist.toLowerCase()));

      const filteredQueue = queue.filter(
        (t) =>
          t.id !== track.id &&
          !(t.title.toLowerCase() === track.title.toLowerCase() &&
            t.artist.toLowerCase() === track.artist.toLowerCase())
      );
      const filteredOriginal = originalQueue.filter(
        (t) =>
          t.id !== track.id &&
          !(t.title.toLowerCase() === track.title.toLowerCase() &&
            t.artist.toLowerCase() === track.artist.toLowerCase())
      );

      if (isCurrent) {
        if (filteredQueue.length > 0) {
          const nextIdx = currentIndex < filteredQueue.length ? currentIndex : 0;
          const nextT = filteredQueue[nextIdx];
          set({ queue: filteredQueue, originalQueue: filteredOriginal, currentIndex: nextIdx });
          playTrack(nextT, filteredQueue, nextIdx);
        } else {
          audio.pause();
          audio.src = '';
          set({
            currentTrack: null,
            queue: [],
            originalQueue: [],
            isPlaying: false,
            currentTime: 0,
            duration: 0,
          });
        }
      } else {
        const newCurrentIdx = currentTrack
          ? filteredQueue.findIndex((t) => t.id === currentTrack.id)
          : 0;
        set({
          queue: filteredQueue,
          originalQueue: filteredOriginal,
          currentIndex: Math.max(0, newCurrentIdx),
        });
      }

      // 3. Dispatch global event for other components
      window.dispatchEvent(
        new CustomEvent('jellyfy:track_blacklisted', {
          detail: { trackId: track.id, title: track.title, artist: track.artist },
        })
      );
    },

    // Equalizer & Normalizer Actions
    setEqualizerOpen: (open: boolean) => {
      set({ isEqualizerOpen: open });
    },

    setEqGain: (bandIndex: number, gain: number) => {
      ensureAudioGraph();
      const bands = [...get().eqBands];
      bands[bandIndex] = gain;
      if (eqFilters[bandIndex] && audioCtx) {
        eqFilters[bandIndex].gain.setValueAtTime(gain, audioCtx.currentTime);
      }
      localStorage.setItem(STORAGE_KEY_EQ_BANDS, JSON.stringify(bands));
      set({ eqBands: bands, eqPreset: 'custom' });
    },

    setEqPreset: (presetId: string) => {
      ensureAudioGraph();
      const preset = EQ_PRESETS[presetId];
      if (!preset) return;
      const bands = [...preset.bands];
      bands.forEach((g, i) => {
        if (eqFilters[i] && audioCtx) {
          eqFilters[i].gain.setValueAtTime(g, audioCtx.currentTime);
        }
      });
      localStorage.setItem(STORAGE_KEY_EQ_BANDS, JSON.stringify(bands));
      localStorage.setItem(STORAGE_KEY_EQ_PRESET, presetId);
      set({ eqBands: bands, eqPreset: presetId });
    },

    toggleNormalizer: () => {
      ensureAudioGraph();
      const current = get().isNormalizerEnabled;
      const next = !current;
      if (compressorNode && audioCtx) {
        if (next) {
          compressorNode.threshold.setValueAtTime(-24, audioCtx.currentTime);
          compressorNode.ratio.setValueAtTime(12, audioCtx.currentTime);
        } else {
          compressorNode.threshold.setValueAtTime(0, audioCtx.currentTime);
          compressorNode.ratio.setValueAtTime(1, audioCtx.currentTime);
        }
      }
      localStorage.setItem(STORAGE_KEY_NORMALIZER, String(next));
      set({ isNormalizerEnabled: next });
    },

    resetEqualizer: () => {
      get().setEqPreset('flat');
    },
  };
});
