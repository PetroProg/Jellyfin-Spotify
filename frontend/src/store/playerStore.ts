import { create } from 'zustand';
import { Track, RepeatMode } from '../types';
import { apiRequest } from '../api/client';
import { useSyncStore } from './syncStore';
import { toast } from './toastStore';
import { tr } from './i18nStore';
import { useOfflineStore } from './offlineStore';
import {
  getCachedTrackUrl,
  isTrackCached,
  cacheTrackOffline,
  saveOfflinePlaylistData,
  getSynchronousBlobUrl,
  prewarmQueueBlobUrls,
  shouldTrackBeCachedOffline,
  addTrackToOfflinePlaylist,
  removeTrackFromOfflinePlaylist,
  isTrackDownloadedLocally
} from '../utils/offline';

export const EQ_FREQUENCIES = [60, 230, 910, 3600, 14000];

export const EQ_PRESETS: Record<string, { label: string; labelEn: string; bands: number[] }> = {
  flat: { label: 'Оригинал (Flat)', labelEn: 'Original (Flat)', bands: [0, 0, 0, 0, 0] },
  bass: { label: 'Усиление басов', labelEn: 'Bass Boost', bands: [5.5, 3.5, 0, 0.5, 1] },
  rock: { label: 'Рок', labelEn: 'Rock', bands: [3.5, 2, -0.5, 2, 2.5] },
  pop: { label: 'Поп', labelEn: 'Pop', bands: [-0.5, 1.5, 2.5, 2, 2] },
  vocal: { label: 'Чистый вокал', labelEn: 'Clean Vocal', bands: [-1.5, 0, 3.5, 2.5, 1] },
  electronic: { label: 'Электроника', labelEn: 'Electronic', bands: [5, 3, 0, 2, 2.5] },
  hiphop: { label: 'Хип-хоп', labelEn: 'Hip-Hop', bands: [6, 4, 0, 1, 1.5] },
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
  toggleLikeTrack: (trackId: number, trackObj?: Track, forceState?: boolean) => Promise<boolean>;
  blacklistTrack: (track: Track) => Promise<void>;

  setEqGain: (bandIndex: number, gain: number) => void;
  setEqPreset: (presetId: string) => void;
  toggleNormalizer: () => void;
  setEqualizerOpen: (open: boolean) => void;
  resetEqualizer: () => void;
  setCrossfade: (seconds: number) => void;
  applyAccountSettings: (settings: Record<string, string>) => void;
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

// Inaudible looping silent audio element to keep Android/Samsung One UI OS audio session alive ONLY when paused
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
        // Never loop silent audio if main music is playing!
        if (!usePlayerStore.getState().isPlaying && standbyKeepaliveTimer) {
          keepAliveAudio?.play().catch(() => {});
        }
      };
    }
    if (keepAliveAudio.paused && !usePlayerStore.getState().isPlaying) {
      keepAliveAudio.play().catch(() => {});
    }
  } catch (_) {}
}

