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
  isTrackDownloadedLocally,
  setCurrentlyPlayingTrackId
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
  handleInstantTrackDownloaded: (spotifyId: string, realTrack: Track) => void;
}

const STORAGE_KEY_VOLUME = 'jellyfy_player_volume';
const STORAGE_KEY_EQ_BANDS = 'jellyfy_eq_bands';
const STORAGE_KEY_EQ_PRESET = 'jellyfy_eq_preset';
const STORAGE_KEY_NORMALIZER = 'jellyfy_normalizer_enabled';
const STORAGE_KEY_SHUFFLE = 'jellyfy_shuffle';
const STORAGE_KEY_LIKED_IDS = 'jellyfy_cached_liked_ids';
const STORAGE_KEY_CROSSFADE = 'jellyfy_crossfade';

const loadSavedShuffle = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY_SHUFFLE) === 'true';
  } catch (_) {
    return false;
  }
};

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

// Helper to attach hidden <audio> elements to document.body so Chromium never treats them
// as detached media elements eligible for BackgroundMediaSuspend after 10 minutes in Doze Mode
function mountHiddenAudioElement(el: HTMLAudioElement, id: string) {
  if (typeof document === 'undefined') return;
  try {
    el.id = id;
    el.style.display = 'none';
    el.setAttribute('playsinline', 'true');
    const append = () => {
      if (document.body && !el.isConnected) {
        document.body.appendChild(el);
      }
    };
    if (document.body) {
      append();
    } else {
      window.addEventListener('DOMContentLoaded', append, { once: true });
    }
  } catch (_) {}
}

// Global Audio Instance
// -1.4 dB True-Peak headroom (0.85 linear) prevents inter-sample Gibbs overshoots (> 0 dBFS in decoded MP3s)
// from hard-clipping the 16-bit DAC or Bluetooth AAC/LDAC/SBC encoder on loud transients
const MASTER_HEADROOM = 0.85;
const audio = new Audio();
audio.preload = 'auto';
audio.crossOrigin = 'anonymous';
const initialVolume = loadSavedVolume();
audio.volume = Math.max(0, Math.min(1, initialVolume * MASTER_HEADROOM));
mountHiddenAudioElement(audio, 'jellyfy-primary-audio');

// Secondary Preloader Audio Element to pre-parse headers & buffer the next track in DOM
const nextAudioPreloader = new Audio();
nextAudioPreloader.preload = 'auto';
nextAudioPreloader.muted = true;
nextAudioPreloader.volume = 0;
mountHiddenAudioElement(nextAudioPreloader, 'jellyfy-next-preloader');
let preloadedNextTrackUrl: string | null = null;

function preloadNextTrackElement(url: string | null) {
  if (!url || preloadedNextTrackUrl === url) return;
  try {
    preloadedNextTrackUrl = url;
    nextAudioPreloader.src = url;
    nextAudioPreloader.load();
  } catch (_) {}
}

// Crossfade fade controller
let fadeInterval: any = null;
let isFadingIn = false;
let isFadingOut = false;

// Silent Audio Anchor to maintain Android AudioFocus, bypass Chromium SilentSinkSuspender (30s zero-frame kill),
// and prevent Spotify from hijacking media buttons or mobile OS killing the process at track boundaries after 10+ minutes
let silentAnchorUrl: string | null = null;
let silentAnchorAudio: HTMLAudioElement | null = null;
let standbyTimeoutTimer: any = null;
const STANDBY_GRACE_PERIOD_MS = 30 * 60 * 1000; // 30 minutes grace period on pause

function getSilentAudioUrl(): string {
  if (silentAnchorUrl) return silentAnchorUrl;
  try {
    // 60-second 8000 Hz mono 16-bit PCM WAV with alternating ±3 LSB dithering.
    // 1) Duration 60s (>> Chromium's 5s kMinimumContentDuration) ensures Chromium's MediaSessionImpl
    //    classifies it as MediaContentType::kPersistent rather than a short transient sound effect.
    // 2) Alternating ±3 LSB at volume 0.02 (-110 dBFS) is 100% physically inaudible (below 16-bit thermal noise),
    //    but strictly non-zero in IEEE-754 float32 so Chromium's SilentSinkSuspender never closes the AudioTrack!
    const sampleRate = 8000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const durationSec = 60;
    const numSamples = durationSec * sampleRate * numChannels;
    const dataSize = numSamples * (bitsPerSample / 8);
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

    // Fill with non-zero sub-LSB alternating samples (±3 out of 32768)
    for (let i = 0; i < numSamples; i++) {
      view.setInt16(44 + i * 2, (i & 1) === 0 ? 3 : -3, true);
    }

    const blob = new Blob([buffer], { type: 'audio/wav' });
    silentAnchorUrl = URL.createObjectURL(blob);
    return silentAnchorUrl;
  } catch (_) {
    return 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
  }
}

function primeSilentAnchor() {
  if (typeof window === 'undefined') return;
  try {
    if (!silentAnchorAudio) {
      silentAnchorAudio = new Audio(getSilentAudioUrl());
      silentAnchorAudio.loop = true;
      silentAnchorAudio.preload = 'auto';
      silentAnchorAudio.volume = 0.02;
      silentAnchorAudio.onerror = () => {};
      mountHiddenAudioElement(silentAnchorAudio, 'jellyfy-silent-anchor');
    } else if (!silentAnchorAudio.isConnected) {
      mountHiddenAudioElement(silentAnchorAudio, 'jellyfy-silent-anchor');
    }
  } catch (_) {}
}

function clearStandbyTimer() {
  if (standbyTimeoutTimer) {
    clearTimeout(standbyTimeoutTimer);
    standbyTimeoutTimer = null;
  }
}

function activateSilentAnchor(forPause: boolean = false) {
  if (typeof window === 'undefined') return;

  clearStandbyTimer();
  primeSilentAnchor();

  if (silentAnchorAudio) {
    try {
      if (silentAnchorAudio.paused) {
        silentAnchorAudio.play().then(() => {
          if (forPause && 'mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'paused';
            updateMediaPositionState();
          }
        }).catch((err) => {
          console.warn('[SilentAnchor] Play failed:', err);
        });
      } else if (forPause && 'mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
        updateMediaPositionState();
      }
    } catch (_) {}
  }

  if (forPause) {
    standbyTimeoutTimer = setTimeout(() => {
      console.log('[SilentAnchor] 30m grace period expired. Releasing anchor.');
      deactivateSilentAnchor();
    }, STANDBY_GRACE_PERIOD_MS);
  }
}

