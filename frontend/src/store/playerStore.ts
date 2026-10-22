import { create } from 'zustand';
import { Track, RepeatMode } from '../types';
import { apiRequest } from '../api/client';
import { useSyncStore } from './syncStore';
import { toast } from './toastStore';
import { tr } from './i18nStore';
import { useOfflineStore } from './offlineStore';
import { getCachedTrackUrl, isTrackCached, cacheTrackOffline, saveOfflinePlaylistData, getSynchronousBlobUrl } from '../utils/offline';

export const EQ_FREQUENCIES = [60, 230, 910, 3600, 14000];

export const EQ_PRESETS: Record<string, { label: string; labelEn: string; bands: number[] }> = {
  flat: { label: 'Оригинал (Flat)', labelEn: 'Original (Flat)', bands: [0, 0, 0, 0, 0] },
  bass: { label: 'Усиление басов', labelEn: 'Bass Boost', bands: [6, 4, 1, 0, 0] },
  rock: { label: 'Рок', labelEn: 'Rock', bands: [5, 2, -1, 3, 5] },
  pop: { label: 'Поп', labelEn: 'Pop', bands: [-1, 2, 4, 3, 1] },
  vocal: { label: 'Чистый вокал', labelEn: 'Clean Vocal', bands: [-2, 0, 5, 4, 2] },
  electronic: { label: 'Электроника', labelEn: 'Electronic', bands: [6, 4, -1, 3, 6] },
  hiphop: { label: 'Хип-хоп', labelEn: 'Hip-Hop', bands: [7, 4, 0, 2, 3] },
};

interface PlayerState {
  currentTrack: Track | null;
  currentPlaylistId: number | null;
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
  crossfade: number;

  playTrack: (track: Track, newQueue?: Track[], index?: number, playlistId?: number | null) => void;
  playTrackLocally: (track: Track, newQueue?: Track[], index?: number, startTime?: number, autoPlay?: boolean, playlistId?: number | null) => void;
  stopLocalPlayback: () => void;
  shufflePlay: (tracks: Track[], playlistId?: number | null) => void;
  updateQueueIfCurrent: (playlistId: number, tracks: Track[]) => void;
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
  setCrossfade: (seconds: number) => void;
}

const STORAGE_KEY_VOLUME = 'jellyfy_player_volume';
const STORAGE_KEY_EQ_BANDS = 'jellyfy_eq_bands';
const STORAGE_KEY_EQ_PRESET = 'jellyfy_eq_preset';
const STORAGE_KEY_NORMALIZER = 'jellyfy_normalizer_enabled';
const STORAGE_KEY_LIKED_IDS = 'jellyfy_cached_liked_ids';
const STORAGE_KEY_CROSSFADE = 'jellyfy_crossfade';

const loadSavedCrossfade = (): number => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_CROSSFADE);
    if (saved !== null) {
      const parsed = parseFloat(saved);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 12) {
        return parsed;
      }
    }
  } catch (_) {}
  return 0;
};

const loadSavedLikedIds = (): number[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_LIKED_IDS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

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
  // Default to false: Pure Bit-Perfect Direct Stream for high-end headphones (Bose, etc.)
  return val === null ? false : val === 'true';
};

// Global Audio Instance
const audio = new Audio();
audio.preload = 'auto';
audio.crossOrigin = 'anonymous';
const initialVolume = loadSavedVolume();
audio.volume = initialVolume;

// Crossfade fade controller
let fadeInterval: any = null;
let isFadingIn = false;
let isFadingOut = false;

function cancelFade() {
  if (fadeInterval) {
    clearInterval(fadeInterval);
    fadeInterval = null;
  }
  isFadingIn = false;
  isFadingOut = false;
}

function restoreTargetVolume() {
  cancelFade();
  const target = usePlayerStore.getState().volume;
  audio.volume = target;
}

let silentAudioUrl: string | null = null;

function getSilentAudioUrl(): string {
  if (silentAudioUrl) return silentAudioUrl;
  try {
    const sampleRate = 44100;
    const numChannels = 1;
    const bitsPerSample = 16;
    const durationSec = 3; // 3 seconds of solid PCM silence
    const dataSize = durationSec * sampleRate * numChannels * (bitsPerSample / 8);
    const totalSize = 44 + dataSize;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);

    // "RIFF"
    view.setUint32(0, 0x52494646, false);
    view.setUint32(4, 36 + dataSize, true);
    view.setUint32(8, 0x57415645, false); // "WAVE"

    // "fmt "
    view.setUint32(12, 0x666d7420, false);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
    view.setUint16(32, numChannels * (bitsPerSample / 8), true);
    view.setUint16(34, bitsPerSample, true);

    // "data"
    view.setUint32(36, 0x64617461, false);
    view.setUint32(40, dataSize, true);

    const blob = new Blob([buffer], { type: 'audio/wav' });
    silentAudioUrl = URL.createObjectURL(blob);
    return silentAudioUrl;
  } catch (_) {
    return 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAAABmYWN0BAAAAAAAAABkYXRhAAAAAA==';
  }
}

// Inaudible looping silent audio element to keep Android/Samsung One UI OS audio session permanently alive
let keepAliveAudio: HTMLAudioElement | null = null;
let standbyKeepaliveTimer: any = null;
const STANDBY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes graceful standby window on pause

function clearStandbyKeepaliveTimer() {
  if (standbyKeepaliveTimer) {
    clearTimeout(standbyKeepaliveTimer);
    standbyKeepaliveTimer = null;
  }
}

function ensureAudioKeepalive() {
  if (typeof window === 'undefined') return;
  try {
    clearStandbyKeepaliveTimer();
    if (!keepAliveAudio) {
      keepAliveAudio = new Audio(getSilentAudioUrl());
      keepAliveAudio.loop = true;
      keepAliveAudio.volume = 0.001;
      keepAliveAudio.onended = () => {
        if (usePlayerStore.getState().isPlaying || standbyKeepaliveTimer) {
          keepAliveAudio?.play().catch(() => {});
        }
      };
    }
    if (keepAliveAudio.paused) {
      keepAliveAudio.play().catch(() => {});
    }
  } catch (_) {}
}