function scheduleStandbyKeepalive() {
  clearStandbyKeepaliveTimer();
  // Keep silent audio playing only during pause so Android OS maintains active audio focus and lockscreen controls
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
      keepAliveAudio.currentTime = 0;
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

// Web Audio API Graph (Dual-Path Studio Engine: True Bit-Perfect Direct Bypass + Calibrated Studio DSP)
let audioCtx: AudioContext | null = null;
let sourceNode: MediaElementAudioSourceNode | null = null;
let dryGainNode: GainNode | null = null;
let wetGainNode: GainNode | null = null;
let preAmpGainNode: GainNode | null = null;
let eqFilters: BiquadFilterNode[] = [];
let compressorNode: DynamicsCompressorNode | null = null;
let fadeGainNode: GainNode | null = null;
let isAudioGraphAttached = false;

function applyFadeVolume(volFraction: number) {
  const target = usePlayerStore.getState().volume;
  const clampedFraction = Math.max(0, Math.min(1, volFraction));
  if (audioCtx && fadeGainNode) {
    fadeGainNode.gain.setTargetAtTime(clampedFraction, audioCtx.currentTime, 0.03);
    audio.volume = target;
  } else {
    audio.volume = Math.max(0, Math.min(1, clampedFraction * target));
  }
}

function cancelFade() {
  if (fadeInterval) {
    clearInterval(fadeInterval);
    fadeInterval = null;
  }
  isFadingIn = false;
  isFadingOut = false;
  applyFadeVolume(1.0);
}

function restoreTargetVolume() {
  cancelFade();
  applyFadeVolume(1.0);
}

function startFadeIn(durationSec: number) {
  cancelFade();
  const target = usePlayerStore.getState().volume;

  // If in background, immediately set target volume without waiting for throttled setInterval!
  if (typeof document !== 'undefined' && document.hidden) {
    applyFadeVolume(1.0);
    return;
  }

  if (target <= 0.01 || durationSec <= 0) {
    applyFadeVolume(1.0);
    return;
  }

  isFadingIn = true;

  if (audioCtx && fadeGainNode) {
    fadeGainNode.gain.cancelScheduledValues(audioCtx.currentTime);
    fadeGainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    fadeGainNode.gain.linearRampToValueAtTime(1.0, audioCtx.currentTime + durationSec);
    setTimeout(() => {
      isFadingIn = false;
      applyFadeVolume(1.0);
    }, durationSec * 1000);
    return;
  }

  audio.volume = 0;
  const startTime = performance.now();
  const fadeMs = durationSec * 1000;

  fadeInterval = setInterval(() => {
    // If app becomes hidden during fade, finish immediately
    if (typeof document !== 'undefined' && document.hidden) {
      clearInterval(fadeInterval);
      fadeInterval = null;
      isFadingIn = false;
      applyFadeVolume(1.0);
      return;
    }

    const elapsed = performance.now() - startTime;
    const progress = Math.min(1, elapsed / fadeMs);
    applyFadeVolume(progress);

    if (progress >= 1) {
      clearInterval(fadeInterval);
      fadeInterval = null;
      isFadingIn = false;
      applyFadeVolume(1.0);
    }
  }, 40);
}

function updateDspRouting(bands: number[], isNormalizer: boolean) {
  if (!audioCtx || !dryGainNode || !wetGainNode) return;
  const isBitPerfect = !isNormalizer && bands.every((b) => b === 0);
  const now = audioCtx.currentTime;

  if (isBitPerfect) {
    // Direct dry bypass: 100% clean original signal, zero filters, zero phase delay
    dryGainNode.gain.setTargetAtTime(1.0, now, 0.02);
    wetGainNode.gain.setTargetAtTime(0.0, now, 0.02);
  } else {
    // Active Studio DSP chain
    dryGainNode.gain.setTargetAtTime(0.0, now, 0.02);
    wetGainNode.gain.setTargetAtTime(1.0, now, 0.02);
  }
}

function applyHeadroom(bands: number[]) {
  if (!audioCtx || !preAmpGainNode) return;
  const maxBoost = Math.max(0, ...bands);
  // Gentle headroom: only attenuate by ~25% of max boost up to 1.5 dB max
  const headroomDb = maxBoost > 0 ? -Math.min(maxBoost * 0.25, 1.5) : 0;
  const preAmpLinear = Math.pow(10, headroomDb / 20);
  preAmpGainNode.gain.setTargetAtTime(preAmpLinear, audioCtx.currentTime, 0.02);
}

function updateFilterGains(bands: number[]) {
  if (!audioCtx) return;
  for (let i = 0; i < eqFilters.length; i++) {
    const targetGain = bands[i] ?? 0;
    eqFilters[i].gain.setTargetAtTime(targetGain, audioCtx.currentTime, 0.02);
  }
  applyHeadroom(bands);
  const isNorm = usePlayerStore.getState().isNormalizerEnabled;
  updateDspRouting(bands, isNorm);
}

function updateNormalizer(enabled: boolean) {
  if (!audioCtx || !compressorNode) return;
  if (enabled) {
    compressorNode.threshold.setTargetAtTime(-14, audioCtx.currentTime, 0.02);
    compressorNode.knee.setTargetAtTime(12, audioCtx.currentTime, 0.02);
    compressorNode.ratio.setTargetAtTime(2.0, audioCtx.currentTime, 0.02);
    compressorNode.attack.setTargetAtTime(0.03, audioCtx.currentTime, 0.02);
    compressorNode.release.setTargetAtTime(0.25, audioCtx.currentTime, 0.02);
  } else {
    compressorNode.threshold.setTargetAtTime(0, audioCtx.currentTime, 0.02);
    compressorNode.ratio.setTargetAtTime(1, audioCtx.currentTime, 0.02);
  }
  const bands = usePlayerStore.getState().eqBands;
  updateDspRouting(bands, enabled);
}

function ensureAudioGraph() {
  if (isAudioGraphAttached && audioCtx) return;

  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    audioCtx = new AudioContextClass();
    sourceNode = audioCtx.createMediaElementSource(audio);
    isAudioGraphAttached = true;

    // 1. Dry Direct Path (100% Bit-Perfect Bypass, zero filters, zero latency)
    dryGainNode = audioCtx.createGain();

    // 2. Wet DSP Path (Studio Equalizer + Dynamics Compressor)
    wetGainNode = audioCtx.createGain();

    // 3. Dynamic Headroom Pre-Amplifier
    preAmpGainNode = audioCtx.createGain();
    preAmpGainNode.gain.value = 1.0;

    // 4. 5-Band Studio Equalizer (Butterworth Q=0.707 for natural acoustic transition without ringing)
    const savedBands = loadSavedEqBands();
    eqFilters = EQ_FREQUENCIES.map((freq, idx) => {
      const filter = audioCtx!.createBiquadFilter();
      if (idx === 0) {
        filter.type = 'lowshelf';
      } else if (idx === EQ_FREQUENCIES.length - 1) {
        filter.type = 'highshelf';
      } else {
        filter.type = 'peaking';
      }
      filter.Q.value = 0.707; // Natural Butterworth critical damping
      filter.frequency.value = freq;
      filter.gain.value = savedBands[idx] || 0;
      return filter;
    });

    // 5. Studio Dynamics Compressor (Transparent Peak Leveling)
    compressorNode = audioCtx.createDynamicsCompressor();
    const isNorm = loadSavedNormalizer();
    if (isNorm) {
      compressorNode.threshold.value = -14;
      compressorNode.knee.value = 12;
      compressorNode.ratio.value = 2.0;
      compressorNode.attack.value = 0.03; // 30ms preserves drum and vocal punch
      compressorNode.release.value = 0.25;
    } else {
      compressorNode.threshold.value = 0;
      compressorNode.ratio.value = 1;
    }

    // 6. Smooth Crossfade Gain Node
    fadeGainNode = audioCtx.createGain();
    fadeGainNode.gain.value = 1.0;

    // Connect dual path:
    // DRY PATH: sourceNode -> dryGainNode -> fadeGainNode -> destination
    sourceNode.connect(dryGainNode);
    dryGainNode.connect(fadeGainNode);

    // WET PATH: sourceNode -> wetGainNode -> preAmp -> [filters] -> compressor -> fadeGainNode -> destination
    sourceNode.connect(wetGainNode);
    wetGainNode.connect(preAmpGainNode);
    let lastWetNode: AudioNode = preAmpGainNode;
    for (const filter of eqFilters) {
      lastWetNode.connect(filter);
      lastWetNode = filter;
    }
    lastWetNode.connect(compressorNode);
    compressorNode.connect(fadeGainNode);

    // Common Output: fadeGainNode -> destination
    fadeGainNode.connect(audioCtx.destination);

    applyHeadroom(savedBands);
    updateDspRouting(savedBands, isNorm);
  } catch (err) {
    console.warn('[Web Audio API Init Error]:', err);
  }
}