function deactivateSilentAnchor() {
  clearStandbyTimer();
  if (silentAnchorAudio && !silentAnchorAudio.paused) {
    try {
      silentAnchorAudio.pause();
      silentAnchorAudio.currentTime = 0;
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
let isInternalSrcChange = false;
let interruptionRetryTimeout1: any = null;
let interruptionRetryTimeout2: any = null;

function clearInterruptionRetries() {
  if (interruptionRetryTimeout1) {
    clearTimeout(interruptionRetryTimeout1);
    interruptionRetryTimeout1 = null;
  }
  if (interruptionRetryTimeout2) {
    clearTimeout(interruptionRetryTimeout2);
    interruptionRetryTimeout2 = null;
  }
}

/**
 * Checks whether audio playback is currently active.
 * Used by PWA auto-updater to avoid interrupting listening sessions.
 */
export function isPlaybackActive(): boolean {
  try {
    const store = usePlayerStore.getState();
    // 1. Explicit store playback flag
    if (store.isPlaying) return true;

    // 2. Direct HTMLAudioElement inspection
    if (typeof audio !== 'undefined' && audio) {
      if (!audio.paused && !audio.ended && audio.currentTime > 0) return true;
      if (store.currentTrack && !audio.paused && !audio.ended) return true;
    }

    // 3. Native MediaSession playback state (for lockscreen / background / Bluetooth playback)
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      if (navigator.mediaSession.playbackState === 'playing') return true;
    }

    return false;
  } catch {
    return false;
  }
}

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
  const effectiveTarget = Math.max(0, Math.min(1, target * MASTER_HEADROOM));
  if (audioCtx && fadeGainNode) {
    try {
      fadeGainNode.gain.cancelScheduledValues(audioCtx.currentTime);
      fadeGainNode.gain.setTargetAtTime(clampedFraction, audioCtx.currentTime, 0.03);
    } catch (_) {}
    audio.volume = effectiveTarget;
  } else {
    audio.volume = Math.max(0, Math.min(1, clampedFraction * effectiveTarget));
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
  // Account for adjacent low-shelf (60Hz) + peaking (230Hz) filter overlap so bass boosts never clip 0 dBFS
  const lowOverlap = (bands[0] > 0 && bands[1] > 0) ? Math.min(bands[0], bands[1]) * 0.35 : 0;
  const headroomDb = maxBoost > 0 ? -Math.min(maxBoost * 0.65 + lowOverlap, 6.0) : 0;
  const preAmpLinear = Math.pow(10, headroomDb / 20);
  preAmpGainNode.gain.setTargetAtTime(preAmpLinear, audioCtx.currentTime, 0.02);
}

function syncCompressorMode(bands: number[], isNormalizer: boolean) {
  if (!audioCtx || !compressorNode) return;
  const now = audioCtx.currentTime;
  const maxBoost = Math.max(0, ...bands);

  if (isNormalizer) {
    compressorNode.threshold.setTargetAtTime(-14, now, 0.02);
    compressorNode.knee.setTargetAtTime(12, now, 0.02);
    compressorNode.ratio.setTargetAtTime(2.0, now, 0.02);
    compressorNode.attack.setTargetAtTime(0.03, now, 0.02);
    compressorNode.release.setTargetAtTime(0.25, now, 0.02);
  } else if (maxBoost > 0) {
    // Transparent True-Peak Safety Ceiling when EQ boost is active: prevents bass transients from clipping > 0 dBFS
    compressorNode.threshold.setTargetAtTime(-2.0, now, 0.02);
    compressorNode.knee.setTargetAtTime(6.0, now, 0.02);
    compressorNode.ratio.setTargetAtTime(6.0, now, 0.02);
    compressorNode.attack.setTargetAtTime(0.02, now, 0.02);
    compressorNode.release.setTargetAtTime(0.18, now, 0.02);
  } else {
    compressorNode.threshold.setTargetAtTime(0, now, 0.02);
    compressorNode.ratio.setTargetAtTime(1, now, 0.02);
  }
}

function updateFilterGains(bands: number[]) {
  if (!audioCtx) return;
  for (let i = 0; i < eqFilters.length; i++) {
    const targetGain = bands[i] ?? 0;
    eqFilters[i].gain.setTargetAtTime(targetGain, audioCtx.currentTime, 0.02);
  }
  applyHeadroom(bands);
  const isNorm = usePlayerStore.getState().isNormalizerEnabled;
  syncCompressorMode(bands, isNorm);
  updateDspRouting(bands, isNorm);
}

function updateNormalizer(enabled: boolean) {
  if (!audioCtx || !compressorNode) return;
  const bands = usePlayerStore.getState().eqBands;
  syncCompressorMode(bands, enabled);
  updateDspRouting(bands, enabled);
}

let audioCtxKeepAliveNode: OscillatorNode | ConstantSourceNode | null = null;
let audioCtxKeepAliveGain: GainNode | null = null;

function ensureAudioContextKeepAlive() {
  if (!audioCtx || audioCtxKeepAliveNode) return;
  try {
    const ctx = audioCtx as any;
    if (typeof ctx.createConstantSource === 'function') {
      const source = ctx.createConstantSource();
      const gain = ctx.createGain();
      gain.gain.value = 0.00001; // Inaudible (-100 dB)
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start();
      audioCtxKeepAliveNode = source;
      audioCtxKeepAliveGain = gain;
    } else if (typeof ctx.createOscillator === 'function') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.00001;
      osc.frequency.value = 20; // 20 Hz
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      audioCtxKeepAliveNode = osc;
      audioCtxKeepAliveGain = gain;
    }
  } catch (_) {}
}

function ensureAudioGraph() {
  if (isAudioGraphAttached && audioCtx) return;

  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      // Use 'playback' latencyHint for a large, jitter-free hardware audio buffer (prevents DSP callback micro-underruns)
      audioCtx = new AudioContextClass({ latencyHint: 'playback' });
    } catch (_) {
      audioCtx = new AudioContextClass();
    }
    sourceNode = audioCtx.createMediaElementSource(audio);
    isAudioGraphAttached = true;

    // 1. Dry Direct Path (100% Bit-Perfect Bypass, zero filters, zero latency)
    dryGainNode = audioCtx.createGain();

    // 2. Wet DSP Path (Studio Equalizer + Dynamics Compressor)
    wetGainNode = audioCtx.createGain();

    // 3. Dynamic Headroom Pre-Amplifier
    preAmpGainNode = audioCtx.createGain();
    preAmpGainNode.gain.value = 1.0;

    // 4. 5-Band Studio Equalizer (Calibrated Q to prevent mud & inter-band phase ringing)
    const savedBands = loadSavedEqBands();
    eqFilters = EQ_FREQUENCIES.map((freq, idx) => {
      const filter = audioCtx!.createBiquadFilter();
      if (idx === 0) {
        filter.type = 'lowshelf';
        filter.Q.value = 0.707;
      } else if (idx === EQ_FREQUENCIES.length - 1) {
        filter.type = 'highshelf';
        filter.Q.value = 0.707;
      } else {
        filter.type = 'peaking';
        filter.Q.value = 0.85;
      }
      filter.frequency.value = freq;
      filter.gain.value = savedBands[idx] || 0;
      return filter;
    });

    // 5. Studio Dynamics Compressor (Transparent Peak Leveling & Safety Ceiling)
    compressorNode = audioCtx.createDynamicsCompressor();
    const isNorm = loadSavedNormalizer();

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
    syncCompressorMode(savedBands, isNorm);
    updateDspRouting(savedBands, isNorm);
    ensureAudioContextKeepAlive();

    audioCtx.onstatechange = () => {
      if (
        audioCtx &&
        (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted') &&
        usePlayerStore.getState().isPlaying &&
        !isUserInitiatedPause
      ) {
        audioCtx.resume().catch(() => {});
      }
    };
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

// Track transition & request coordination
let isTransitioningTrack = false;
let lastTrackTransitionWallTime = 0;
let currentPlayRequestId = 0;
let transitionSafetyTimeout: any = null;

function markTrackTransitionStart() {
  isTransitioningTrack = true;
  lastTrackTransitionWallTime = Date.now();
  if (transitionSafetyTimeout) clearTimeout(transitionSafetyTimeout);
  transitionSafetyTimeout = setTimeout(() => {
    isTransitioningTrack = false;
  }, 5000);
}

function markTrackTransitionEnd() {
  isTransitioningTrack = false;
  if (transitionSafetyTimeout) {
    clearTimeout(transitionSafetyTimeout);
    transitionSafetyTimeout = null;
  }
}

// Background Playback Health Watchdog
let playbackWatchdogTimer: any = null;
let lastWatchdogMediaTime = -1;
let lastWatchdogWallTime = 0;

function stopPlaybackWatchdog() {
  if (playbackWatchdogTimer) {
    clearInterval(playbackWatchdogTimer);
    playbackWatchdogTimer = null;
  }
  lastWatchdogMediaTime = -1;
  lastWatchdogWallTime = 0;
}

function startPlaybackWatchdog() {
  if (playbackWatchdogTimer) return;
  lastWatchdogMediaTime = audio.currentTime || 0;
  lastWatchdogWallTime = Date.now();

  playbackWatchdogTimer = setInterval(() => {
    const store = usePlayerStore.getState();
    if (!store.isPlaying || isUserInitiatedPause || !store.currentTrack) {
      stopPlaybackWatchdog();
      return;
    }
    if (!useSyncStore.getState().isLocalActive) {
      return;
    }

    // 1. Keep WebAudio AudioContext alive if suspended in background
    if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
      audioCtx.resume().catch(() => {});
    }

    // 2. Keep non-zero silent anchor playing so Chromium SilentSinkSuspender never drops hardware AudioTrack
    if (silentAnchorAudio && silentAnchorAudio.paused) {
      silentAnchorAudio.play().catch(() => {});
    }

    // Never interfere while a track transition or stream recovery is actively in progress
    if (
      isRecoveringStream ||
      isInternalSrcChange ||
      isTransitioningTrack ||
      Date.now() - lastTrackTransitionWallTime < 3500
    ) {
      lastWatchdogMediaTime = audio.currentTime || 0;
      lastWatchdogWallTime = Date.now();
      return;
    }

    // 3. Check if track genuinely ended in background without firing onended
    const cur = audio.currentTime || 0;
    if (!store.currentTrack.isPreview && audio.ended) {
      console.log('[Watchdog] Track ended in background, advancing queue...');
      markTrackTransitionStart();
      if (store.repeat === 'one') {
        audio.currentTime = 0;
        audio.play().catch(() => {});
        markTrackTransitionEnd();
      } else {
        store.nextTrack();
      }
      lastWatchdogMediaTime = 0;
      lastWatchdogWallTime = Date.now();
      return;
    }

    // 4. If audio is unexpectedly paused while store.isPlaying && !isUserInitiatedPause
    if (audio.paused && !audio.ended) {
      console.log('[Watchdog] Audio unexpectedly paused in background, resuming...');
      audio.play().then(() => {
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
      }).catch(() => {
        recoverAudioStream(cur > 0 ? cur : store.currentTime, true);
      });
      return;
    }

    // 5. Check for frozen playhead (> 8 seconds without advancing while not paused)
    if (Math.abs(cur - lastWatchdogMediaTime) >= 0.05) {
      lastWatchdogMediaTime = cur;
      lastWatchdogWallTime = Date.now();
    } else if (Date.now() - lastWatchdogWallTime > 8000) {
      console.warn('[Watchdog] Playhead frozen for >8s in background, triggering stream recovery...');
      lastWatchdogWallTime = Date.now();
      recoverAudioStream(cur > 0 ? cur : store.currentTime, true);
    }
  }, 2500);
}

function startPlaybackForTrack(track: Track, startTime = 0, autoPlay = true) {
  const reqId = ++currentPlayRequestId;
  setCurrentlyPlayingTrackId(track.id);
  markTrackTransitionStart();

  // Ensure persistent 60s DOM-mounted anchor is playing BEFORE mutating audio.src
  // so Chromium's MediaWebContentsObserver never sees 0 playing media elements during track handover!
  if (autoPlay) {
    activateSilentAnchor(false);
  }

  // If track has an explicit streamUrl (e.g. instant streaming from search)
  if (track.streamUrl) {
    const applyInstantPlayback = (targetSrc: string) => {
      const needsChange = !audio.src.endsWith(targetSrc) && audio.src !== targetSrc;
      if (needsChange) {
        isInternalSrcChange = true;
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
        clearInterruptionRetries();
        isUserInitiatedPause = false;
        wasInterruptedByExternalApp = false;
        requestScreenWakeLock();
        restoreTargetVolume();
        startPlaybackWatchdog();

        const p = audio.play();
        if (p !== undefined) {
          p.then(() => {
            if (reqId === currentPlayRequestId) {
              isInternalSrcChange = false;
              markTrackTransitionEnd();
            }
          }).catch((err) => {
            if (reqId !== currentPlayRequestId) return;
            isInternalSrcChange = false;
            console.warn('[Audio instant play interrupted / autoplay]:', err);
            setTimeout(() => {
              if (reqId !== currentPlayRequestId || isUserInitiatedPause || !audio.paused) return;
              audio.play().catch(() => {
                if (reqId === currentPlayRequestId && !isUserInitiatedPause) {
                  recoverAudioStream(startTime || 0, true);
                }
              });
            }, 250);
          });
        } else {
          isInternalSrcChange = false;
          markTrackTransitionEnd();
        }
      } else {
        audio.pause();
        markTrackTransitionEnd();
        setTimeout(() => { isInternalSrcChange = false; }, 100);
      }
    };

    applyInstantPlayback(track.streamUrl);
    return;
  }

  const syncBlobUrl = track.id > 0 ? getSynchronousBlobUrl(track.id) : null;
  const streamUrl = `/api/stream/${track.id}`;

  const applyPlayback = (targetSrc: string) => {
    const needsChange = !audio.src.endsWith(targetSrc) && audio.src !== targetSrc;
    if (needsChange) {
      isInternalSrcChange = true;
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
      clearInterruptionRetries();
      isUserInitiatedPause = false;
      wasInterruptedByExternalApp = false;
      requestScreenWakeLock();
      startPlaybackWatchdog();

      if ((!startTime || startTime <= 0.1) && usePlayerStore.getState().crossfade > 0) {
        startFadeIn(Math.min(usePlayerStore.getState().crossfade, 2.5));
      } else {
        restoreTargetVolume();
      }

      const p = audio.play();
      if (p !== undefined) {
        p.then(() => {
          if (reqId === currentPlayRequestId) {
            isInternalSrcChange = false;
            markTrackTransitionEnd();
          }
        }).catch((err) => {
          if (reqId !== currentPlayRequestId) return;
          isInternalSrcChange = false;
          console.warn('[Audio play interrupted / autoplay]:', err);
          if (err.name === 'NotAllowedError' && typeof document !== 'undefined' && document.visibilityState === 'visible') {
            markTrackTransitionEnd();
            toast.info(tr('Click anywhere to enable audio on this device', 'Нажмите в любом месте для включения звука на этом устройстве'));
            return;
          }
          // Automatic retry after 200ms if play() was interrupted at track boundary in background
          setTimeout(() => {
            if (reqId !== currentPlayRequestId || isUserInitiatedPause || !audio.paused) return;
            if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
              audioCtx.resume().catch(() => {});
            }
            audio.play().then(() => {
              if (reqId === currentPlayRequestId) {
                markTrackTransitionEnd();
              }
            }).catch(() => {
              if (reqId === currentPlayRequestId && !isUserInitiatedPause) {
                recoverAudioStream(startTime || 0, true);
              }
            });
          }, 200);
        });
      } else {
        isInternalSrcChange = false;
        markTrackTransitionEnd();
      }
    } else {
      audio.pause();
      markTrackTransitionEnd();
      setTimeout(() => { isInternalSrcChange = false; }, 100);
    }
  };

  // 1. If synchronous blob URL is already available in memory, play directly (0ms latency, zero network)!
  if (syncBlobUrl) {
    applyPlayback(syncBlobUrl);
    return;
  }

  // 2. Play immediately with streamUrl to maintain audio hardware session without asynchronous delay
  applyPlayback(streamUrl);

  // 3. Simultaneously check CacheStorage: if the track is cached locally and network stream hasn't started playing yet
  // (e.g. phone is in Doze mode after 10m), seamlessly swap to the local Blob URL!
  if (track.id > 0) {
    getCachedTrackUrl(track.id).then((blobUrl) => {
      if (blobUrl && reqId === currentPlayRequestId && autoPlay && !isUserInitiatedPause) {
        if (audio.paused || audio.readyState < 2 || audio.error !== null) {
          console.log(`[Player] Upgrading stalled/pending network stream for "${track.title}" to local cached Blob URL`);
          applyPlayback(blobUrl);
        }
      }
    }).catch(() => {});
  }
}