function scheduleStandbyKeepalive() {
  clearStandbyKeepaliveTimer();
  // Keep silent audio playing so Android OS maintains active audio focus and lockscreen controls
  ensureAudioKeepalive();
  // Hold active for 15 minutes while paused so user can pause in store/conversation without losing headphone resume
  standbyKeepaliveTimer = setTimeout(() => {
    console.log('[Audio Keepalive] 15m pause standby grace period expired. Releasing keepalive.');
    releaseAudioKeepalive();
  }, STANDBY_TIMEOUT_MS);
}

function releaseAudioKeepalive() {
  clearStandbyKeepaliveTimer();
  if (keepAliveAudio && !keepAliveAudio.paused) {
    try {
      keepAliveAudio.pause();
    } catch (_) {}
  }
}

// Screen WakeLock to prevent mobile OS from aggressively terminating playback
let wakeLockSentinel: any = null;

async function requestScreenWakeLock() {
  if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
    try {
      if (!wakeLockSentinel) {
        wakeLockSentinel = await (navigator as any).wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
          wakeLockSentinel = null;
        });
      }
    } catch (_) {}
  }
}

function releaseScreenWakeLock() {
  if (wakeLockSentinel) {
    try {
      wakeLockSentinel.release();
    } catch (_) {}
    wakeLockSentinel = null;
  }
}

// Track interruptions by external apps (like Instagram, TikTok, phone calls)
let isUserInitiatedPause = false;
let wasInterruptedByExternalApp = false;

function startFadeIn(durationSec: number) {
  cancelFade();
  const target = usePlayerStore.getState().volume;

  // If in background, immediately set target volume without waiting for throttled setInterval!
  if (typeof document !== 'undefined' && document.hidden) {
    audio.volume = target;
    return;
  }

  if (target <= 0.01 || durationSec <= 0) {
    audio.volume = target;
    return;
  }

  isFadingIn = true;
  audio.volume = 0;
  const startTime = performance.now();
  const fadeMs = durationSec * 1000;

  fadeInterval = setInterval(() => {
    // If app becomes hidden during fade, finish immediately
    if (typeof document !== 'undefined' && document.hidden) {
      clearInterval(fadeInterval);
      fadeInterval = null;
      isFadingIn = false;
      audio.volume = target;
      return;
    }

    const elapsed = performance.now() - startTime;
    const progress = Math.min(1, elapsed / fadeMs);
    const currentVol = target * progress;
    audio.volume = Math.max(0, Math.min(1, currentVol));

    if (progress >= 1) {
      clearInterval(fadeInterval);
      fadeInterval = null;
      isFadingIn = false;
      audio.volume = target;
    }
  }, 40);
}

// Web Audio API Graph (Lazy initialized only when EQ or DSP is explicitly engaged)
let audioCtx: AudioContext | null = null;
let sourceNode: MediaElementAudioSourceNode | null = null;
let compressorNode: DynamicsCompressorNode | null = null;
let eqFilters: BiquadFilterNode[] = [];
let isAudioGraphAttached = false;

function shouldEngageAudioDsp(): boolean {
  const isNorm = loadSavedNormalizer();
  const preset = loadSavedEqPreset();
  const bands = loadSavedEqBands();
  const hasActiveEq = preset !== 'flat' || bands.some((b) => b !== 0);
  return isNorm || hasActiveEq;
}

function updateAudioGraphRouting() {
  if (!audioCtx || !sourceNode) return;

  const isNorm = loadSavedNormalizer();
  const bands = loadSavedEqBands();
  const preset = loadSavedEqPreset();
  const hasActiveEq = preset !== 'flat' || bands.some((b) => b !== 0);

  // Pure Bit-Perfect Direct Output (bypass filters & compressor completely)
  if (!isNorm && !hasActiveEq) {
    try {
      sourceNode.disconnect();
      sourceNode.connect(audioCtx.destination);
    } catch (_) {}
    return;
  }

  try {
    sourceNode.disconnect();
    let lastNode: AudioNode = sourceNode;
    for (const filter of eqFilters) {
      lastNode.connect(filter);
      lastNode = filter;
    }
    if (compressorNode) {
      if (isNorm) {
        compressorNode.threshold.value = -6; // Gentle threshold to preserve drum punch on Bose
        compressorNode.ratio.value = 1.5;   // Gentle ratio to avoid squashing dynamics
        compressorNode.knee.value = 10;
        compressorNode.attack.value = 0.05;
        compressorNode.release.value = 0.25;
      } else {
        compressorNode.threshold.value = 0;
        compressorNode.ratio.value = 1;
      }
      lastNode.connect(compressorNode);
      try { compressorNode.disconnect(); } catch (_) {}
      compressorNode.connect(audioCtx.destination);
    } else {
      lastNode.connect(audioCtx.destination);
    }
  } catch (err) {
    console.warn('[Audio Routing Update Error]:', err);
  }
}

function ensureAudioGraph(forceAttach = false) {
  if (!forceAttach && !shouldEngageAudioDsp() && !isAudioGraphAttached) {
    // Pure Bit-Perfect mode: Keep <audio> on native OS/hardware output directly without Web Audio API!
    return;
  }

  if (isAudioGraphAttached && audioCtx) {
    updateAudioGraphRouting();
    return;
  }

  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    audioCtx = new AudioContextClass();
    sourceNode = audioCtx.createMediaElementSource(audio);
    isAudioGraphAttached = true;

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

    // Gentle mastering dynamics compressor
    compressorNode = audioCtx.createDynamicsCompressor();
    compressorNode.threshold.value = -6;
    compressorNode.knee.value = 10;
    compressorNode.ratio.value = 1.5;
    compressorNode.attack.value = 0.05;
    compressorNode.release.value = 0.25;

    // Apply saved bands
    const savedBands = loadSavedEqBands();
    savedBands.forEach((gain, i) => {
      if (eqFilters[i]) eqFilters[i].gain.value = gain;
    });

    updateAudioGraphRouting();
  } catch (err) {
    console.warn('[Web Audio API Init Error]:', err);
  }
}

// Proactive user-gesture unlock and background/interruption recovery
if (typeof window !== 'undefined') {
  const unlockAudio = () => {
    if (audioCtx && (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted')) {
      audioCtx.resume().catch(() => {});
    }
  };
  window.addEventListener('click', unlockAudio, { passive: true });
  window.addEventListener('touchstart', unlockAudio, { passive: true });
  window.addEventListener('keydown', unlockAudio, { passive: true });
}

// MediaSession position sync helper
const updateMediaPositionState = (cur?: number, dur?: number) => {
  if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
    const c = cur ?? audio.currentTime;
    const d = dur ?? usePlayerStore.getState().duration;
    if (d > 0 && isFinite(d) && c >= 0 && isFinite(c)) {
      try {
        const isPaused = audio.paused || !usePlayerStore.getState().isPlaying;
        navigator.mediaSession.setPositionState({
          duration: Math.max(d, c),
          playbackRate: isPaused ? 0 : (audio.playbackRate || 1),
          position: Math.min(c, d)
        });
      } catch (_) {}
    }
  }
};