function checkAndInitAudioGraph() {
  const isBitPerfect = loadSavedEqPreset() === 'flat' && !loadSavedNormalizer() && loadSavedEqBands().every((b) => b === 0);
  if (!isBitPerfect) {
    ensureAudioGraph();
  }
}

function startPlaybackForTrack(track: Track, startTime = 0, autoPlay = true) {
  const syncBlobUrl = getSynchronousBlobUrl(track.id);
  const streamUrl = `/api/stream/${track.id}`;

  const applyPlayback = (targetSrc: string) => {
    const needsChange = !audio.src.endsWith(targetSrc) && audio.src !== targetSrc;
    if (needsChange) {
      audio.src = targetSrc;
    }

    const applySeek = () => {
      try {
        if (startTime > 0) audio.currentTime = startTime;
      } catch (_) {}
    };

    if (!needsChange && audio.readyState >= 1) {
      applySeek();
    } else {
      audio.addEventListener('loadedmetadata', applySeek, { once: true });
    }

    if (autoPlay) {
      isUserInitiatedPause = false;
      wasInterruptedByExternalApp = false;
      releaseAudioKeepalive();
      requestScreenWakeLock();

      if ((!startTime || startTime <= 0.1) && usePlayerStore.getState().crossfade > 0) {
        startFadeIn(Math.min(usePlayerStore.getState().crossfade, 2.5));
      } else {
        restoreTargetVolume();
      }

      const p = audio.play();
      if (p !== undefined) {
        p.catch((err) => {
          console.warn('[Audio play interrupted / autoplay]:', err);
          if (err.name === 'NotAllowedError' && typeof document !== 'undefined' && document.visibilityState === 'visible') {
            toast.info(tr('Click anywhere to enable audio on this device', 'Нажмите в любом месте для включения звука на этом устройстве'));
          }
        });
      }
    } else {
      audio.pause();
    }
  };

  // 1. If synchronous blob URL is already available in memory, play directly!
  if (syncBlobUrl) {
    applyPlayback(syncBlobUrl);
    return;
  }

  // 2. If track is downloaded locally in cache storage: load blob before starting playback!
  if (isTrackDownloadedLocally(track.id)) {
    getCachedTrackUrl(track.id).then((blobUrl) => {
      if (usePlayerStore.getState().currentTrack?.id === track.id) {
        applyPlayback(blobUrl || streamUrl);
      }
    }).catch(() => {
      if (usePlayerStore.getState().currentTrack?.id === track.id) {
        applyPlayback(streamUrl);
      }
    });
    return;
  }

  // 3. Track not downloaded: stream directly from server
  applyPlayback(streamUrl);
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
      checkAndInitAudioGraph();
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

  // Resilient background prefetch controller with network-priority abort
  let prefetchTimeout: any = null;
  let isPrefetching = false;
  let prefetchAbortController: AbortController | null = null;

  const cancelActivePrefetch = () => {
    if (prefetchTimeout) {
      clearTimeout(prefetchTimeout);
      prefetchTimeout = null;
    }
    if (prefetchAbortController) {
      try {
        prefetchAbortController.abort();
      } catch (_) {}
      prefetchAbortController = null;
    }
    isPrefetching = false;
  };

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
    // Release silent keepalive during active playback to eliminate Bluetooth mixer stutter & dropouts
    releaseAudioKeepalive();
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
    cancelActivePrefetch();
    if (get().isPlaying && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
    // WAN buffer resilience: give connection up to 10 seconds before force-reconnecting
    if (waitingTimeout) clearTimeout(waitingTimeout);
    waitingTimeout = setTimeout(() => {
      if (get().isPlaying && audio.readyState < 3) {
        console.warn('[Audio Waiting]: Stalled waiting for buffer for >10s, reconnecting stream...');
        recoverAudioStream(audio.currentTime || get().currentTime, true);
      }
    }, 10000);
  };

  audio.onstalled = () => {
    cancelActivePrefetch();
    if (!get().isPlaying) return;
    if (stallTimeout) clearTimeout(stallTimeout);
    stallTimeout = setTimeout(() => {
      if (get().isPlaying && audio.readyState < 3) {
        console.warn('[Audio Stalled]: Stream stalled for >12s, reconnecting stream...');
        recoverAudioStream(audio.currentTime || get().currentTime, true);
      }
    }, 12000);
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
        applyFadeVolume(progress);
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

  const isBufferSafeForPrefetch = (): boolean => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
    if (!audio.duration || !isFinite(audio.duration) || audio.duration <= 0) return false;

    const cur = audio.currentTime;
    // Don't prefetch during the first 8 seconds to give the active track 100% bandwidth
    if (cur < 8) return false;

    for (let i = 0; i < audio.buffered.length; i++) {
      if (audio.buffered.start(i) <= cur && cur <= audio.buffered.end(i)) {
        const bufferedAhead = audio.buffered.end(i) - cur;
        // Current track must have at least 20 seconds buffered ahead (or reached EOF)
        return bufferedAhead >= 20 || audio.buffered.end(i) >= (audio.duration - 1);
      }
    }
    return false;
  };

  const scheduleNextTrackPrefetch = () => {
    cancelActivePrefetch();

    let attempts = 0;
    const maxAttempts = 15;

    const attemptPrefetch = async () => {
      if (isPrefetching) return;
      const { queue, currentIndex, currentTrack, isPlaying } = get();
      if (!isPlaying || !currentTrack || !queue || currentIndex < 0) return;

      if (!isBufferSafeForPrefetch()) {
        attempts++;
        if (attempts < maxAttempts) {
          prefetchTimeout = setTimeout(attemptPrefetch, 3000);
        }
        return;
      }

      const nextIndex = currentIndex + 1;
      if (nextIndex >= queue.length) return;
      const nextTrack = queue[nextIndex];
      if (!nextTrack) return;

      const cached = await isTrackCached(nextTrack.id);
      if (cached) {
        getCachedTrackUrl(nextTrack.id).catch(() => {});
        return;
      }

      isPrefetching = true;
      prefetchAbortController = new AbortController();

      try {
        console.log(`[Smart Prefetch] WAN buffer is healthy. Pre-buffering next track: "${nextTrack.title}"`);
        await cacheTrackOffline(nextTrack, 35000, prefetchAbortController.signal);
        await getCachedTrackUrl(nextTrack.id);
        console.log(`[Smart Prefetch] Next track "${nextTrack.title}" ready as local Blob URL`);
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          console.warn('[Smart Prefetch] Prefetch error:', err);
        }
      } finally {
        isPrefetching = false;
        prefetchAbortController = null;
      }
    };

    // First check after 8 seconds of steady playback
    prefetchTimeout = setTimeout(attemptPrefetch, 8000);
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

      checkAndInitAudioGraph();
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }

      startPlaybackForTrack(track, 0, true);

      updateMediaSession(track);
      useSyncStore.getState().sendPlaybackState({ currentTime: 0, duration: initialDur, isPlaying: true });
      scheduleNextTrackPrefetch();
      prefetchRecommendationsIfNeeded();
      prewarmQueueBlobUrls(q, idx + 1, 3);
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

      checkAndInitAudioGraph();
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }

      startPlaybackForTrack(track, startTime || 0, autoPlay);

      updateMediaSession(track);
      useSyncStore.getState().sendPlaybackState();
      scheduleNextTrackPrefetch();
      prefetchRecommendationsIfNeeded();
      prewarmQueueBlobUrls(q, idx + 1, 3);
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

      checkAndInitAudioGraph();
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }

      startPlaybackForTrack(chosenTrack, 0, true);

      updateMediaSession(chosenTrack);
      useSyncStore.getState().sendPlaybackState({ currentTime: 0, duration: initialDur, isPlaying: true });
      scheduleNextTrackPrefetch();
      prefetchRecommendationsIfNeeded();
      prewarmQueueBlobUrls(shuffledQueue, 1, 3);
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
        releaseAudioKeepalive();
        requestScreenWakeLock();

        checkAndInitAudioGraph();
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
      releaseAudioKeepalive();
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

      checkAndInitAudioGraph();
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

    toggleLikeTrack: async (trackId: number, trackObj?: Track, forceState?: boolean) => {
      const { likedTrackIds } = get();
      const isCurrentlyLiked = likedTrackIds.includes(trackId);
      const targetState = forceState !== undefined ? forceState : !isCurrentlyLiked;
      const newLiked = targetState
        ? Array.from(new Set([...likedTrackIds, trackId]))
        : likedTrackIds.filter((id) => id !== trackId);

      set({ likedTrackIds: newLiked });
      try {
        localStorage.setItem(STORAGE_KEY_LIKED_IDS, JSON.stringify(newLiked));
      } catch (_) {}

      try {
        const res = await apiRequest<{ liked: boolean }>(`/likes/${trackId}`, {
          method: 'POST',
          body: JSON.stringify({ liked: targetState }),
          timeoutMs: 6000,
        });
        const finalLiked = res.liked;
        const updated = finalLiked
          ? Array.from(new Set([...get().likedTrackIds, trackId]))
          : get().likedTrackIds.filter((id) => id !== trackId);
        set({ likedTrackIds: updated });
        try {
          localStorage.setItem(STORAGE_KEY_LIKED_IDS, JSON.stringify(updated));
        } catch (_) {}

        const targetTrack = trackObj || (get().currentTrack?.id === trackId ? get().currentTrack : get().queue.find((t) => t.id === trackId));

        if (finalLiked) {
          if (targetTrack) {
            // Auto-cache track if Liked Songs or any containing playlist is downloaded on this device!
            if (shouldTrackBeCachedOffline(trackId, -1, updated)) {
              useOfflineStore.getState().cacheTrack(targetTrack);
            }
            if (useOfflineStore.getState().isDownloaded(-1)) {
              addTrackToOfflinePlaylist(-1, targetTrack);
            }
          }
        } else {
          removeTrackFromOfflinePlaylist(-1, trackId);
        }

        return finalLiked;
      } catch (err) {
        set({ likedTrackIds });
        try {
          localStorage.setItem(STORAGE_KEY_LIKED_IDS, JSON.stringify(likedTrackIds));
        } catch (_) {}
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
      updateFilterGains(bands);
      try { localStorage.setItem(STORAGE_KEY_EQ_BANDS, JSON.stringify(bands)); } catch (_) {}
      set({ eqBands: bands, eqPreset: 'custom' });
      apiRequest('/user/settings', {
        method: 'PUT',
        body: JSON.stringify({ eqPreset: 'custom', eqBands: JSON.stringify(bands) })
      }).catch(() => {});
    },

    setEqPreset: (presetId: string) => {
      const preset = EQ_PRESETS[presetId];
      if (!preset) return;

      ensureAudioGraph();
      const bands = [...preset.bands];
      updateFilterGains(bands);
      try {
        localStorage.setItem(STORAGE_KEY_EQ_BANDS, JSON.stringify(bands));
        localStorage.setItem(STORAGE_KEY_EQ_PRESET, presetId);
      } catch (_) {}
      set({ eqBands: bands, eqPreset: presetId });
      apiRequest('/user/settings', {
        method: 'PUT',
        body: JSON.stringify({ eqPreset: presetId, eqBands: JSON.stringify(bands) })
      }).catch(() => {});
    },

    toggleNormalizer: () => {
      ensureAudioGraph();
      const current = get().isNormalizerEnabled;
      const next = !current;
      updateNormalizer(next);
      try { localStorage.setItem(STORAGE_KEY_NORMALIZER, String(next)); } catch (_) {}
      set({ isNormalizerEnabled: next });
      apiRequest('/user/settings', {
        method: 'PUT',
        body: JSON.stringify({ isNormalizerEnabled: String(next) })
      }).catch(() => {});
    },

    resetEqualizer: () => {
      get().setEqPreset('flat');
    },

    setCrossfade: (seconds: number) => {
      const clamped = Math.max(0, Math.min(12, seconds));
      try {
        localStorage.setItem(STORAGE_KEY_CROSSFADE, clamped.toString());
      } catch (_) {}
      set({ crossfade: clamped });

      // Save to user account on server so all devices/browsers share the exact same crossfade setting
      apiRequest('/user/settings', {
        method: 'PUT',
        body: JSON.stringify({ crossfade: clamped.toString() })
      }).catch((err) => {
        console.warn('[PlayerStore] Failed to sync crossfade to account:', err);
      });
    },

    applyAccountSettings: (settings: Record<string, string>) => {
      if (!settings || typeof settings !== 'object') return;
      const updates: Partial<PlayerState> = {};

      if (settings.crossfade !== undefined) {
        const parsed = parseFloat(settings.crossfade);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 12) {
          updates.crossfade = parsed;
          try { localStorage.setItem(STORAGE_KEY_CROSSFADE, parsed.toString()); } catch (_) {}
        }
      }

      if (settings.eqPreset !== undefined && typeof settings.eqPreset === 'string' && EQ_PRESETS[settings.eqPreset]) {
        updates.eqPreset = settings.eqPreset;
        try { localStorage.setItem(STORAGE_KEY_EQ_PRESET, settings.eqPreset); } catch (_) {}
      }

      if (settings.eqBands !== undefined) {
        try {
          const bands = typeof settings.eqBands === 'string' ? JSON.parse(settings.eqBands) : settings.eqBands;
          if (Array.isArray(bands) && bands.length === 5) {
            updates.eqBands = bands;
            try { localStorage.setItem(STORAGE_KEY_EQ_BANDS, JSON.stringify(bands)); } catch (_) {}
          }
        } catch (_) {}
      }

      if (settings.isNormalizerEnabled !== undefined) {
        const isNorm = String(settings.isNormalizerEnabled) === 'true';
        updates.isNormalizerEnabled = isNorm;
        try { localStorage.setItem(STORAGE_KEY_NORMALIZER, isNorm.toString()); } catch (_) {}
      }

      if (Object.keys(updates).length > 0) {
        set(updates);
        ensureAudioGraph();
        if (updates.eqBands) {
          updateFilterGains(updates.eqBands);
        }
        if (updates.isNormalizerEnabled !== undefined) {
          updateNormalizer(updates.isNormalizerEnabled);
        }
      }
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