// Proactive user-gesture unlock and background/interruption recovery
if (typeof window !== 'undefined') {
  const unlockAudio = () => {
    primeSilentAnchor();
    if (usePlayerStore.getState().currentTrack) {
      activateSilentAnchor(!usePlayerStore.getState().isPlaying);
    }
    if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
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
          playbackRate: isPaused ? 0 : (audio.playbackRate && audio.playbackRate > 0 ? audio.playbackRate : 1),
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
let downloadedInstantTrack: Track | null = null;

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
    isInternalSrcChange = true;
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
      if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
        audioCtx.resume().catch(() => {});
      }

      try {
        await audio.play();
        isInternalSrcChange = false;
        usePlayerStore.setState({ isPlaying: true });
        activateSilentAnchor(false);
        startPlaybackWatchdog();
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
        networkRetryCount = 0;
      } catch (playErr: any) {
        isInternalSrcChange = false;
        console.warn('[Play after recovery failed]:', playErr);
        if (playErr.name === 'NotAllowedError') {
          usePlayerStore.setState({ isPlaying: false });
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'paused';
          }
        }
      }
    } else {
      isInternalSrcChange = false;
    }
  } catch (err) {
    isInternalSrcChange = false;
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
    clearInterruptionRetries();
    isInternalSrcChange = false;
    isUserInitiatedPause = false;
    wasInterruptedByExternalApp = false;
    activateSilentAnchor(false);
    requestScreenWakeLock();
    startPlaybackWatchdog();
    set({ isPlaying: true });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
    if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
      audioCtx.resume().catch(() => {});
    }
    updateMediaPositionState();
    useSyncStore.getState().sendPlaybackState({ isPlaying: true });
  };

  audio.onpause = () => {
    // 1. Ignore synthetic pause events fired asynchronously by HTMLMediaElement when changing audio.src or recovering stream
    if (isInternalSrcChange || isRecoveringStream || isTransitioningTrack || !audio.paused) {
      return;
    }

    // 2. If the track reached the end, this is a natural EOF pause preceding 'ended', NOT an interruption
    const cur = audio.currentTime;
    const dur = (audio.duration && isFinite(audio.duration) && audio.duration > 0) ? audio.duration : get().duration;
    const isNaturalEndOfTrack = audio.ended || (dur > 0 && cur >= dur - 1.2);

    if (isNaturalEndOfTrack) {
      return;
    }

    // 3. If this pause was NOT explicitly requested by the user (e.g. transient notification, Spotify background probe,
    // screen lock glitch, or external app interruption):
    if (!isUserInitiatedPause && get().currentTrack) {
      wasInterruptedByExternalApp = true;
      activateSilentAnchor(false);
      console.log('[Audio] Transient/external pause detected in background. Scheduling auto-recovery...');

      clearInterruptionRetries();
      const attemptAutoResume = (attemptNum: number) => {
        if (isUserInitiatedPause || !get().currentTrack || !audio.paused || isRecoveringStream || isTransitioningTrack) {
          return;
        }
        if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
          audioCtx.resume().catch(() => {});
        }
        audio.play().then(() => {
          console.log(`[Audio] Auto-resumed after transient interruption (attempt ${attemptNum})`);
          wasInterruptedByExternalApp = false;
          set({ isPlaying: true });
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
          }
          updateMediaPositionState();
        }).catch(() => {
          if (attemptNum === 2 && audio.paused && !isUserInitiatedPause) {
            // Persistent interruption (e.g. active phone call or another foreground media app)
            releaseScreenWakeLock();
            activateSilentAnchor(true);
            set({ isPlaying: false });
            if ('mediaSession' in navigator) {
              navigator.mediaSession.playbackState = 'paused';
            }
            updateMediaPositionState();
            useSyncStore.getState().sendPlaybackState({ isPlaying: false });
          }
        });
      };

      interruptionRetryTimeout1 = setTimeout(() => attemptAutoResume(1), 150);
      interruptionRetryTimeout2 = setTimeout(() => attemptAutoResume(2), 1500);
      return;
    }

    // 4. User-initiated pause: hold non-zero silent anchor on standby for 30m so OS keeps PWA alive & Spotify can't hijack buttons
    stopPlaybackWatchdog();
    releaseScreenWakeLock();
    activateSilentAnchor(true);

    set({ isPlaying: false });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    updateMediaPositionState();
    useSyncStore.getState().sendPlaybackState({ isPlaying: false });
  };

  let consecutiveErrors = 0;

  audio.onerror = () => {
    markTrackTransitionEnd();
    isInternalSrcChange = false;
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

    if (isNetworkErr && networkRetryCount < 10) {
      networkRetryCount++;
      console.warn(`[Audio Error] Network stream interrupted. Attempting auto-reconnect ${networkRetryCount}/10 at ${savedPos.toFixed(1)}s...`);

      if (errorRecoveryTimeout) clearTimeout(errorRecoveryTimeout);
      const delay = Math.min(4000, 400 + networkRetryCount * 500);
      errorRecoveryTimeout = setTimeout(() => {
        recoverAudioStream(savedPos, isPlaying || !isUserInitiatedPause);
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
    clearInterruptionRetries();
    isInternalSrcChange = false;
    markTrackTransitionEnd();
    consecutiveErrors = 0;
    networkRetryCount = 0;
    if (errorRecoveryTimeout) clearTimeout(errorRecoveryTimeout);
    if (stallTimeout) clearTimeout(stallTimeout);
    if (waitingTimeout) clearTimeout(waitingTimeout);
    activateSilentAnchor(false);
    startPlaybackWatchdog();
    set({ isPlaying: true });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
    updateMediaPositionState();
    // Restart prefetch schedule once playback is actively flowing (after any initial onwaiting event)
    scheduleNextTrackPrefetch();
  };

  audio.onwaiting = () => {
    // Only abort if a background prefetch is actively downloading right now;
    // do not kill the scheduled timer on initial track load!
    if (isPrefetching) {
      cancelActivePrefetch();
    }
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
    if (isPrefetching) {
      cancelActivePrefetch();
    }
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

    // Event-driven next-track prefetching: immune to Chrome's 5-minute background setTimeout throttling!
    if (cur >= 6 && !isPrefetching) {
      triggerEventDrivenPrefetch();
    }

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

    // Seamless transition from Deezer preview to full downloaded studio track
    if (
      get().currentTrack?.isPreview &&
      downloadedInstantTrack &&
      cur >= 25 &&
      !audio.paused
    ) {
      const savedTime = cur;
      const nextTrack = downloadedInstantTrack;
      downloadedInstantTrack = null;
      set({
        currentTrack: { ...nextTrack, isPreview: false },
        duration: (nextTrack.duration_ms || 180000) / 1000,
        queue: [nextTrack]
      });
      isInternalSrcChange = true;
      audio.src = `/api/stream/${nextTrack.id}`;
      const onReady = () => {
        try { audio.currentTime = savedTime; } catch (_) {}
        audio.play().then(() => { isInternalSrcChange = false; }).catch(() => { isInternalSrcChange = false; });
      };
      if (audio.readyState >= 1) onReady();
      else audio.addEventListener('loadedmetadata', onReady, { once: true });
    }

    // Gapless pre-roll transition using actual media duration (dur) so metadata discrepancies never cut off or miss EOF:
    // start next track slightly before EOF (0.3s) so the audio decoder never idles out in Doze Mode.
    const mediaDur = (dur && !isNaN(dur) && isFinite(dur) && dur > 3) ? dur : 0;
    if (
      !isTransitioningTrack &&
      !get().currentTrack?.isPreview &&
      mediaDur > 3 &&
      cur >= mediaDur - 0.3 &&
      !audio.paused
    ) {
      markTrackTransitionStart();
      cancelFade();
      restoreTargetVolume();
      if (!useSyncStore.getState().isLocalActive) {
        useSyncStore.setState({ isLocalActive: true });
      }
      const { repeat, nextTrack } = get();
      if (repeat === 'one') {
        audio.currentTime = 0;
        audio.play().catch(() => {});
        markTrackTransitionEnd();
      } else {
        nextTrack();
      }
      return;
    }

    const now = Date.now();
    // Throttle sync updates to 10s when app is hidden in background (2s when visible) to minimize background radio/CPU wakeups
    const syncIntervalMs = isAppVisible ? 2000 : 10000;
    if (now - lastSyncTime > syncIntervalMs) {
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

  audio.onended = () => {
    if (isTransitioningTrack && Date.now() - lastTrackTransitionWallTime < 2500) return;
    markTrackTransitionStart();

    cancelFade();
    restoreTargetVolume();

    if (!useSyncStore.getState().isLocalActive) {
      useSyncStore.setState({ isLocalActive: true });
    }

    // If instant preview ended and full track has finished downloading on server
    if (get().currentTrack?.isPreview && downloadedInstantTrack) {
      const nextTrack = downloadedInstantTrack;
      downloadedInstantTrack = null;
      set({
        currentTrack: { ...nextTrack, isPreview: false },
        duration: (nextTrack.duration_ms || 180000) / 1000,
        queue: [nextTrack]
      });
      isInternalSrcChange = true;
      audio.src = `/api/stream/${nextTrack.id}`;
      const onReady = () => {
        try { audio.currentTime = 29; } catch (_) {}
        audio.play().then(() => { isInternalSrcChange = false; }).catch(() => { isInternalSrcChange = false; });
        markTrackTransitionEnd();
      };
      if (audio.readyState >= 1) onReady();
      else audio.addEventListener('loadedmetadata', onReady, { once: true });
      return;
    }

    const { repeat, nextTrack } = get();
    if (repeat === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      if (useSyncStore.getState().isLocalActive) {
        useSyncStore.getState().sendPlaybackState({ currentTime: 0, isPlaying: true });
      }
      markTrackTransitionEnd();
    } else {
      nextTrack();
    }
  };

  // Re-sync on app visibility change (e.g. returning from Instagram / other apps)
  if (typeof window !== 'undefined') {
    const handleAppVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
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
        if (!useSyncStore.getState().isLocalActive) {
          useSyncStore.setState({ isLocalActive: true });
        }
        clearInterruptionRetries();
        isUserInitiatedPause = false;
        wasInterruptedByExternalApp = false;
        activateSilentAnchor(false);
        get().resume();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        if (!useSyncStore.getState().isLocalActive) {
          useSyncStore.setState({ isLocalActive: true });
        }
        // Some Bluetooth earbuds send AVRCP PAUSE as a toggle even when already paused
        if (!get().isPlaying && isUserInitiatedPause && audio.paused) {
          clearInterruptionRetries();
          isUserInitiatedPause = false;
          wasInterruptedByExternalApp = false;
          activateSilentAnchor(false);
          get().resume();
          return;
        }
        clearInterruptionRetries();
        isUserInitiatedPause = true;
        wasInterruptedByExternalApp = false;
        get().pause();
      });
      try {
        navigator.mediaSession.setActionHandler('stop', () => {
          clearInterruptionRetries();
          isUserInitiatedPause = true;
          wasInterruptedByExternalApp = false;
          get().pause();
        });
      } catch (_) {}
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        if (!useSyncStore.getState().isLocalActive) {
          useSyncStore.setState({ isLocalActive: true });
        }
        get().prevTrack();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        if (!useSyncStore.getState().isLocalActive) {
          useSyncStore.setState({ isLocalActive: true });
        }
        get().nextTrack();
      });
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined && details.seekTime !== null) {
          if (!useSyncStore.getState().isLocalActive) {
            useSyncStore.setState({ isLocalActive: true });
          }
          get().seek(details.seekTime);
        }
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
    const cur = audio.currentTime;
    // Don't prefetch during the first 6 seconds to give the active track 100% bandwidth
    if (cur < 6) return false;

    // If playing from a local blob URL, network bandwidth is 100% free!
    if (audio.src.startsWith('blob:')) return true;

    if (!audio.duration || !isFinite(audio.duration) || audio.duration <= 0) {
      return cur >= 12;
    }

    for (let i = 0; i < audio.buffered.length; i++) {
      if (audio.buffered.start(i) <= cur && cur <= audio.buffered.end(i)) {
        const bufferedAhead = audio.buffered.end(i) - cur;
        // Current track must have at least 15 seconds buffered ahead (or reached EOF)
        return bufferedAhead >= 15 || audio.buffered.end(i) >= (audio.duration - 1);
      }
    }
    return cur >= 15 && audio.readyState >= 3;
  };

  let lastPrefetchCheckTime = 0;

  const triggerEventDrivenPrefetch = async () => {
    if (isPrefetching) return;
    const now = Date.now();
    if (now - lastPrefetchCheckTime < 2500) return;
    lastPrefetchCheckTime = now;

    const { queue, currentIndex, currentTrack, isPlaying, repeat } = get();
    if (!isPlaying || !currentTrack || !queue || queue.length === 0 || currentIndex < 0) return;

    // Collect up to 2 upcoming tracks to pre-buffer into Blob RAM
    const upcomingIndices: number[] = [];
    if (currentIndex + 1 < queue.length) {
      upcomingIndices.push(currentIndex + 1);
      if (currentIndex + 2 < queue.length) {
        upcomingIndices.push(currentIndex + 2);
      }
    } else if (repeat === 'all' && queue.length > 0) {
      upcomingIndices.push(0);
    }

    if (upcomingIndices.length === 0) return;

    // Check if any upcoming track still needs to be loaded into synchronous Blob RAM
    let targetTrack: Track | null = null;
    let isImmediateNext = false;

    for (let i = 0; i < upcomingIndices.length; i++) {
      const idx = upcomingIndices[i];
      const candidate = queue[idx];
      if (!candidate || candidate.id <= 0) continue;

      const existingBlob = getSynchronousBlobUrl(candidate.id);
      if (existingBlob) {
        if (i === 0) {
          preloadNextTrackElement(existingBlob);
        }
        continue;
      }

      targetTrack = candidate;
      isImmediateNext = i === 0;
      break;
    }

    if (!targetTrack) return;
    if (!isBufferSafeForPrefetch()) return;

    isPrefetching = true;
    prefetchAbortController = new AbortController();

    try {
      const cached = await isTrackCached(targetTrack.id);
      if (!cached) {
        console.log(`[Smart Prefetch] Pre-downloading upcoming track into offline cache: "${targetTrack.title}"`);
        await cacheTrackOffline(targetTrack, 35000, prefetchAbortController.signal);
      }
      const blobUrl = await getCachedTrackUrl(targetTrack.id);
      if (isImmediateNext) {
        preloadNextTrackElement(blobUrl || `/api/stream/${targetTrack.id}`);
      }
      if (blobUrl) {
        console.log(`[Smart Prefetch] Track "${targetTrack.title}" ready in RAM as 0ms Blob URL`);
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.warn('[Smart Prefetch] Prefetch error:', err);
      }
    } finally {
      isPrefetching = false;
      prefetchAbortController = null;
    }
  };

  const scheduleNextTrackPrefetch = () => {
    if (prefetchTimeout) {
      clearTimeout(prefetchTimeout);
      prefetchTimeout = null;
    }
    prefetchTimeout = setTimeout(() => {
      triggerEventDrivenPrefetch();
    }, 6500);
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
    shuffle: loadSavedShuffle(),
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
      const { currentPlaylistId, currentTrack, queue, originalQueue, shuffle } = get();
      if (currentPlaylistId !== playlistId || !newTracks || newTracks.length <= queue.length) return;

      if (shuffle) {
        const existingIds = new Set(queue.map((t) => t.id));
        const addedTracks = newTracks.filter((t) => !existingIds.has(t.id));
        if (addedTracks.length > 0) {
          for (let i = addedTracks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [addedTracks[i], addedTracks[j]] = [addedTracks[j], addedTracks[i]];
          }
          set({
            queue: [...queue, ...addedTracks],
            originalQueue: newTracks,
          });
        }
      } else {
        const newIdx = currentTrack ? newTracks.findIndex((t) => t.id === currentTrack.id) : 0;
        set({
          queue: newTracks,
          originalQueue: newTracks,
          currentIndex: newIdx >= 0 ? newIdx : get().currentIndex,
        });
      }
    },

    playTrack: (track, newQueue, index, playlistId) => {
      const isLocal = useSyncStore.getState().isLocalActive;

      let q: Track[];
      let idx: number;
      let orig = newQueue ? [...newQueue] : get().originalQueue;

      if (newQueue && newQueue !== get().queue) {
        // User started playback from a new list/playlist view
        if (get().shuffle && newQueue.length > 1) {
          const clickedIdx = (index !== undefined && index >= 0 && index < newQueue.length && newQueue[index].id === track.id)
            ? index
            : newQueue.findIndex((t) => t.id === track.id);
          const chosenTrack = clickedIdx !== -1 ? newQueue[clickedIdx] : track;
          const remaining = clickedIdx !== -1
            ? newQueue.filter((_, i) => i !== clickedIdx)
            : newQueue.filter((t) => t.id !== track.id);

          for (let i = remaining.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
          }

          q = [chosenTrack, ...remaining];
          idx = 0;
        } else {
          q = [...newQueue];
          idx = index !== undefined ? index : q.findIndex((t) => t.id === track.id);
          if (idx === -1) {
            q = [track, ...q];
            idx = 0;
          }
        }
      } else {
        // Navigating within existing active queue (QueuePanel, nextTrack, prevTrack, etc.)
        q = get().queue;
        idx = index !== undefined ? index : q.findIndex((t) => t.id === track.id);
        if (idx === -1) {
          q = [track, ...q];
          idx = 0;
        }
      }

      if (!isLocal) {
        useSyncStore.getState().sendRemoteCommand('playTrack', { track, queue: q, index: idx });
        set({
          currentTrack: track,
          queue: q,
          originalQueue: orig,
          currentIndex: idx,
          currentPlaylistId: playlistId !== undefined ? playlistId : get().currentPlaylistId,
          isPlaying: true,
        });
        return;
      }

      const initialDur = (track.duration_ms && track.duration_ms > 0)
        ? track.duration_ms / 1000
        : 0;

      set({
        currentTrack: track,
        queue: q,
        originalQueue: orig,
        currentIndex: idx,
        currentPlaylistId: playlistId !== undefined ? playlistId : get().currentPlaylistId,
        isPlaying: true,
        currentTime: 0,
        duration: initialDur,
      });

      checkAndInitAudioGraph();
      if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
        audioCtx.resume().catch(() => {});
      }

      startPlaybackForTrack(track, 0, true);

      updateMediaSession(track);
      useSyncStore.getState().sendPlaybackState({ currentTime: 0, duration: initialDur, isPlaying: true });
      scheduleNextTrackPrefetch();
      prefetchRecommendationsIfNeeded();
      prewarmQueueBlobUrls(q, idx + 1, 5);
    },

    playTrackLocally: (track, newQueue, index, startTime, autoPlay = true, playlistId) => {
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
      if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
        audioCtx.resume().catch(() => {});
      }

      startPlaybackForTrack(track, startTime || 0, autoPlay);

      updateMediaSession(track);
      useSyncStore.getState().sendPlaybackState();
      scheduleNextTrackPrefetch();
      prefetchRecommendationsIfNeeded();
      prewarmQueueBlobUrls(q, idx + 1, 5);
    },

    stopLocalPlayback: () => {
      clearInterruptionRetries();
      stopPlaybackWatchdog();
      try {
        audio.pause();
      } catch (_) {}
      deactivateSilentAnchor();
      releaseScreenWakeLock();
    },

    shufflePlay: (tracks: Track[], playlistId?: number | null) => {
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

      localStorage.setItem(STORAGE_KEY_SHUFFLE, 'true');

      checkAndInitAudioGraph();
      if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
        audioCtx.resume().catch(() => {});
      }

      startPlaybackForTrack(chosenTrack, 0, true);

      updateMediaSession(chosenTrack);
      useSyncStore.getState().sendPlaybackState({ currentTime: 0, duration: initialDur, isPlaying: true });
      scheduleNextTrackPrefetch();
      prefetchRecommendationsIfNeeded();
      prewarmQueueBlobUrls(shuffledQueue, 1, 5);
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
        clearInterruptionRetries();
        stopPlaybackWatchdog();
        isUserInitiatedPause = true;
        wasInterruptedByExternalApp = false;
        releaseScreenWakeLock();
        audio.pause();
        activateSilentAnchor(true);
        set({ isPlaying: false });
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'paused';
        }
        updateMediaPositionState();
        useSyncStore.getState().sendPlaybackState({ isPlaying: false });
      } else {
        clearInterruptionRetries();
        isUserInitiatedPause = false;
        wasInterruptedByExternalApp = false;
        activateSilentAnchor(false);
        requestScreenWakeLock();
        startPlaybackWatchdog();

        checkAndInitAudioGraph();
        if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
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
      clearInterruptionRetries();
      stopPlaybackWatchdog();
      isUserInitiatedPause = true;
      wasInterruptedByExternalApp = false;
      releaseScreenWakeLock();

      const isLocal = useSyncStore.getState().isLocalActive;
      if (!isLocal) {
        useSyncStore.getState().sendRemoteCommand('pause');
      } else {
        audio.pause();
      }
      activateSilentAnchor(true);
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

      clearInterruptionRetries();
      isUserInitiatedPause = false;
      wasInterruptedByExternalApp = false;
      activateSilentAnchor(false);
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

      startPlaybackWatchdog();
      checkAndInitAudioGraph();
      if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
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
      markTrackTransitionEnd();
      stopPlaybackWatchdog();
      set({ isPlaying: false });
      deactivateSilentAnchor();
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
        audio.volume = Math.max(0, Math.min(1, clamped * MASTER_HEADROOM));
      }
      localStorage.setItem(STORAGE_KEY_VOLUME, clamped.toString());
      set({ volume: clamped });
    },

    toggleShuffle: () => {
      const { shuffle, queue, currentTrack, originalQueue } = get();
      const nextShuffle = !shuffle;

      if (nextShuffle) {
        const orig = (originalQueue && originalQueue.length >= queue.length)
          ? originalQueue
          : [...queue];

        const withoutCurrent = queue.filter((t) => t.id !== currentTrack?.id);
        for (let i = withoutCurrent.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [withoutCurrent[i], withoutCurrent[j]] = [withoutCurrent[j], withoutCurrent[i]];
        }
        const newQueue = currentTrack ? [currentTrack, ...withoutCurrent] : withoutCurrent;
        set({ shuffle: true, queue: newQueue, originalQueue: orig, currentIndex: currentTrack ? 0 : -1 });
      } else {
        const orig = (originalQueue && originalQueue.length > 0) ? originalQueue : queue;
        const newIdx = currentTrack ? orig.findIndex((t) => t.id === currentTrack.id) : 0;
        set({ shuffle: false, queue: orig, currentIndex: newIdx !== -1 ? newIdx : 0 });
      }

      localStorage.setItem(STORAGE_KEY_SHUFFLE, String(nextShuffle));

      if (useSyncStore.getState().isLocalActive) {
        useSyncStore.getState().sendPlaybackState({ shuffle: nextShuffle });
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
          stopPlaybackWatchdog();
          deactivateSilentAnchor();
          setCurrentlyPlayingTrackId(null);
          isInternalSrcChange = true;
          audio.pause();
          audio.src = '';
          setTimeout(() => { isInternalSrcChange = false; }, 100);
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
        // Only update live WebAudio nodes if the graph was already initialized inside a user gesture.
        // Never create AudioContext on initial page load before a user gesture, or Chrome will lock <audio> to a suspended context!
        if (isAudioGraphAttached && audioCtx) {
          if (updates.eqBands) {
            updateFilterGains(updates.eqBands);
          }
          if (updates.isNormalizerEnabled !== undefined) {
            updateNormalizer(updates.isNormalizerEnabled);
          }
        }
      }
    },

    handleInstantTrackDownloaded: (spotifyId: string, realTrack: Track) => {
      downloadedInstantTrack = realTrack;
      const { currentTrack } = get();
      if (
        currentTrack &&
        (currentTrack.spotify_id === spotifyId ||
          currentTrack.id < 0 ||
          (currentTrack.title.toLowerCase() === realTrack.title.toLowerCase() &&
            currentTrack.artist.toLowerCase() === realTrack.artist.toLowerCase()))
      ) {
        set({
          currentTrack: {
            ...realTrack,
            isPreview: Boolean(currentTrack.isPreview),
          },
          duration: (realTrack.duration_ms || 180000) / 1000,
          queue: [realTrack],
        });
        updateMediaSession(realTrack);
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
          isInternalSrcChange = true;
          audio.src = blobUrl;
          const applySeek = () => {
            try { audio.currentTime = curTime; } catch (_) {}
            if (state.isPlaying) {
              audio.play().then(() => { isInternalSrcChange = false; }).catch(() => { isInternalSrcChange = false; });
            } else {
              isInternalSrcChange = false;
            }
          };
          if (audio.readyState >= 1) applySeek();
          else audio.addEventListener('loadedmetadata', applySeek, { once: true });
        }
      }).catch(() => {});
    }
  });
}