let networkRetryCount = 0;
let isRecoveringStream = false;
let errorRecoveryTimeout: any = null;
let stallTimeout: any = null;
let waitingTimeout: any = null;

/**
 * Resilient stream recovery when network drops, switches from Wi-Fi to LTE,
 * or when the HTMLMediaElement encounters an error state.
 */
async function recoverAudioStream(resumeTime?: number, autoPlay: boolean = true): Promise<void> {
  if (isRecoveringStream) return;
  isRecoveringStream = true;

  try {
    const store = usePlayerStore.getState();
    const track = store.currentTrack;
    if (!track) return;

    let targetTime = 0;
    if (resumeTime !== undefined && resumeTime >= 0 && isFinite(resumeTime)) {
      targetTime = resumeTime;
    } else if (audio.currentTime > 0 && isFinite(audio.currentTime)) {
      targetTime = audio.currentTime;
    } else if (store.currentTime > 0 && isFinite(store.currentTime)) {
      targetTime = store.currentTime;
    }

    console.log(`[Audio Recovery] Reconnecting stream for "${track.title}" at ${targetTime.toFixed(1)}s (autoPlay: ${autoPlay})`);

    // 1. Check local offline cache first for instant 0ms playback without internet
    let targetSrc = getSynchronousBlobUrl(track.id);
    if (!targetSrc) {
      try {
        targetSrc = await getCachedTrackUrl(track.id);
      } catch (_) {}
    }

    // 2. If not in cache, use remote stream URL with query timestamp to force a new TCP connection on active network
    if (!targetSrc) {
      targetSrc = `/api/stream/${track.id}?reconnect=${Date.now()}`;
    }

    // 3. Reset HTMLMediaElement cleanly to wipe any MediaError state
    try {
      audio.pause();
    } catch (_) {}

    audio.removeAttribute('src');
    audio.load(); // W3C spec: resets media error to null, networkState to NETWORK_EMPTY
    audio.src = targetSrc;
    audio.load();

    // 4. Wait for metadata or canplay before restoring playback position
    await new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      const fallbackTimer = setTimeout(done, 3000);

      const onCanPlay = () => {
        clearTimeout(fallbackTimer);
        if (targetTime > 0 && isFinite(targetTime)) {
          try {
            audio.currentTime = Math.min(targetTime, audio.duration || targetTime);
          } catch (e) {
            console.warn('[Seek on recover]:', e);
          }
        }
        done();
      };

      if (audio.readyState >= 1) {
        onCanPlay();
      } else {
        audio.addEventListener('loadedmetadata', onCanPlay, { once: true });
        audio.addEventListener('canplay', onCanPlay, { once: true });
      }
    });

    if (autoPlay) {
      ensureAudioGraph();
      if (audioCtx && (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted')) {
        audioCtx.resume().catch(() => {});
      }

      try {
        await audio.play();
        usePlayerStore.setState({ isPlaying: true });
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
        networkRetryCount = 0;
      } catch (playErr: any) {
        console.warn('[Play after recovery failed]:', playErr);
        if (playErr.name === 'NotAllowedError') {
          usePlayerStore.setState({ isPlaying: false });
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'paused';
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Audio Recovery Exception]:', err);
  } finally {
    isRecoveringStream = false;
  }
}

export const usePlayerStore = create<PlayerState>((set, get) => {
  // Sync Audio Events
  let lastSyncTime = 0;

  const handleAudioDuration = () => {
    const dur = audio.duration;
    if (dur && !isNaN(dur) && isFinite(dur) && dur > 0) {
      set({ duration: dur });
      updateMediaPositionState(audio.currentTime, dur);
      if (useSyncStore.getState().isLocalActive) {
        useSyncStore.getState().sendPlaybackState({ duration: dur });
      }
    }
  };

  audio.onplay = () => {
    isUserInitiatedPause = false;
    wasInterruptedByExternalApp = false;
    ensureAudioKeepalive();
    requestScreenWakeLock();
    set({ isPlaying: true });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    updateMediaPositionState();
    useSyncStore.getState().sendPlaybackState({ isPlaying: true });
  };

  audio.onpause = () => {
    releaseScreenWakeLock();
    if (!isUserInitiatedPause && get().currentTrack) {
      wasInterruptedByExternalApp = true;
      console.log('[Audio] External interruption detected (Instagram/phone call/system)');
    }
    // Always schedule standby keepalive on pause so Android lockscreen and Bluetooth button stay alive
    scheduleStandbyKeepalive();

    set({ isPlaying: false });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    updateMediaPositionState();
    useSyncStore.getState().sendPlaybackState({ isPlaying: false });
  };

  let consecutiveErrors = 0;

  audio.onerror = () => {
    const err = audio.error;
    const { currentTrack, isPlaying } = get();
    console.warn('[Audio Error Event]: code =', err?.code, 'message =', err?.message, 'track =', currentTrack?.title);

    if (!currentTrack) return;

    // Check if offline or network stream failure:
    // MediaError.MEDIA_ERR_NETWORK (2)
    // MediaError.MEDIA_ERR_DECODE (3 - abruptly severed stream causes decode error at EOF)
    // MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED (4 - 504 / network fetch failure)
    const isNetworkErr = (typeof navigator !== 'undefined' && !navigator.onLine) ||
      err?.code === 2 || err?.code === 3 || err?.code === 4;

    const savedPos = audio.currentTime > 0 ? audio.currentTime : get().currentTime;

    if (isNetworkErr && networkRetryCount < 5) {
      networkRetryCount++;
      console.warn(`[Audio Error] Network stream interrupted. Attempting auto-reconnect ${networkRetryCount}/5 at ${savedPos.toFixed(1)}s...`);

      if (errorRecoveryTimeout) clearTimeout(errorRecoveryTimeout);
      const delay = Math.min(3000, 400 + networkRetryCount * 600);
      errorRecoveryTimeout = setTimeout(() => {
        recoverAudioStream(savedPos, isPlaying);
      }, delay);
      return;
    }

    // If persistent non-network error or retries exhausted
    consecutiveErrors++;
    if (consecutiveErrors >= 3) {
      consecutiveErrors = 0;
      networkRetryCount = 0;
      set({ isPlaying: false });
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
      toast.error(tr('Playback error: network connection lost', 'Ошибка воспроизведения: потеряно подключение к сети'));
      return;
    }

    toast.warning(tr(`Skipping «${currentTrack.title}»`, `Пропуск «${currentTrack.title}» (файл недоступен)`));
    if (errorRecoveryTimeout) clearTimeout(errorRecoveryTimeout);
    errorRecoveryTimeout = setTimeout(() => {
      get().nextTrack();
    }, 400);
  };

  audio.onplaying = () => {
    consecutiveErrors = 0;
    networkRetryCount = 0;
    if (errorRecoveryTimeout) clearTimeout(errorRecoveryTimeout);
    if (stallTimeout) clearTimeout(stallTimeout);
    if (waitingTimeout) clearTimeout(waitingTimeout);
    set({ isPlaying: true });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
    updateMediaPositionState();
  };

  audio.onwaiting = () => {
    if (get().isPlaying && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
    // If waiting for buffer for >3.5 seconds during active playback, auto-reconnect
    if (waitingTimeout) clearTimeout(waitingTimeout);
    waitingTimeout = setTimeout(() => {
      if (get().isPlaying && audio.readyState < 3) {
        console.warn('[Audio Waiting]: Stalled waiting for buffer for >3.5s, reconnecting stream...');
        recoverAudioStream(audio.currentTime || get().currentTime, true);
      }
    }, 3500);
  };

  audio.onstalled = () => {
    if (!get().isPlaying) return;
    if (stallTimeout) clearTimeout(stallTimeout);
    stallTimeout = setTimeout(() => {
      if (get().isPlaying && audio.readyState < 3) {
        console.warn('[Audio Stalled]: Stream stalled for >3s, reconnecting stream...');
        recoverAudioStream(audio.currentTime || get().currentTime, true);
      }
    }, 3000);
  };

  audio.onprogress = () => {
    if (stallTimeout) {
      clearTimeout(stallTimeout);
      stallTimeout = null;
    }
  };

  audio.ontimeupdate = () => {
    const cur = audio.currentTime;
    const dur = audio.duration;
    const update: any = { currentTime: cur };

    if (dur && !isNaN(dur) && isFinite(dur) && dur > 0 && Math.abs(dur - get().duration) > 0.5) {
      update.duration = dur;
    } else if (cur > get().duration && get().duration > 0) {
      const fallbackDur = (get().currentTrack?.duration_ms && get().currentTrack!.duration_ms > 0)
        ? get().currentTrack!.duration_ms / 1000
        : cur;
      update.duration = Math.max(cur, fallbackDur);
    }

    set(update);

    const crossfade = get().crossfade;
    const effectiveDur = update.duration || get().duration;
    const isAppVisible = typeof document !== 'undefined' && !document.hidden;

    // Crossfade handling at end of track (only active when foreground/visible to avoid background volume drops)
    if (isAppVisible && crossfade > 0 && effectiveDur > 0 && isFinite(effectiveDur) && isFinite(cur) && !isFadingIn) {
      const remaining = effectiveDur - cur;
      if (remaining <= crossfade && remaining > 0.3) {
        isFadingOut = true;
        const progress = Math.max(0, Math.min(1, remaining / crossfade));
        const targetVol = get().volume;
        audio.volume = Math.max(0, Math.min(targetVol, targetVol * progress));
      }
    }

    const now = Date.now();
    if (now - lastSyncTime > 1500) {
      lastSyncTime = now;
      updateMediaPositionState(cur, update.duration || get().duration);
      if (useSyncStore.getState().isLocalActive) {
        useSyncStore.getState().sendPlaybackState({ currentTime: cur, duration: update.duration || get().duration });
      }
    }
  };

  audio.onloadedmetadata = handleAudioDuration;
  audio.ondurationchange = handleAudioDuration;
  audio.oncanplay = handleAudioDuration;

  let isTransitioningTrack = false;

  audio.onended = () => {
    if (isTransitioningTrack) return;
    isTransitioningTrack = true;

    cancelFade();
    restoreTargetVolume();

    const { repeat, nextTrack } = get();
    if (repeat === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      if (useSyncStore.getState().isLocalActive) {
        useSyncStore.getState().sendPlaybackState({ currentTime: 0, isPlaying: true });
      }
      isTransitioningTrack = false;
    } else {
      nextTrack();
      setTimeout(() => {
        isTransitioningTrack = false;
      }, 600);
    }
  };

  // Re-sync on app visibility change (e.g. returning from Instagram / other apps)
  if (typeof window !== 'undefined') {
    const handleAppVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (audioCtx && (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted')) {
          audioCtx.resume().catch(() => {});
        }

        // Auto-resume after closing Instagram or other audio-stealing apps
        if (wasInterruptedByExternalApp && get().currentTrack) {
          console.log('[Audio] Returning from Instagram/external app. Restoring playback automatically...');
          wasInterruptedByExternalApp = false;
          isUserInitiatedPause = false;
          get().resume();
        } else if (get().currentTrack) {
          const actuallyPaused = audio.paused;
          if (get().isPlaying !== !actuallyPaused) {
            set({ isPlaying: !actuallyPaused });
          }
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = actuallyPaused ? 'paused' : 'playing';
          }
          updateMediaPositionState();
        }
      }
    };
    document.addEventListener('visibilitychange', handleAppVisibility);
    window.addEventListener('focus', handleAppVisibility);
  }

  // MediaSession Helper
  const updateMediaSession = (track: Track) => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album || 'Jellyfin Spotify',
        artwork: [
          { src: track.cover_url || '/favicon.svg', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' }
        ]
      });
      navigator.mediaSession.playbackState = get().isPlaying ? 'playing' : 'paused';

      navigator.mediaSession.setActionHandler('play', () => {
        isUserInitiatedPause = false;
        wasInterruptedByExternalApp = false;
        clearStandbyKeepaliveTimer();
        get().resume();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        isUserInitiatedPause = true;
        wasInterruptedByExternalApp = false;
        get().pause();
      });
      try {
        navigator.mediaSession.setActionHandler('stop', () => {
          isUserInitiatedPause = true;
          wasInterruptedByExternalApp = false;
          get().pause();
        });
      } catch (_) {}
      navigator.mediaSession.setActionHandler('previoustrack', () => get().prevTrack());
      navigator.mediaSession.setActionHandler('nexttrack', () => get().nextTrack());
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined && details.seekTime !== null) get().seek(details.seekTime);
      });
      try {
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
          const skipTime = details.seekOffset || 10;
          get().seek(Math.max(0, audio.currentTime - skipTime));
        });
      } catch (_) {}
      try {
        navigator.mediaSession.setActionHandler('seekforward', (details) => {
          const skipTime = details.seekOffset || 10;
          get().seek(Math.min(get().duration, audio.currentTime + skipTime));
        });
      } catch (_) {}
      updateMediaPositionState();
    }
  };

  let prefetchTimeout: any = null;
  let isPrefetching = false;

  const scheduleNextTrackPrefetch = () => {
    if (prefetchTimeout) clearTimeout(prefetchTimeout);
    // Trigger pre-buffering early (after 2 seconds) so playback is already solid
    prefetchTimeout = setTimeout(async () => {
      if (isPrefetching) return;
      isPrefetching = true;
      try {
        if (typeof navigator !== 'undefined' && !navigator.onLine) return;
        const { queue, currentIndex, currentTrack } = get();
        if (!queue || currentIndex < 0) return;

        // 1. Pre-buffer current track to CacheStorage in background (prevents cellular dropouts)
        if (currentTrack) {
          const isCurrCached = await isTrackCached(currentTrack.id);
          if (!isCurrCached) {
            cacheTrackOffline(currentTrack, 30000).catch(() => {});
          }
        }

        // 2. Aggressively prefetch up to 3 upcoming tracks in queue for 0ms instant transition
        const upcomingLimit = Math.min(queue.length, currentIndex + 4);
        for (let i = currentIndex + 1; i < upcomingLimit; i++) {
          const nextTrack = queue[i];
          if (!nextTrack) continue;

          const cached = await isTrackCached(nextTrack.id);
          if (!cached) {
            await cacheTrackOffline(nextTrack, 25000);
          }
          // Pre-warm Blob URL in memory
          getCachedTrackUrl(nextTrack.id).catch(() => {});
        }
      } catch (_) {
      } finally {
        isPrefetching = false;
      }
    }, 2000);
  };

  let isPrefetchingRecommendations = false;
  const prefetchRecommendationsIfNeeded = async () => {
    const { queue, currentIndex, smartShuffle } = get();
    if (!smartShuffle || isPrefetchingRecommendations) return;
    if (queue.length > 0 && currentIndex >= queue.length - 2) {
      isPrefetchingRecommendations = true;
      try {
        const lastTrack = queue[queue.length - 1];
        const data = await apiRequest<{ recommendations: any[] }>(
          `/recommendations?artists=${encodeURIComponent(lastTrack?.artist || '')}`,
          { timeoutMs: 4000 }
        );
        if (data.recommendations && data.recommendations.length > 0) {
          const existingIds = new Set(get().queue.map((t) => t.id));
          const newTracks = data.recommendations
            .filter((r) => !existingIds.has(r.id))
            .map((r) => ({
              id: r.id,
              title: r.title,
              artist: r.artist,
              album: r.album,
              duration_ms: r.duration_ms,
              cover_url: r.cover_url,
            }));
          if (newTracks.length > 0) {
            set((state) => ({ queue: [...state.queue, ...newTracks] }));
          }
        }
      } catch (_) {
      } finally {
        isPrefetchingRecommendations = false;
      }
    }
  };

  return {
    currentTrack: null,
    currentPlaylistId: null,
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
    crossfade: loadSavedCrossfade(),

    updateQueueIfCurrent: (playlistId: number, newTracks: Track[]) => {
      const { currentPlaylistId, currentTrack, queue } = get();
      if (currentPlaylistId !== playlistId || !newTracks || newTracks.length <= queue.length) return;
      const newIdx = currentTrack ? newTracks.findIndex((t) => t.id === currentTrack.id) : 0;
      set({
        queue: newTracks,
        currentIndex: newIdx >= 0 ? newIdx : get().currentIndex,
      });
    },

    playTrack: (track, newQueue, index, playlistId) => {
      clearStandbyKeepaliveTimer();
      const isLocal = useSyncStore.getState().isLocalActive;
      if (!isLocal) {
        useSyncStore.getState().sendRemoteCommand('playTrack', { track, queue: newQueue, index });
        set({
          currentTrack: track,
          queue: newQueue ? [...newQueue] : get().queue,
          currentIndex: index !== undefined ? index : 0,
          currentPlaylistId: playlistId !== undefined ? playlistId : get().currentPlaylistId,
          isPlaying: true,
        });
        return;
      }

      let q = newQueue ? [...newQueue] : get().queue;
      let idx = index !== undefined ? index : q.findIndex((t) => t.id === track.id);

      if (idx === -1) {
        q = [track, ...q];
        idx = 0;
      }

      const initialDur = (track.duration_ms && track.duration_ms > 0)
        ? track.duration_ms / 1000
        : 0;

      set({
        currentTrack: track,
        queue: q,
        originalQueue: newQueue ? [...newQueue] : get().originalQueue,
        currentIndex: idx,
        currentPlaylistId: playlistId !== undefined ? playlistId : get().currentPlaylistId,
        isPlaying: true,
        currentTime: 0,
        duration: initialDur,
      });

      ensureAudioGraph();
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }

      // Synchronous source assignment & playback for unbroken mobile background autoplay token
      const streamUrl = `/api/stream/${track.id}`;
      const syncBlobUrl = getSynchronousBlobUrl(track.id);
      const targetSrc = syncBlobUrl || streamUrl;

      if (!audio.src.endsWith(targetSrc) && audio.src !== targetSrc) {
        audio.src = targetSrc;
      }
      audio.currentTime = 0;

      if (get().crossfade > 0) {
        startFadeIn(Math.min(get().crossfade, 2.5));
      } else {
        restoreTargetVolume();
      }

      isUserInitiatedPause = false;
      wasInterruptedByExternalApp = false;
      ensureAudioKeepalive();
      requestScreenWakeLock();

      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn('[Audio play interrupted / autoplay]:', err);
          if (err.name === 'NotAllowedError' && typeof document !== 'undefined' && document.visibilityState === 'visible') {
            toast.info(tr('Click anywhere to enable audio on this device', 'Нажмите в любом месте для включения звука на этом устройстве'));
          }
        });
      }

      updateMediaSession(track);
      useSyncStore.getState().sendPlaybackState({ currentTime: 0, duration: initialDur, isPlaying: true });
      scheduleNextTrackPrefetch();
      prefetchRecommendationsIfNeeded();

      if (!syncBlobUrl) {
        getCachedTrackUrl(track.id).catch(() => {});
      }
    },

    playTrackLocally: (track, newQueue, index, startTime, autoPlay = true, playlistId) => {
      clearStandbyKeepaliveTimer();
      let q = newQueue && newQueue.length > 0 ? [...newQueue] : get().queue;
      let idx = index !== undefined && index >= 0 ? index : q.findIndex((t) => t.id === track.id);

      if (idx === -1) {
        q = [track, ...q];
        idx = 0;
      }

      const initialDur = (track.duration_ms && track.duration_ms > 0)
        ? track.duration_ms / 1000
        : 0;

      set({
        currentTrack: track,
        queue: q,
        originalQueue: newQueue && newQueue.length > 0 ? [...newQueue] : get().originalQueue,
        currentIndex: idx,
        currentPlaylistId: playlistId !== undefined ? playlistId : get().currentPlaylistId,
        isPlaying: autoPlay,
        currentTime: startTime || 0,
        duration: initialDur,
      });

      ensureAudioGraph();
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }

      const streamUrl = `/api/stream/${track.id}`;
      const syncBlobUrl = getSynchronousBlobUrl(track.id);
      const targetSrc = syncBlobUrl || streamUrl;
      const needsSourceChange = !audio.src.endsWith(targetSrc) && audio.src !== targetSrc;
      if (needsSourceChange) {
        audio.src = targetSrc;
      }

      const applySeek = () => {
        if (startTime && startTime > 0) {
          try {
            audio.currentTime = startTime;
          } catch (_) {}
        }
      };

      if (!needsSourceChange && audio.readyState >= 1) {
        applySeek();
      } else {
        audio.addEventListener('loadedmetadata', applySeek, { once: true });
      }

      if (autoPlay) {
        isUserInitiatedPause = false;
        wasInterruptedByExternalApp = false;
        ensureAudioKeepalive();
        requestScreenWakeLock();

        if ((!startTime || startTime <= 0.1) && get().crossfade > 0) {
          startFadeIn(Math.min(get().crossfade, 2.5));
        } else {
          restoreTargetVolume();
        }
        const p = audio.play();
        if (p !== undefined) {
          p.catch((err) => {
            console.warn('[Audio play interrupted / autoplay policy]:', err);
            if (err.name === 'NotAllowedError' && typeof document !== 'undefined' && document.visibilityState === 'visible') {
              toast.info(tr('Click anywhere to enable audio on this device', 'Нажмите в любом месте для включения звука на этом устройстве'));
            }
          });
        }
      } else {
        audio.pause();
      }

      updateMediaSession(track);
      useSyncStore.getState().sendPlaybackState();
      scheduleNextTrackPrefetch();
      prefetchRecommendationsIfNeeded();

      if (!syncBlobUrl) {
        getCachedTrackUrl(track.id).catch(() => {});
      }
    },

    stopLocalPlayback: () => {
      try {
        audio.pause();
      } catch (_) {}
      releaseAudioKeepalive();
      releaseScreenWakeLock();
    },

    shufflePlay: (tracks: Track[], playlistId?: number | null) => {
      clearStandbyKeepaliveTimer();
      if (!tracks || tracks.length === 0) return;

      const isLocal = useSyncStore.getState().isLocalActive;
      if (!isLocal) {
        useSyncStore.getState().sendRemoteCommand('shufflePlay', { tracks });
        return;
      }

      const original = [...tracks];
      const randomIndex = Math.floor(Math.random() * tracks.length);
      const chosenTrack = tracks[randomIndex];

      const remaining = tracks.filter((_, idx) => idx !== randomIndex);
      // Fisher-Yates shuffle remaining tracks
      for (let i = remaining.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
      }
      const shuffledQueue = [chosenTrack, ...remaining];
      const initialDur = (chosenTrack.duration_ms && chosenTrack.duration_ms > 0)
        ? chosenTrack.duration_ms / 1000
        : 0;

      set({
        currentTrack: chosenTrack,
        queue: shuffledQueue,
        originalQueue: original,
        currentIndex: 0,
        currentPlaylistId: playlistId !== undefined ? playlistId : get().currentPlaylistId,
        shuffle: true,
        isPlaying: true,
        currentTime: 0,
        duration: initialDur,
      });

      ensureAudioGraph();
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }

      const streamUrl = `/api/stream/${chosenTrack.id}`;
      const syncBlobUrl = getSynchronousBlobUrl(chosenTrack.id);
      const targetSrc = syncBlobUrl || streamUrl;
      if (!audio.src.endsWith(targetSrc) && audio.src !== targetSrc) {
        audio.src = targetSrc;
      }
      audio.currentTime = 0;

      if (get().crossfade > 0) {
        startFadeIn(Math.min(get().crossfade, 2.5));
      } else {
        restoreTargetVolume();
      }

      isUserInitiatedPause = false;
      wasInterruptedByExternalApp = false;
      ensureAudioKeepalive();
      requestScreenWakeLock();

      const p = audio.play();
      if (p !== undefined) {
        p.catch((err) => console.warn('[Audio play interrupted]:', err));
      }
      updateMediaSession(chosenTrack);
      useSyncStore.getState().sendPlaybackState({ currentTime: 0, duration: initialDur, isPlaying: true });
      scheduleNextTrackPrefetch();
      prefetchRecommendationsIfNeeded();

      if (!syncBlobUrl) {
        getCachedTrackUrl(chosenTrack.id).catch(() => {});
      }
    },

    togglePlay: () => {
      const { isPlaying, currentTrack } = get();
      if (!currentTrack) return;

      const isLocal = useSyncStore.getState().isLocalActive;
      if (!isLocal) {
        useSyncStore.getState().sendRemoteCommand('togglePlay');
        set({ isPlaying: !isPlaying });
        return;
      }

      if (isPlaying) {
        isUserInitiatedPause = true;
        wasInterruptedByExternalApp = false;
        scheduleStandbyKeepalive();
        releaseScreenWakeLock();
        audio.pause();
        set({ isPlaying: false });
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'paused';
        }
        updateMediaPositionState();
        useSyncStore.getState().sendPlaybackState({ isPlaying: false });
      } else {
        isUserInitiatedPause = false;
        wasInterruptedByExternalApp = false;
        clearStandbyKeepaliveTimer();
        ensureAudioKeepalive();
        requestScreenWakeLock();

        ensureAudioGraph();
        if (audioCtx && (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted')) {
          audioCtx.resume().catch(() => {});
        }

        // If audio element is errored, stalled or in empty network state from dropped connection
        const isBroken = audio.error !== null ||
          audio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE ||
          (audio.readyState === 0 && Boolean(audio.src));

        if (isBroken) {
          console.log('[togglePlay] Audio element is in error/stalled state, running recoverAudioStream...');
          recoverAudioStream(audio.currentTime > 0 ? audio.currentTime : get().currentTime, true);
        } else {
          audio.play().then(() => {
            set({ isPlaying: true });
            if ('mediaSession' in navigator) {
              navigator.mediaSession.playbackState = 'playing';
            }
            updateMediaPositionState();
            useSyncStore.getState().sendPlaybackState({ isPlaying: true });
          }).catch((err) => {
            console.warn('[togglePlay play failed, attempting recovery]:', err);
            recoverAudioStream(audio.currentTime > 0 ? audio.currentTime : get().currentTime, true);
          });
        }
      }
    },

    pause: () => {
      cancelFade();
      isUserInitiatedPause = true;
      wasInterruptedByExternalApp = false;
      scheduleStandbyKeepalive();
      releaseScreenWakeLock();

      const isLocal = useSyncStore.getState().isLocalActive;
      if (!isLocal) {
        useSyncStore.getState().sendRemoteCommand('pause');
      } else {
        audio.pause();
      }
      set({ isPlaying: false });
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
      updateMediaPositionState();
      useSyncStore.getState().sendPlaybackState({ isPlaying: false });
    },

    resume: () => {
      const { currentTrack } = get();
      if (!currentTrack) return;

      isUserInitiatedPause = false;
      wasInterruptedByExternalApp = false;
      clearStandbyKeepaliveTimer();
      ensureAudioKeepalive();
      requestScreenWakeLock();

      const isLocal = useSyncStore.getState().isLocalActive;
      if (!isLocal) {
        useSyncStore.getState().sendRemoteCommand('play');
        set({ isPlaying: true });
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
        updateMediaPositionState();
        return;
      }

      ensureAudioGraph();
      if (audioCtx && (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted')) {
        audioCtx.resume().catch(() => {});
      }

      const isBroken = audio.error !== null ||
        audio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE ||
        (audio.readyState === 0 && Boolean(audio.src));

      if (isBroken) {
        console.log('[resume] Audio element is in error/stalled state, running recoverAudioStream...');
        recoverAudioStream(audio.currentTime > 0 ? audio.currentTime : get().currentTime, true);
      } else {
        audio.play().then(() => {
          set({ isPlaying: true });
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
          }
          updateMediaPositionState();
          useSyncStore.getState().sendPlaybackState({ isPlaying: true });
        }).catch((err) => {
          console.warn('[resume play failed, attempting recovery]:', err);
          recoverAudioStream(audio.currentTime > 0 ? audio.currentTime : get().currentTime, true);
        });
      }
    },

    nextTrack: async () => {
      cancelFade();
      restoreTargetVolume();

      const isLocal = useSyncStore.getState().isLocalActive;
      if (!isLocal) {
        useSyncStore.getState().sendRemoteCommand('next');
        return;
      }

      const { queue, currentIndex, repeat, smartShuffle, playTrack, currentPlaylistId } = get();
      if (queue.length === 0) return;

      let nextIndex = currentIndex + 1;

      // 1. Fast instant track change without network blocking!
      if (nextIndex < queue.length) {
        playTrack(queue[nextIndex], queue, nextIndex, currentPlaylistId);
        return;
      }

      // 2. Queue ended: loop back if repeat all
      if (repeat === 'all') {
        playTrack(queue[0], queue, 0, currentPlaylistId);
        return;
      }

      // 3. If currently playing a playlist, check if new tracks finished downloading on server
      if (currentPlaylistId && currentPlaylistId > 0) {
        try {
          const data = await apiRequest<{ tracks: Track[] }>(`/playlists/${currentPlaylistId}`, { timeoutMs: 3000 });
          if (data.tracks && data.tracks.length > queue.length) {
            const currentId = queue[currentIndex]?.id;
            const newIdx = data.tracks.findIndex((t) => t.id === currentId);
            if (newIdx !== -1 && newIdx + 1 < data.tracks.length) {
              set({ queue: data.tracks, currentIndex: newIdx });
              playTrack(data.tracks[newIdx + 1], data.tracks, newIdx + 1, currentPlaylistId);
              return;
            }
          }
        } catch (_) {}
      }

      // 4. Smart shuffle fallback if recommendations weren't already pre-fetched
      if (smartShuffle) {
        try {
          const current = queue[currentIndex];
          const data = await apiRequest<{ recommendations: any[] }>(
            `/recommendations?artists=${encodeURIComponent(current?.artist || '')}`,
            { timeoutMs: 4000 }
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
            playTrack(newTracks[0], updatedQueue, nextIndex, null);
            return;
          }
        } catch (e) {
          console.warn('[Smart shuffle error]:', e);
        }
      }

      // End of playback
      set({ isPlaying: false });
      releaseAudioKeepalive();
      releaseScreenWakeLock();
      useSyncStore.getState().sendPlaybackState({ isPlaying: false });
    },

    prevTrack: () => {
      cancelFade();
      const isLocal = useSyncStore.getState().isLocalActive;
      if (!isLocal) {
        useSyncStore.getState().sendRemoteCommand('prev');
        return;
      }

      const { queue, currentIndex, playTrack } = get();
      if (queue.length === 0) return;

      if (audio.currentTime > 3) {
        audio.currentTime = 0;
        set({ currentTime: 0 });
        useSyncStore.getState().sendPlaybackState({ currentTime: 0 });
        return;
      }

      let prevIndex = currentIndex - 1;
      if (prevIndex < 0) {
        prevIndex = queue.length - 1;
      }
      playTrack(queue[prevIndex], queue, prevIndex);
    },

    seek: (seconds: number) => {
      restoreTargetVolume();
      const isLocal = useSyncStore.getState().isLocalActive;
      if (!isLocal) {
        useSyncStore.getState().sendRemoteCommand('seek', seconds);
      } else {
        if (audio.error !== null || audio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
          recoverAudioStream(seconds, get().isPlaying);
        } else {
          try {
            audio.currentTime = seconds;
          } catch (_) {
            recoverAudioStream(seconds, get().isPlaying);
          }
        }
      }
      set({ currentTime: seconds });
      updateMediaPositionState(seconds, get().duration);
      useSyncStore.getState().sendPlaybackState({ currentTime: seconds });
    },

    setVolume: (val: number) => {
      const clamped = Math.max(0, Math.min(1, val));
      if (!isFadingIn && !isFadingOut) {
        audio.volume = clamped;
      }
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

      if (useSyncStore.getState().isLocalActive) {
        useSyncStore.getState().sendPlaybackState();
      } else {
        useSyncStore.getState().sendRemoteCommand('toggleShuffle');
      }
    },

    toggleSmartShuffle: () => {
      set({ smartShuffle: !get().smartShuffle });
    },

    toggleRepeat: () => {
      const current = get().repeat;
      const modes: RepeatMode[] = ['off', 'all', 'one'];
      const nextIdx = (modes.indexOf(current) + 1) % modes.length;
      const nextMode = modes[nextIdx];
      set({ repeat: nextMode });

      if (useSyncStore.getState().isLocalActive) {
        useSyncStore.getState().sendPlaybackState({ repeat: nextMode });
      } else {
        useSyncStore.getState().sendRemoteCommand('repeat', nextMode);
      }
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

    likedTrackIds: loadSavedLikedIds(),

    loadLikes: async () => {
      try {
        const data = await apiRequest<{ tracks: Track[] }>('/likes', { timeoutMs: 5000 });
        const tracks = data.tracks || [];
        const ids = tracks.map((t) => t.id);
        set({ likedTrackIds: ids });
        localStorage.setItem(STORAGE_KEY_LIKED_IDS, JSON.stringify(ids));
        localStorage.setItem('jellyfy_cached_liked_tracks', JSON.stringify(tracks));
        saveOfflinePlaylistData({
          id: -1,
          name: 'Любимые треки',
          description: 'Ваша медиатека сохраненных композиций',
          created_at: new Date().toISOString(),
          track_count: tracks.length,
        }, tracks);
      } catch (e) {
        const saved = loadSavedLikedIds();
        if (saved && saved.length > 0) {
          set({ likedTrackIds: saved });
        }
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
        const res = await apiRequest<{ liked: boolean }>(`/likes/${trackId}`, { method: 'POST', timeoutMs: 6000 });
        const updated = res.liked
          ? Array.from(new Set([...get().likedTrackIds, trackId]))
          : get().likedTrackIds.filter((id) => id !== trackId);
        set({ likedTrackIds: updated });
        localStorage.setItem(STORAGE_KEY_LIKED_IDS, JSON.stringify(updated));

        // Auto-cache track if Liked Songs is downloaded offline
        if (res.liked && useOfflineStore.getState().isDownloaded(-1)) {
          const currentT = get().currentTrack?.id === trackId ? get().currentTrack : get().queue.find((t) => t.id === trackId);
          if (currentT) {
            useOfflineStore.getState().cacheTrack(currentT);
          }
        }

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
      ensureAudioGraph(true);
      const bands = [...get().eqBands];
      bands[bandIndex] = gain;
      if (eqFilters[bandIndex] && audioCtx) {
        eqFilters[bandIndex].gain.setValueAtTime(gain, audioCtx.currentTime);
      }
      localStorage.setItem(STORAGE_KEY_EQ_BANDS, JSON.stringify(bands));
      set({ eqBands: bands, eqPreset: 'custom' });
      updateAudioGraphRouting();
    },

    setEqPreset: (presetId: string) => {
      const preset = EQ_PRESETS[presetId];
      if (!preset) return;

      const isFlat = presetId === 'flat';
      if (!isFlat) {
        ensureAudioGraph(true);
      }

      const bands = [...preset.bands];
      bands.forEach((g, i) => {
        if (eqFilters[i] && audioCtx) {
          eqFilters[i].gain.setValueAtTime(g, audioCtx.currentTime);
        }
      });
      localStorage.setItem(STORAGE_KEY_EQ_BANDS, JSON.stringify(bands));
      localStorage.setItem(STORAGE_KEY_EQ_PRESET, presetId);
      set({ eqBands: bands, eqPreset: presetId });
      updateAudioGraphRouting();
    },

    toggleNormalizer: () => {
      const current = get().isNormalizerEnabled;
      const next = !current;
      if (next) {
        ensureAudioGraph(true);
      }
      localStorage.setItem(STORAGE_KEY_NORMALIZER, String(next));
      set({ isNormalizerEnabled: next });
      updateAudioGraphRouting();
    },

    resetEqualizer: () => {
      get().setEqPreset('flat');
    },

    setCrossfade: (seconds: number) => {
      const clamped = Math.max(0, Math.min(12, seconds));
      localStorage.setItem(STORAGE_KEY_CROSSFADE, clamped.toString());
      set({ crossfade: clamped });
    },
  };
});

// Global network change listeners for automatic stream recovery & offline resilience
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    console.log('[Player] Network connection restored (online event)');
    const state = usePlayerStore.getState();
    if (state.currentTrack) {
      const isBroken = audio.error !== null ||
        audio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE ||
        audio.readyState < 2;

      if (isBroken || state.isPlaying) {
        console.log('[Player] Triggering automatic stream recovery on network restore...');
        recoverAudioStream(audio.currentTime > 0 ? audio.currentTime : state.currentTime, state.isPlaying);
      }
    }
  });

  window.addEventListener('offline', () => {
    console.warn('[Player] Network connection lost (offline event)');
    const state = usePlayerStore.getState();
    if (state.currentTrack && !audio.src.startsWith('blob:')) {
      // Seamlessly switch to offline cached blob if available
      getCachedTrackUrl(state.currentTrack.id).then((blobUrl) => {
        if (blobUrl) {
          console.log('[Player] Switching to local offline blob URL during network loss');
          const curTime = audio.currentTime;
          audio.src = blobUrl;
          const applySeek = () => {
            try { audio.currentTime = curTime; } catch (_) {}
            if (state.isPlaying) audio.play().catch(() => {});
          };
          if (audio.readyState >= 1) applySeek();
          else audio.addEventListener('loadedmetadata', applySeek, { once: true });
        }
      }).catch(() => {});
    }
  });
}
