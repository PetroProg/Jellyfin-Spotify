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
import { diag, diagHeartbeat, initPlaybackDiagnostics } from '../utils/playbackDiag';

initPlaybackDiagnostics();

export const EQ_FREQUENCIES = [60, 230, 910, 3600, 14000];

// Default Sound Profile: Soft Mids + Accented Deep Bass (Option 1)
export const DEFAULT_BASS_FOCUS_BANDS = [4.5, 2.5, -4.5, -3.0, 1.0];

// Dynamic Loudness Contour (Option 3):
// Compensates human hearing curve (Fletcher-Munson) so low-frequency punch never disappears when volume is low
export function getDynamicLoudnessBands(vol: number): number[] {
  const base = DEFAULT_BASS_FOCUS_BANDS;
  const clampedVol = Math.max(0, Math.min(1, vol));
  const factor = Math.max(0, 1.0 - clampedVol);
  return [
    Math.round((base[0] + factor * 5.0) * 10) / 10,
    Math.round((base[1] + factor * 3.0) * 10) / 10,
    base[2], // mids stay quiet and soft
    base[3], // upper mids stay soft
    Math.round((base[4] + factor * 1.5) * 10) / 10,
  ];
}

export const EQ_PRESETS: Record<string, { label: string; labelEn: string; bands: number[] }> = {
  flat: { label: 'Оригинал (Bit-Perfect)', labelEn: 'Original (Bit-Perfect)', bands: [0, 0, 0, 0, 0] },
  bass: { label: '🔥 Усиление басов (Ultra Bass)', labelEn: '🔥 Ultra Bass Boost', bands: [6.5, 4.0, -0.5, 1.0, 2.0] },
  bass_focus: { label: 'Фокус на басе & Мягкая середина', labelEn: 'Bass Focus & Soft Mids', bands: [4.5, 2.5, -4.5, -3.0, 1.0] },
  club: { label: 'Клубный панч (EDM / Club)', labelEn: 'Club / EDM Punch', bands: [5.5, 3.0, 0, 2.0, 3.0] },
  rock: { label: 'Рок & Драйв (Rock / Metal)', labelEn: 'Rock & Drive', bands: [4.0, 2.5, 0.5, 2.5, 3.0] },
  audiophile: { label: 'Аудиофил (Bose / Sony)', labelEn: 'Audiophile (Bose / Sony)', bands: [3.0, 1.5, 0, 1.0, 1.5] },
  pop: { label: 'Поп', labelEn: 'Pop', bands: [-0.5, 1.5, 2.5, 2.0, 2.0] },
  vocal: { label: 'Чистый вокал', labelEn: 'Clean Vocal', bands: [-1.5, 0, 3.5, 2.5, 1.0] },
  hiphop: { label: 'Хип-хоп & 808', labelEn: 'Hip-Hop & 808', bands: [7.0, 4.5, -0.5, 1.5, 2.0] },
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
  isQueueOpen: boolean;
  setQueueOpen: (open: boolean) => void;
  userQueuedCount: number;
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  clearUpcomingQueue: () => void;
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
  reloadCurrentTrackStream: (trackOverride?: Track) => void;
}

const STORAGE_KEY_VOLUME = 'jellyfy_player_volume';
const STORAGE_KEY_EQ_BANDS = 'jellyfy_eq_bands';
const STORAGE_KEY_EQ_PRESET = 'jellyfy_eq_preset';
const STORAGE_KEY_NORMALIZER = 'jellyfy_normalizer_enabled';
const STORAGE_KEY_SHUFFLE = 'jellyfy_shuffle';
const STORAGE_KEY_LIKED_IDS = 'jellyfy_cached_liked_ids';
const STORAGE_KEY_CROSSFADE = 'jellyfy_crossfade';
const STORAGE_KEY_PLAYER_SESSION = 'jellyfy_player_session';

interface SavedPlayerSession {
  currentTrack: Track | null;
  currentPlaylistId: number | null;
  currentTime: number;
  duration: number;
  queue: Track[];
  originalQueue: Track[];
  currentIndex: number;
  repeat: RepeatMode;
  savedAt: number;
}

const loadSavedPlayerSession = (): SavedPlayerSession | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PLAYER_SESSION);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.currentTrack || !parsed.currentTrack.id) return null;
    if (parsed.savedAt && Date.now() - parsed.savedAt > 7 * 24 * 60 * 60 * 1000) {
      return null;
    }
    return parsed as SavedPlayerSession;
  } catch (_) {
    return null;
  }
};

let lastSessionSaveTs = 0;
const savePlayerSessionState = (state: Partial<PlayerState>, force: boolean = false) => {
  if (typeof localStorage === 'undefined') return;
  const now = Date.now();
  // In background, serialize the (up to 2×300 tracks) session snapshot less often to save CPU/battery
  const minIntervalMs = (typeof document !== 'undefined' && document.hidden) ? 15000 : 3000;
  if (!force && now - lastSessionSaveTs < minIntervalMs) return;
  lastSessionSaveTs = now;

  try {
    if (!state.currentTrack) {
      localStorage.removeItem(STORAGE_KEY_PLAYER_SESSION);
      return;
    }
    const q = Array.isArray(state.queue) ? state.queue.slice(0, 300) : [];
    const oq = Array.isArray(state.originalQueue) ? state.originalQueue.slice(0, 300) : [];
    const payload: SavedPlayerSession = {
      currentTrack: state.currentTrack,
      currentPlaylistId: state.currentPlaylistId ?? null,
      currentTime: Number(state.currentTime) || 0,
      duration: Number(state.duration) || 0,
      queue: q,
      originalQueue: oq,
      currentIndex: typeof state.currentIndex === 'number' ? state.currentIndex : 0,
      repeat: state.repeat || 'off',
      savedAt: now,
    };
    localStorage.setItem(STORAGE_KEY_PLAYER_SESSION, JSON.stringify(payload));
  } catch (_) {}
};

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
  return [...DEFAULT_BASS_FOCUS_BANDS];
};

const loadSavedEqPreset = (): string => {
  return 'bass_focus';
};

const loadSavedNormalizer = (): boolean => {
  const val = localStorage.getItem(STORAGE_KEY_NORMALIZER);
  // Default to false: Pure Bit-Perfect Direct Stream for high-end headphones (Bose, Sony, AirPods, etc.)
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

// WebAudio C++-thread infrasonic keep-alive to preserve Android AudioFocus & MediaSession importance
// without registering a second HTMLMediaElement in Chromium's MediaSessionImpl::normal_players_
let standbyTimeoutTimer: any = null;
let pauseKeepAliveInterval: any = null;
const STANDBY_GRACE_PERIOD_MS = 30 * 60 * 1000; // 30 minutes grace period on pause

let prewarmingPausedTrackId: number | null = null;
async function prewarmPausedTrack(track: Track | null | undefined) {
  if (!track || !track.id || track.id <= 0 || track.isPreview || track.streamUrl) return;
  if (getSynchronousBlobUrl(track.id)) return;
  if (prewarmingPausedTrackId === track.id) return;
  prewarmingPausedTrackId = track.id;
  try {
    const cached = await isTrackCached(track.id);
    if (!cached && (typeof navigator === 'undefined' || navigator.onLine)) {
      await cacheTrackOffline(track, 35000);
    }
    await getCachedTrackUrl(track.id);
  } catch (_) {
  } finally {
    if (prewarmingPausedTrackId === track.id) {
      prewarmingPausedTrackId = null;
    }
  }
}

function clearStandbyTimer() {
  if (standbyTimeoutTimer) {
    clearTimeout(standbyTimeoutTimer);
    standbyTimeoutTimer = null;
  }
  if (pauseKeepAliveInterval) {
    clearInterval(pauseKeepAliveInterval);
    pauseKeepAliveInterval = null;
  }
}

function activateSilentAnchor(forPause: boolean = false) {
  if (typeof window === 'undefined') return;

  clearStandbyTimer();
  ensureAudioGraph();
  ensureAudioContextKeepAlive();

  if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
    audioCtx.resume().catch(() => {});
  }

  if (audioCtx && audioCtxKeepAliveGain) {
    try {
      audioCtxKeepAliveGain.gain.cancelScheduledValues(audioCtx.currentTime);
      audioCtxKeepAliveGain.gain.value = 1.0;
      audioCtxKeepAliveGain.gain.setTargetAtTime(1.0, audioCtx.currentTime, 0.02);
    } catch (_) {}
  }

  if (forPause) {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
      updateMediaPositionState();
    }

    // Background-cache the paused track in Blob RAM without mutating audio.src
    prewarmPausedTrack(usePlayerStore.getState().currentTrack).catch(() => {});

    pauseKeepAliveInterval = setInterval(() => {
      try {
        if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
          audioCtx.resume().catch(() => {});
        }
        if ('mediaSession' in navigator && audio.paused) {
          navigator.mediaSession.playbackState = 'paused';
          updateMediaPositionState();
        }
      } catch (_) {}
    }, 15000);

    standbyTimeoutTimer = setTimeout(() => {
      console.log('[SilentAnchor] 30m grace period expired. Releasing standby keep-alive.');
      deactivateSilentAnchor();
    }, STANDBY_GRACE_PERIOD_MS);
  }
}

function deactivateSilentAnchor() {
  clearStandbyTimer();
  if (audioCtx && audioCtxKeepAliveGain) {
    try {
      audioCtxKeepAliveGain.gain.cancelScheduledValues(audioCtx.currentTime);
      audioCtxKeepAliveGain.gain.value = 0.00001;
    } catch (_) {}
  }
  if (audio.paused && audioCtx && audioCtx.state === 'running') {
    audioCtx.suspend().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// Track-transition MediaSession bridge (Android / Chromium background playback)
//
// Changing `audio.src` destroys the element's WebMediaPlayer, so Chromium removes it from
// MediaSessionImpl until the next track actually starts playing. In the background this leaves
// the page with NO controllable media session for a moment: Chrome hides the media notification,
// drops the foreground service and lowers the renderer's process importance — Android (Samsung
// especially) may then kill the renderer right at the end of a song. WebAudio output does NOT
// count as a media session on Android, so the infrasonic keep-alive cannot cover this gap.
//
// The bridge is a second <audio> element that plays a >5 s near-silent loop ONLY around a track
// transition (from ~2.5 s before EOF until the next track is really playing). It is torn down
// completely (src removed + load()) afterwards, so it never lingers in the MediaSession while the
// user is paused (which was the cause of the earlier Bluetooth-resume bug with silentAnchorAudio).
// ---------------------------------------------------------------------------------------------
const transitionBridgeAudio = new Audio();
transitionBridgeAudio.preload = 'auto';
transitionBridgeAudio.loop = true;
transitionBridgeAudio.volume = 1.0;
mountHiddenAudioElement(transitionBridgeAudio, 'jellyfy-transition-bridge');

let transitionBridgeUrl: string | null = null;
let isTransitionBridgeActive = false;
let transitionBridgeSafetyTimer: any = null;
let transitionBridgeStopTimer: any = null;
const TRANSITION_BRIDGE_MAX_MS = 45000;

function getTransitionBridgeUrl(): string | null {
  if (transitionBridgeUrl) return transitionBridgeUrl;
  try {
    // 8 s mono 8 kHz 16-bit PCM WAV (≈128 KB). Duration > 5 s so Chromium treats it as a normal
    // (controllable) player, not a "one-shot" sound. Content: 15 Hz + 19 Hz at ≈ -67 dBFS — inaudible.
    const sampleRate = 8000;
    const seconds = 8;
    const numSamples = sampleRate * seconds;
    const dataSize = numSamples * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);
    const writeStr = (offset: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const v = 0.00045 * Math.sin(2 * Math.PI * 15 * t) + 0.00045 * Math.cos(2 * Math.PI * 19 * t);
      view.setInt16(44 + i * 2, Math.round(v * 32767), true);
    }
    transitionBridgeUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  } catch (_) {
    transitionBridgeUrl = null;
  }
  return transitionBridgeUrl;
}

function startTransitionBridge(reason: string) {
  if (typeof document === 'undefined') return;
  if (transitionBridgeStopTimer) {
    clearTimeout(transitionBridgeStopTimer);
    transitionBridgeStopTimer = null;
  }
  if (isTransitionBridgeActive && !transitionBridgeAudio.paused) return;
  const url = getTransitionBridgeUrl();
  if (!url) return;

  isTransitionBridgeActive = true;
  try {
    if (transitionBridgeAudio.src !== url) {
      transitionBridgeAudio.src = url;
    }
    const p = transitionBridgeAudio.play();
    if (p !== undefined) {
      p.catch((err) => {
        diag(`[bridge] play() failed: ${err?.name || err}`);
        isTransitionBridgeActive = false;
      });
    }
    diag(`[bridge] start (${reason})`);
  } catch (_) {
    isTransitionBridgeActive = false;
  }

  if (transitionBridgeSafetyTimer) clearTimeout(transitionBridgeSafetyTimer);
  transitionBridgeSafetyTimer = setTimeout(() => {
    transitionBridgeSafetyTimer = null;
    diag('[bridge] safety timeout reached');
    stopTransitionBridge('safety-timeout', true);
  }, TRANSITION_BRIDGE_MAX_MS);
}

function stopTransitionBridge(reason: string, immediate = false) {
  if (!isTransitionBridgeActive && transitionBridgeAudio.paused && !transitionBridgeAudio.getAttribute('src')) return;

  const doStop = () => {
    transitionBridgeStopTimer = null;
    if (transitionBridgeSafetyTimer) {
      clearTimeout(transitionBridgeSafetyTimer);
      transitionBridgeSafetyTimer = null;
    }
    isTransitionBridgeActive = false;
    try {
      transitionBridgeAudio.pause();
      // Fully destroy the WebMediaPlayer so it is removed from Chromium's MediaSession
      transitionBridgeAudio.removeAttribute('src');
      transitionBridgeAudio.load();
    } catch (_) {}
    diag(`[bridge] stop (${reason})`);
  };

  if (transitionBridgeStopTimer) {
    clearTimeout(transitionBridgeStopTimer);
    transitionBridgeStopTimer = null;
  }
  if (immediate) {
    doStop();
  } else {
    // Small hand-over delay so Chromium registers the new main player before the bridge leaves
    transitionBridgeStopTimer = setTimeout(doStop, 1200);
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

// Track pause / source-change state and deferred recovery while paused
let isUserInitiatedPause = false;
let wasInterruptedByExternalApp = false;
let isInternalSrcChange = false;
let pendingRecoveryOnResume = false;
let pendingRecoveryTime = 0;

function clearInterruptionRetries() {
  wasInterruptedByExternalApp = false;
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
  const lowOverlap = (bands[0] > 0 && bands[1] > 0) ? Math.min(bands[0], bands[1]) * 0.25 : 0;
  // Apply transparent headroom only when EQ is boosted above 0 dB
  const headroomDb = maxBoost > 0 ? -Math.min(maxBoost * 0.45 + lowOverlap, 4.0) : 0;
  const preAmpLinear = Math.pow(10, headroomDb / 20);
  preAmpGainNode.gain.setTargetAtTime(preAmpLinear, audioCtx.currentTime, 0.02);
}

function syncCompressorMode(bands: number[], isNormalizer: boolean) {
  if (!audioCtx || !compressorNode) return;
  const now = audioCtx.currentTime;
  const maxBoost = Math.max(0, ...bands);

  if (isNormalizer) {
    // Transparent Audiophile Leveler:
    // High threshold (-2.5 dBFS), soft knee (12 dB), gentle ratio (1.4:1), long attack (0.045s), smooth release (0.25s)
    // Transients (kick drum, slap bass, snare) pass through 100% uncompressed with full punch!
    compressorNode.threshold.setTargetAtTime(-2.5, now, 0.02);
    compressorNode.knee.setTargetAtTime(12, now, 0.02);
    compressorNode.ratio.setTargetAtTime(1.4, now, 0.02);
    compressorNode.attack.setTargetAtTime(0.045, now, 0.02);
    compressorNode.release.setTargetAtTime(0.25, now, 0.02);
  } else if (maxBoost > 0) {
    // Transparent True-Peak Safety Ceiling when EQ boost is active: prevents bass transients from clipping > 0 dBFS
    compressorNode.threshold.setTargetAtTime(-1.5, now, 0.02);
    compressorNode.knee.setTargetAtTime(4.0, now, 0.02);
    compressorNode.ratio.setTargetAtTime(12.0, now, 0.02);
    compressorNode.attack.setTargetAtTime(0.005, now, 0.02);
    compressorNode.release.setTargetAtTime(0.08, now, 0.02);
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
  applyHeadroom(bands);
  syncCompressorMode(bands, enabled);
  updateDspRouting(bands, enabled);
}

let audioCtxKeepAliveNode: AudioBufferSourceNode | OscillatorNode | ConstantSourceNode | null = null;
let audioCtxKeepAliveGain: GainNode | null = null;

function ensureAudioContextKeepAlive() {
  if (!audioCtx || audioCtxKeepAliveNode) return;
  try {
    const sampleRate = audioCtx.sampleRate || 48000;
    const length = Math.max(1, Math.round(sampleRate));
    const buffer = audioCtx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    // Quadrature infrasonic signal (15 Hz + 19 Hz, peak ±29 LSB, RMS -66.9 dBFS > -72.25 dBFS floor):
    // keeps Chromium OutputController is_audible=true & prevents Android/Samsung AudioTrack suspension
    // entirely on the C++ WebAudio rendering thread without adding a second HTMLMediaElement.
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      data[i] =
        0.00045 * Math.sin(2 * Math.PI * 15 * t) +
        0.00045 * Math.cos(2 * Math.PI * 19 * t);
    }

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const gain = audioCtx.createGain();
    gain.gain.value = 1.0;

    source.connect(gain);
    gain.connect(audioCtx.destination);
    source.start();

    audioCtxKeepAliveNode = source;
    audioCtxKeepAliveGain = gain;
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
    // Applies Bass Focus (Soft Mids) + Dynamic Loudness Contour by default
    const currentVol = usePlayerStore.getState?.() ? usePlayerStore.getState().volume : initialVolume;
    const initialBands = getDynamicLoudnessBands(currentVol);
    eqFilters = EQ_FREQUENCIES.map((freq, idx) => {
      const filter = audioCtx!.createBiquadFilter();
      if (idx === 0) {
        filter.type = 'lowshelf';
        filter.Q.value = 0.707;
      } else if (idx === EQ_FREQUENCIES.length - 1) {
        filter.type = 'highshelf';
        filter.Q.value = 0.707;
      } else if (idx === 1) {
        filter.type = 'peaking';
        filter.Q.value = 0.75;
      } else {
        filter.type = 'peaking';
        filter.Q.value = 0.85;
      }
      filter.frequency.value = freq;
      filter.gain.value = initialBands[idx] || 0;
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

    applyHeadroom(initialBands);
    syncCompressorMode(initialBands, isNorm);
    updateDspRouting(initialBands, isNorm);
    ensureAudioContextKeepAlive();

    audioCtx.onstatechange = () => {
      const isActiveLocalPlay =
        usePlayerStore.getState().isPlaying &&
        useSyncStore.getState().isLocalActive &&
        !isUserInitiatedPause;
      if (
        audioCtx &&
        (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted') &&
        (isActiveLocalPlay || standbyTimeoutTimer !== null)
      ) {
        audioCtx.resume().catch(() => {});
      }
    };
  } catch (err) {
    console.warn('[Web Audio API Init Error]:', err);
  }
}

function checkAndInitAudioGraph() {
  ensureAudioGraph();
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
    if (!store.isPlaying || isUserInitiatedPause || wasInterruptedByExternalApp || !store.currentTrack) {
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

    // 2. Check if track genuinely ended in background without firing onended
    const cur = audio.currentTime || 0;
    if (!store.currentTrack.isPreview && audio.ended) {
      console.log('[Watchdog] Track ended in background, advancing queue...');
      diag('[watchdog] track ended without onended → advancing');
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

    // Do not force-resume or treat a paused element as frozen (e.g. Android ACTION_AUDIO_BECOMING_NOISY pause)
    if (audio.paused) {
      return;
    }

    // 3. Check for frozen playhead (> 8 seconds without advancing while not paused)
    if (Math.abs(cur - lastWatchdogMediaTime) >= 0.05) {
      lastWatchdogMediaTime = cur;
      lastWatchdogWallTime = Date.now();
    } else if (Date.now() - lastWatchdogWallTime > 8000) {
      console.warn('[Watchdog] Playhead frozen for >8s in background, triggering stream recovery...');
      diag(`[watchdog] playhead frozen at ${cur.toFixed(1)}s → recovery`);
      lastWatchdogWallTime = Date.now();
      recoverAudioStream(cur > 0 ? cur : store.currentTime, true);
    }
  }, 2500);
}

function startPlaybackForTrack(track: Track, startTime = 0, autoPlay = true) {
  const reqId = ++currentPlayRequestId;
  pendingRecoveryOnResume = false;
  pendingRecoveryTime = 0;
  setCurrentlyPlayingTrackId(track.id);
  markTrackTransitionStart();

  // Ensure WebAudio C++-thread keep-alive is running BEFORE mutating audio.src
  // so Chromium keeps the renderer audible and at high importance during track handover.
  if (autoPlay) {
    activateSilentAnchor(false);
    // Hold the Android MediaSession / media notification while audio.src is swapped in background
    if (typeof document !== 'undefined' && document.hidden) {
      startTransitionBridge(`track #${track.id}`);
    }
  }
  diag(`[track] start #${track.id} autoPlay=${autoPlay} hidden=${typeof document !== 'undefined' && document.hidden} blob=${Boolean(track.id > 0 && getSynchronousBlobUrl(track.id))}`);

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
  const streamUrl = `/api/stream/${track.id}?v=${track.duration_ms || 0}_${track.bitrate || 0}`;

  const applyPlayback = (targetSrc: string) => {
    const needsChange = !audio.src.endsWith(targetSrc) && audio.src !== targetSrc;
    if (needsChange) {
      isInternalSrcChange = true;
      audio.src = targetSrc;
    }

    const applySeek = () => {
      try {
        if (startTime > 0) {
          audio.currentTime = startTime;
        } else if (!needsChange && audio.currentTime > 0) {
          audio.currentTime = 0;
        }
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
    const store = usePlayerStore.getState();
    const isActiveLocalPlay =
      store.currentTrack &&
      useSyncStore.getState().isLocalActive &&
      (store.isPlaying || !audio.paused);

    if (isActiveLocalPlay) {
      activateSilentAnchor(false);
    } else if (
      audioCtx &&
      (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted') &&
      standbyTimeoutTimer !== null
    ) {
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
  pendingRecoveryOnResume = false;
  pendingRecoveryTime = 0;

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
    diag(`[recovery] #${track.id} at ${targetTime.toFixed(1)}s autoPlay=${autoPlay}`);

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

    if (autoPlay && !isUserInitiatedPause) {
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
      if (autoPlay && isUserInitiatedPause) {
        pendingRecoveryOnResume = true;
        pendingRecoveryTime = targetTime;
      }
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

    // 3. Treat every pause (UI pause, lockscreen/headset button, ACTION_AUDIO_BECOMING_NOISY
    //    on headphone disconnect, or external audio interruption) consistently as a paused standby
    //    so playback never auto-resumes onto speakers.
    clearInterruptionRetries();
    if (errorRecoveryTimeout) {
      clearTimeout(errorRecoveryTimeout);
      errorRecoveryTimeout = null;
    }
    isUserInitiatedPause = true;
    wasInterruptedByExternalApp = false;
    stopPlaybackWatchdog();
    releaseScreenWakeLock();
    stopTransitionBridge('main paused', true);
    activateSilentAnchor(true);
    diag(`[pause] main element paused at ${cur.toFixed(1)}/${(dur || 0).toFixed(1)}s hidden=${document.hidden}`);
    diagHeartbeat(false, get().currentTrack?.id);

    set({ isPlaying: false });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    updateMediaPositionState();
    savePlayerSessionState(get(), true);
    useSyncStore.getState().sendPlaybackState({ isPlaying: false });
  };

  let consecutiveErrors = 0;

  audio.onerror = () => {
    markTrackTransitionEnd();
    isInternalSrcChange = false;
    const err = audio.error;
    const { currentTrack, isPlaying } = get();
    console.warn('[Audio Error Event]: code =', err?.code, 'message =', err?.message, 'track =', currentTrack?.title);
    diag(`[error] media error code=${err?.code} track=#${currentTrack?.id} online=${navigator.onLine}`);

    if (!currentTrack) return;

    const savedPos = audio.currentTime > 0 ? audio.currentTime : get().currentTime;

    // Never call audio.load() / mutate audio.src while paused: Chromium removes the MediaSession
    // player and tears down the Android Media Notification when load() runs without play().
    if (!isPlaying || isUserInitiatedPause || audio.paused) {
      pendingRecoveryOnResume = true;
      pendingRecoveryTime = savedPos;
      console.log(`[Audio Error while paused] Deferring stream recovery at ${savedPos.toFixed(1)}s until resume to keep MediaSession alive.`);
      return;
    }

    // Check if offline or network stream failure:
    // MediaError.MEDIA_ERR_NETWORK (2)
    // MediaError.MEDIA_ERR_DECODE (3 - abruptly severed stream causes decode error at EOF)
    // MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED (4 - 504 / network fetch failure)
    const isNetworkErr = (typeof navigator !== 'undefined' && !navigator.onLine) ||
      err?.code === 2 || err?.code === 3 || err?.code === 4;

    if (isNetworkErr && networkRetryCount < 10) {
      networkRetryCount++;
      console.warn(`[Audio Error] Network stream interrupted. Attempting auto-reconnect ${networkRetryCount}/10 at ${savedPos.toFixed(1)}s...`);

      if (errorRecoveryTimeout) clearTimeout(errorRecoveryTimeout);
      const delay = Math.min(4000, 400 + networkRetryCount * 500);
      errorRecoveryTimeout = setTimeout(() => {
        const latest = get();
        if (!latest.isPlaying || isUserInitiatedPause) {
          pendingRecoveryOnResume = true;
          pendingRecoveryTime = savedPos;
          return;
        }
        recoverAudioStream(savedPos, true);
      }, delay);
      return;
    }

    // If persistent non-network error or retries exhausted
    consecutiveErrors++;
    if (consecutiveErrors >= 3) {
      consecutiveErrors = 0;
      networkRetryCount = 0;
      set({ isPlaying: false });
      stopTransitionBridge('playback error', true);
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
    // Main element is really playing again → hand the MediaSession back and remove the bridge
    if (isTransitionBridgeActive) {
      stopTransitionBridge('main playing');
    }
    diag(`[playing] #${get().currentTrack?.id} at ${(audio.currentTime || 0).toFixed(1)}s src=${audio.src.startsWith('blob:') ? 'blob' : 'net'}`);
    diagHeartbeat(true, get().currentTrack?.id);
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
    savePlayerSessionState(get(), false);

    // Pre-arm the MediaSession bridge ~2.5 s before EOF while in background, so a controllable
    // player is already registered when audio.src is swapped to the next track.
    {
      const bridgeDur = (dur && isFinite(dur) && dur > 5) ? dur : 0;
      if (bridgeDur > 0 && !audio.paused && !get().currentTrack?.isPreview) {
        const remainingSec = bridgeDur - cur;
        const isHidden = typeof document !== 'undefined' && document.hidden;
        if (isHidden && remainingSec <= 2.5 && remainingSec > 0 && !isTransitionBridgeActive && get().repeat !== 'one') {
          startTransitionBridge('pre-EOF');
        } else if (isTransitionBridgeActive && !isTransitioningTrack && remainingSec > 6 && !transitionBridgeStopTimer) {
          // User seeked back / track restarted: the bridge is no longer needed
          stopTransitionBridge('seek away from EOF');
        }
      }
    }

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
      diag(`[transition] pre-roll at ${cur.toFixed(1)}/${mediaDur.toFixed(1)}s hidden=${!isAppVisible} bridge=${isTransitionBridgeActive}`);
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
      diagHeartbeat(!audio.paused, get().currentTrack?.id);
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
    diag(`[ended] #${get().currentTrack?.id} transitioning=${isTransitioningTrack}`);
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

  // Re-sync UI & MediaSession state when app becomes visible (never auto-resume onto speakers)
  if (typeof window !== 'undefined') {
    const handleAppVisibility = () => {
      if (document.visibilityState === 'visible') {
        const store = get();
        const isLocal = useSyncStore.getState().isLocalActive;
        const isActiveLocalPlay = store.isPlaying && isLocal && !isUserInitiatedPause;
        if (
          audioCtx &&
          (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted') &&
          (isActiveLocalPlay || standbyTimeoutTimer !== null)
        ) {
          audioCtx.resume().catch(() => {});
        }

        if (store.currentTrack && isLocal) {
          const actuallyPaused = audio.paused;
          if (store.isPlaying !== !actuallyPaused) {
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
    // If playing from a local blob URL, network bandwidth is 100% free immediately!
    if (audio.src.startsWith('blob:')) return true;

    const cur = audio.currentTime;
    // Wait only the first 2.5 seconds so the active stream starts smoothly
    if (cur < 2.5) return false;

    if (!audio.duration || !isFinite(audio.duration) || audio.duration <= 0) {
      return cur >= 5;
    }

    for (let i = 0; i < audio.buffered.length; i++) {
      if (audio.buffered.start(i) <= cur && cur <= audio.buffered.end(i)) {
        const bufferedAhead = audio.buffered.end(i) - cur;
        // Current track only needs 5 seconds buffered ahead (or reached EOF) before prefetching upcoming tracks
        return bufferedAhead >= 5 || audio.buffered.end(i) >= (audio.duration - 1);
      }
    }
    return cur >= 6 && audio.readyState >= 3;
  };

  let lastPrefetchCheckTime = 0;

  const triggerEventDrivenPrefetch = async () => {
    if (isPrefetching) return;
    const now = Date.now();
    if (now - lastPrefetchCheckTime < 1500) return;
    lastPrefetchCheckTime = now;

    const { queue, currentIndex, currentTrack, isPlaying, repeat } = get();
    if (!isPlaying || !currentTrack || !queue || queue.length === 0 || currentIndex < 0) return;

    // Collect up to 6 upcoming tracks in the queue to pre-download and pre-buffer
    const PREFETCH_LOOKAHEAD = 6;
    const upcomingIndices: number[] = [];
    for (let offset = 1; offset <= PREFETCH_LOOKAHEAD; offset++) {
      const nextIdx = currentIndex + offset;
      if (nextIdx < queue.length) {
        upcomingIndices.push(nextIdx);
      } else if (repeat === 'all' && queue.length > 1) {
        const wrappedIdx = nextIdx % queue.length;
        if (wrappedIdx !== currentIndex && !upcomingIndices.includes(wrappedIdx)) {
          upcomingIndices.push(wrappedIdx);
        }
      }
    }

    if (upcomingIndices.length === 0) return;

    // Find the first upcoming track in the 6-track window that isn't cached or pre-warmed yet
    let targetTrack: Track | null = null;
    let isImmediateNext = false;
    let targetOffsetIndex = 0;
    let remainingCandidates = 0;

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

      // For tracks 1..3 ahead, ensure they are in synchronous Blob RAM; for tracks 4..6 ahead, ensure they are in CacheStorage
      if (i >= 3 && isTrackDownloadedLocally(candidate.id)) {
        continue;
      }

      if (!targetTrack) {
        targetTrack = candidate;
        isImmediateNext = i === 0;
        targetOffsetIndex = i;
      } else {
        remainingCandidates++;
      }
    }

    if (!targetTrack) return;
    if (!isBufferSafeForPrefetch()) return;

    isPrefetching = true;
    prefetchAbortController = new AbortController();

    try {
      const cached = await isTrackCached(targetTrack.id);
      if (!cached) {
        console.log(`[Smart Prefetch] Pre-downloading upcoming track (+${targetOffsetIndex + 1}) into offline cache: "${targetTrack.title}"`);
        await cacheTrackOffline(targetTrack, 35000, prefetchAbortController.signal);
      }

      // Warm the next 3 tracks into 0ms Blob RAM
      if (targetOffsetIndex < 3) {
        const blobUrl = await getCachedTrackUrl(targetTrack.id);
        if (isImmediateNext) {
          preloadNextTrackElement(blobUrl || `/api/stream/${targetTrack.id}`);
        }
        if (blobUrl) {
          console.log(`[Smart Prefetch] Track "${targetTrack.title}" ready in RAM as 0ms Blob URL`);
        }
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.warn('[Smart Prefetch] Prefetch error:', err);
      }
    } finally {
      isPrefetching = false;
      prefetchAbortController = null;
      // If more tracks in the 6-track lookahead window still need pre-downloading, chain the next prefetch!
      if (remainingCandidates > 0 && get().isPlaying) {
        if (prefetchTimeout) clearTimeout(prefetchTimeout);
        prefetchTimeout = setTimeout(() => {
          triggerEventDrivenPrefetch();
        }, 900);
      }
    }
  };

  const scheduleNextTrackPrefetch = () => {
    if (prefetchTimeout) {
      clearTimeout(prefetchTimeout);
      prefetchTimeout = null;
    }
    prefetchTimeout = setTimeout(() => {
      triggerEventDrivenPrefetch();
    }, 2000);
  };

  let isPrefetchingRecommendations = false;
  const prefetchRecommendationsIfNeeded = async () => {
    const { queue, currentIndex, smartShuffle } = get();
    if (!smartShuffle || isPrefetchingRecommendations) return;
    // Fetch new recommendations earlier (when 5 or fewer tracks remain in the queue)
    if (queue.length > 0 && currentIndex >= queue.length - 5) {
      isPrefetchingRecommendations = true;
      try {
        const lastTrack = queue[queue.length - 1];
        const data = await apiRequest<{ recommendations: any[] }>(
          `/recommendations?artists=${encodeURIComponent(lastTrack?.artist || '')}`,
          { timeoutMs: 5000 }
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
            scheduleNextTrackPrefetch();
          }
        }
      } catch (_) {
      } finally {
        isPrefetchingRecommendations = false;
      }
    }
  };

  const savedSession = typeof window !== 'undefined' ? loadSavedPlayerSession() : null;
  if (savedSession?.currentTrack) {
    const restoredTrack = savedSession.currentTrack;
    const restoredTime = Math.max(0, Number(savedSession.currentTime) || 0);
    setTimeout(async () => {
      try {
        if (audio.src || get().currentTrack?.id !== restoredTrack.id) return;
        let streamUrl = `/api/stream/${restoredTrack.id}`;
        try {
          const cachedUrl = await getCachedTrackUrl(restoredTrack.id);
          if (cachedUrl) streamUrl = cachedUrl;
        } catch (_) {}
        if (audio.src || get().currentTrack?.id !== restoredTrack.id) return;
        isInternalSrcChange = true;
        audio.src = streamUrl;
        const applyRestoredPos = () => {
          try {
            if (restoredTime > 0 && isFinite(audio.duration) && restoredTime < audio.duration) {
              audio.currentTime = restoredTime;
            }
          } catch (_) {}
          isInternalSrcChange = false;
          updateMediaSession(restoredTrack);
          updateMediaPositionState();
        };
        if (audio.readyState >= 1) applyRestoredPos();
        else audio.addEventListener('loadedmetadata', applyRestoredPos, { once: true });
      } catch (_) {
        isInternalSrcChange = false;
      }
    }, 0);
  }

  return {
    currentTrack: savedSession?.currentTrack || null,
    currentPlaylistId: savedSession?.currentPlaylistId ?? null,
    isPlaying: false,
    currentTime: savedSession?.currentTime || 0,
    duration: savedSession?.duration || (savedSession?.currentTrack?.duration_ms ? savedSession.currentTrack.duration_ms / 1000 : 0),
    queue: savedSession?.queue || [],
    originalQueue: savedSession?.originalQueue || [],
    currentIndex: savedSession?.currentIndex ?? -1,
    shuffle: loadSavedShuffle(),
    smartShuffle: true,
    repeat: savedSession?.repeat || 'off',
    volume: initialVolume,
    isFullPlayerOpen: false,
    isQueueOpen: false,
    userQueuedCount: 0,
    setQueueOpen: (open: boolean) => {
      set({ isQueueOpen: open });
    },

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
      let orig = newQueue ? [...newQueue] : (get().originalQueue && get().originalQueue.length > 0 ? get().originalQueue : get().queue);

      // When user clicks a specific track in a list (or starts a new playlist/album),
      // disable shuffle so tracks play in natural order. Shuffle is ONLY active when the Shuffle button is clicked!
      const shouldTurnOffShuffle = index !== undefined || (newQueue && newQueue !== get().queue);
      if (shouldTurnOffShuffle && get().shuffle) {
        try { localStorage.setItem(STORAGE_KEY_SHUFFLE, 'false'); } catch (_) {}
      }
      const nextShuffle = shouldTurnOffShuffle ? false : get().shuffle;

      if (newQueue && newQueue !== get().queue) {
        // User started playback from a new list/playlist view
        q = [...newQueue];
        idx = (index !== undefined && index >= 0 && index < q.length && q[index].id === track.id)
          ? index
          : q.findIndex((t) => t.id === track.id);
        if (idx === -1) {
          q = [track, ...q];
          idx = 0;
        }
        orig = [...newQueue];
      } else {
        // Navigating within existing active queue (QueueModal, nextTrack, prevTrack, etc.)
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
          userQueuedCount: (newQueue && newQueue !== get().queue) ? 0 : get().userQueuedCount,
          shuffle: nextShuffle,
          isPlaying: true,
        });
        if (shouldTurnOffShuffle) {
          useSyncStore.getState().sendPlaybackState({ shuffle: false });
        }
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
        userQueuedCount: (newQueue && newQueue !== get().queue) ? 0 : get().userQueuedCount,
        shuffle: nextShuffle,
        isPlaying: true,
        currentTime: 0,
        duration: initialDur,
      });

      if (shouldTurnOffShuffle) {
        useSyncStore.getState().sendPlaybackState({ shuffle: false });
      }

      checkAndInitAudioGraph();
      if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
        audioCtx.resume().catch(() => {});
      }

      startPlaybackForTrack(track, 0, true);

      updateMediaSession(track);
      useSyncStore.getState().sendPlaybackState({ currentTime: 0, duration: initialDur, isPlaying: true });
      scheduleNextTrackPrefetch();
      prefetchRecommendationsIfNeeded();
      // Defer queue Blob pre-warming (6× cache lookups + HEAD validations) so it never competes
      // with the network/cache start of the new track at the transition moment
      setTimeout(() => prewarmQueueBlobUrls(q, idx + 1, 6), 4000);
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
      // Defer queue Blob pre-warming (6× cache lookups + HEAD validations) so it never competes
      // with the network/cache start of the new track at the transition moment
      setTimeout(() => prewarmQueueBlobUrls(q, idx + 1, 6), 4000);
    },

    stopLocalPlayback: () => {
      clearInterruptionRetries();
      stopPlaybackWatchdog();
      try {
        audio.pause();
      } catch (_) {}
      stopTransitionBridge('stop local playback', true);
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
        if (errorRecoveryTimeout) {
          clearTimeout(errorRecoveryTimeout);
          errorRecoveryTimeout = null;
        }
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
        savePlayerSessionState(get(), true);
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

        // If audio element is errored, stalled, in empty network state, or had recovery deferred while paused
        const isBroken = audio.error !== null ||
          audio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE ||
          (audio.readyState === 0 && Boolean(audio.src));
        const needsRecovery = pendingRecoveryOnResume || isBroken;

        if (needsRecovery) {
          const resumePos = pendingRecoveryOnResume && pendingRecoveryTime > 0
            ? pendingRecoveryTime
            : (audio.currentTime > 0 ? audio.currentTime : get().currentTime);
          pendingRecoveryOnResume = false;
          pendingRecoveryTime = 0;
          console.log('[togglePlay] Audio element needs recovery/reconnect, running recoverAudioStream...');
          recoverAudioStream(resumePos, true);
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
      if (errorRecoveryTimeout) {
        clearTimeout(errorRecoveryTimeout);
        errorRecoveryTimeout = null;
      }
      stopPlaybackWatchdog();
      isUserInitiatedPause = true;
      wasInterruptedByExternalApp = false;
      releaseScreenWakeLock();
      stopTransitionBridge('user pause', true);
      diagHeartbeat(false, get().currentTrack?.id);

      const isLocal = useSyncStore.getState().isLocalActive;
      if (!isLocal) {
        useSyncStore.getState().sendRemoteCommand('pause');
      } else {
        audio.pause();
        activateSilentAnchor(true);
      }
      set({ isPlaying: false });
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
      updateMediaPositionState();
      savePlayerSessionState(get(), true);
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
      const needsRecovery = pendingRecoveryOnResume || isBroken;

      if (needsRecovery) {
        const resumePos = pendingRecoveryOnResume && pendingRecoveryTime > 0
          ? pendingRecoveryTime
          : (audio.currentTime > 0 ? audio.currentTime : get().currentTime);
        pendingRecoveryOnResume = false;
        pendingRecoveryTime = 0;
        console.log('[resume] Audio element needs recovery/reconnect, running recoverAudioStream...');
        recoverAudioStream(resumePos, true);
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

      const { queue, currentIndex, repeat, smartShuffle, playTrack, currentPlaylistId, userQueuedCount } = get();
      if (queue.length === 0) return;

      if (userQueuedCount > 0) {
        set({ userQueuedCount: Math.max(0, userQueuedCount - 1) });
      }

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
      diag('[queue] end of queue reached — playback stopped');
      markTrackTransitionEnd();
      stopPlaybackWatchdog();
      stopTransitionBridge('end of queue', true);
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

      // Dynamic Loudness Contour (Option 3):
      // As music gets quieter, smoothly adapt bass curve so bass punch remains prominent and deep
      if (audioCtx && isAudioGraphAttached) {
        const dynBands = getDynamicLoudnessBands(clamped);
        updateFilterGains(dynBands);
      }
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
      const { queue, currentIndex, userQueuedCount, originalQueue } = get();
      if (!queue || queue.length === 0) {
        get().playTrack(track, [track], 0);
        toast.success(tr(`"${track.title}" started playing`, `«${track.title}» играет`));
        return;
      }

      // Insert right after currently playing song + previously user-queued items
      const insertIndex = Math.min(queue.length, currentIndex + 1 + (userQueuedCount || 0));
      const newQueue = [...queue];
      newQueue.splice(insertIndex, 0, track);

      const newOrig = [...originalQueue];
      const origInsertIndex = Math.min(newOrig.length, insertIndex);
      newOrig.splice(origInsertIndex, 0, track);

      set({
        queue: newQueue,
        originalQueue: newOrig,
        userQueuedCount: (userQueuedCount || 0) + 1
      });

      toast.success(tr(`"${track.title}" will play next`, `«${track.title}» будет играть следующим`));

      try {
        useSyncStore.getState().sendPlaybackState({ queue: newQueue });
      } catch (_) {}
    },

    reorderQueue: (fromIndex: number, toIndex: number) => {
      const { queue, currentIndex, currentTrack } = get();
      if (fromIndex < 0 || fromIndex >= queue.length || toIndex < 0 || toIndex >= queue.length || fromIndex === toIndex) {
        return;
      }
      const newQueue = [...queue];
      const [moved] = newQueue.splice(fromIndex, 1);
      newQueue.splice(toIndex, 0, moved);

      // Recalculate currentIndex so currentTrack index remains locked to playing song
      let newIdx = currentIndex;
      if (currentTrack) {
        const found = newQueue.findIndex((t, i) => (t.id && t.id === currentTrack.id) || (i === currentIndex && t.title === currentTrack.title));
        if (found !== -1) {
          newIdx = found;
        }
      }

      set({ queue: newQueue, currentIndex: newIdx });
      try {
        useSyncStore.getState().sendPlaybackState({ queue: newQueue });
      } catch (_) {}
    },

    clearUpcomingQueue: () => {
      const { queue, currentIndex } = get();
      if (currentIndex < 0 || currentIndex >= queue.length) return;
      const newQueue = queue.slice(0, currentIndex + 1);
      set({ queue: newQueue, userQueuedCount: 0 });
      try {
        useSyncStore.getState().sendPlaybackState({ queue: newQueue });
      } catch (_) {}
      toast.success(tr('Upcoming queue cleared', 'Очередь очищена'));
    },

    removeFromQueue: (index: number) => {
      const { queue, currentIndex, userQueuedCount } = get();
      if (index < 0 || index >= queue.length) return;
      const updated = queue.filter((_, i) => i !== index);
      let newIdx = currentIndex;
      if (index < currentIndex) {
        newIdx--;
      } else if (index === currentIndex && index >= updated.length) {
        newIdx = Math.max(0, updated.length - 1);
      }

      let newQueuedCount = userQueuedCount;
      if (index > currentIndex && index <= currentIndex + userQueuedCount) {
        newQueuedCount = Math.max(0, userQueuedCount - 1);
      }

      set({ queue: updated, currentIndex: newIdx, userQueuedCount: newQueuedCount });
      try {
        useSyncStore.getState().sendPlaybackState({ queue: updated });
      } catch (_) {}
    },

    likedTrackIds: loadSavedLikedIds(),

    loadLikes: async () => {
      try {
        const data = await apiRequest<{ tracks: Track[]; version?: string }>('/likes', { timeoutMs: 5000 });
        const tracks = data.tracks || [];
        // Keep any optimistic negative IDs for currently playing instant tracks
        const pendingNegIds = get().likedTrackIds.filter((id) => id < 0);
        const ids = Array.from(new Set([...tracks.map((t) => t.id), ...pendingNegIds]));
        set({ likedTrackIds: ids });
        localStorage.setItem(STORAGE_KEY_LIKED_IDS, JSON.stringify(ids));
        localStorage.setItem('jellyfy_cached_liked_ids', JSON.stringify(ids));
        localStorage.setItem('jellyfy_cached_liked_tracks', JSON.stringify(tracks));
        const likedPl = {
          id: -1,
          name: 'Любимые треки',
          description: 'Ваша медиатека сохраненных композиций',
          created_at: new Date().toISOString(),
          track_count: tracks.length,
        };
        saveOfflinePlaylistData(likedPl, tracks, false, data.version);
        if (useOfflineStore.getState().isDownloaded(-1) && tracks.length > 0) {
          useOfflineStore.getState().syncPlaylist(-1, tracks, likedPl);
        }
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

      let targetTrack =
        trackObj ||
        (get().currentTrack?.id === trackId ? get().currentTrack : get().queue.find((t) => t.id === trackId));

      // If user likes an Instant-Play track that still has a temporary negative ID,
      // check if its real downloaded track is already ready; otherwise keep optimistic negative ID
      // and handleInstantTrackDownloaded will automatically persist & cache it once ready!
      if (trackId <= 0) {
        if (
          downloadedInstantTrack &&
          downloadedInstantTrack.id > 0 &&
          targetTrack &&
          (downloadedInstantTrack.spotify_id === targetTrack.spotify_id ||
            (downloadedInstantTrack.title.toLowerCase() === targetTrack.title.toLowerCase() &&
              downloadedInstantTrack.artist.toLowerCase() === targetTrack.artist.toLowerCase()))
        ) {
          const cleaned = likedTrackIds.filter((id) => id !== trackId);
          set({ likedTrackIds: cleaned });
          return await get().toggleLikeTrack(downloadedInstantTrack.id, downloadedInstantTrack, targetState);
        }

        const negLiked = targetState
          ? Array.from(new Set([...likedTrackIds, trackId]))
          : likedTrackIds.filter((id) => id !== trackId);
        set({ likedTrackIds: negLiked });
        try {
          localStorage.setItem(STORAGE_KEY_LIKED_IDS, JSON.stringify(negLiked));
          localStorage.setItem('jellyfy_cached_liked_ids', JSON.stringify(negLiked));
        } catch (_) {}
        return targetState;
      }

      const newLiked = targetState
        ? Array.from(new Set([...likedTrackIds.filter((id) => id > 0), trackId]))
        : likedTrackIds.filter((id) => id !== trackId);

      // 1. Instant Optimistic UI & Local State Update (0 ms)
      set({ likedTrackIds: newLiked });
      try {
        localStorage.setItem(STORAGE_KEY_LIKED_IDS, JSON.stringify(newLiked));
        localStorage.setItem('jellyfy_cached_liked_ids', JSON.stringify(newLiked));
      } catch (_) {}

      // 2. Instant Local Offline Cache Update for Liked Songs
      if (targetState) {
        if (!targetTrack) {
          try {
            const fetched = await apiRequest<{ track: Track }>(`/tracks/${trackId}`, { silentOffline: true });
            if (fetched?.track) {
              targetTrack = fetched.track;
            }
          } catch (_) {}
        }

        if (targetTrack && targetTrack.id > 0) {
          addTrackToOfflinePlaylist(-1, targetTrack);
          try {
            const rawCached = localStorage.getItem('jellyfy_cached_liked_tracks');
            const prevCached: Track[] = rawCached ? JSON.parse(rawCached) : [];
            const nextCached = [targetTrack, ...prevCached.filter((t) => t.id !== targetTrack!.id)];
            localStorage.setItem('jellyfy_cached_liked_tracks', JSON.stringify(nextCached));
          } catch (_) {}

          if (shouldTrackBeCachedOffline(trackId, -1, newLiked) || useOfflineStore.getState().isDownloaded(-1)) {
            useOfflineStore.getState().cacheTrack(targetTrack).catch(() => {});
          }
        }
      } else {
        removeTrackFromOfflinePlaylist(-1, trackId);
        try {
          const rawCached = localStorage.getItem('jellyfy_cached_liked_tracks');
          if (rawCached) {
            const prevCached: Track[] = JSON.parse(rawCached);
            localStorage.setItem(
              'jellyfy_cached_liked_tracks',
              JSON.stringify(prevCached.filter((t) => t.id !== trackId))
            );
          }
        } catch (_) {}
      }

      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('jellyfy:liked_tracks_changed', {
            detail: { trackId, track: targetTrack || null, liked: targetState },
          })
        );
      }

      // 3. Send mutation with Outbox-guaranteed delivery (never fails with timeout error)
      try {
        const res = await apiRequest<{ liked: boolean; queuedOffline?: boolean }>(`/likes/${trackId}`, {
          method: 'POST',
          body: JSON.stringify({ liked: targetState }),
          coalesceKey: `like_${trackId}`,
          actionType: targetState ? 'LIKE_TRACK' : 'UNLIKE_TRACK',
          timeoutMs: 20000,
        });

        const finalLiked = res.liked !== undefined ? res.liked : targetState;
        const updated = finalLiked
          ? Array.from(new Set([...get().likedTrackIds, trackId]))
          : get().likedTrackIds.filter((id) => id !== trackId);
        set({ likedTrackIds: updated });
        try {
          localStorage.setItem(STORAGE_KEY_LIKED_IDS, JSON.stringify(updated));
          localStorage.setItem('jellyfy_cached_liked_ids', JSON.stringify(updated));
        } catch (_) {}

        return finalLiked;
      } catch (err: any) {
        // Even if an unexpected error occurs, don't rollback if offline or network error!
        console.warn('[PlayerStore] toggleLikeTrack network error, kept optimistic state:', err.message);
        return targetState;
      }
    },

    blacklistTrack: async (track: Track) => {
      // 1. Instantly remove from liked tracks & playlists locally
      set((state) => ({
        likedTrackIds: state.likedTrackIds.filter((id) => id !== track.id),
      }));
      removeTrackFromOfflinePlaylist(-1, track.id);

      // 2. Dispatch to backend with Outbox guarantee
      apiRequest('/blacklist', {
        method: 'POST',
        body: JSON.stringify({
          title: track.title,
          artist: track.artist,
          track_id: track.id,
          spotify_id: track.spotify_id,
        }),
        coalesceKey: `blacklist_${track.id || track.title}`,
        actionType: 'BLACKLIST_TRACK',
      }).catch(() => {});

      // 3. Filter current queue
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
      const { currentTrack, likedTrackIds, queue, originalQueue } = get();
      const prevTempId = currentTrack?.id;
      const wasLikedWhilePending = Boolean(
        (prevTempId && prevTempId < 0 && likedTrackIds.includes(prevTempId)) ||
          likedTrackIds.includes(realTrack.id)
      );

      if (
        currentTrack &&
        (currentTrack.spotify_id === spotifyId ||
          currentTrack.id < 0 ||
          (currentTrack.title.toLowerCase() === realTrack.title.toLowerCase() &&
            currentTrack.artist.toLowerCase() === realTrack.artist.toLowerCase()))
      ) {
        const updatedQueue =
          queue.length > 1
            ? queue.map((t) =>
                t.id === currentTrack.id ||
                t.spotify_id === spotifyId ||
                (t.title.toLowerCase() === realTrack.title.toLowerCase() &&
                  t.artist.toLowerCase() === realTrack.artist.toLowerCase())
                  ? realTrack
                  : t
              )
            : [realTrack];

        const updatedOrigQueue =
          originalQueue.length > 1
            ? originalQueue.map((t) =>
                t.id === currentTrack.id ||
                t.spotify_id === spotifyId ||
                (t.title.toLowerCase() === realTrack.title.toLowerCase() &&
                  t.artist.toLowerCase() === realTrack.artist.toLowerCase())
                  ? realTrack
                  : t
              )
            : updatedQueue;

        set({
          currentTrack: {
            ...realTrack,
            isPreview: Boolean(currentTrack.isPreview),
          },
          duration: (realTrack.duration_ms || 180000) / 1000,
          queue: updatedQueue,
          originalQueue: updatedOrigQueue,
        });
        updateMediaSession(realTrack);
      }

      // If the user liked this track while it was still downloading on the server (or it's already in likedTrackIds),
      // persist the real track ID to the server and cache the newly downloaded MP3 for offline playback!
      if (wasLikedWhilePending && realTrack && realTrack.id > 0) {
        const cleanedIds = get().likedTrackIds.filter((id) => id > 0 && id !== prevTempId);
        set({ likedTrackIds: cleanedIds });
        get().toggleLikeTrack(realTrack.id, realTrack, true).catch(() => {});
      } else if (
        realTrack &&
        realTrack.id > 0 &&
        shouldTrackBeCachedOffline(realTrack.id, undefined, get().likedTrackIds)
      ) {
        useOfflineStore.getState().cacheTrack(realTrack).catch(() => {});
      }
    },

    reloadCurrentTrackStream: (trackOverride?: Track) => {
      const { currentTrack, isPlaying, currentTime } = get();
      const t = trackOverride || currentTrack;
      if (t && t.id > 0) {
        if (trackOverride) {
          set({
            currentTrack: trackOverride,
            duration: (trackOverride.duration_ms || 180000) / 1000,
          });
          updateMediaSession(trackOverride);
        }
        if (!isPlaying || audio.paused) {
          pendingRecoveryOnResume = true;
          pendingRecoveryTime = audio.currentTime > 0 ? audio.currentTime : (currentTime > 0 ? currentTime : 0);
          return;
        }
        recoverAudioStream(currentTime > 0 ? currentTime : 0, true);
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

      if (!state.isPlaying || audio.paused) {
        if (isBroken) {
          pendingRecoveryOnResume = true;
          pendingRecoveryTime = audio.currentTime > 0 ? audio.currentTime : state.currentTime;
        }
        return;
      }

      if (isBroken || state.isPlaying) {
        console.log('[Player] Triggering automatic stream recovery on network restore...');
        recoverAudioStream(audio.currentTime > 0 ? audio.currentTime : state.currentTime, true);
      }
    }
  });

  window.addEventListener('offline', () => {
    console.warn('[Player] Network connection lost (offline event)');
    const state = usePlayerStore.getState();
    if (state.currentTrack && !audio.src.startsWith('blob:')) {
      if (!state.isPlaying || audio.paused) {
        getCachedTrackUrl(state.currentTrack.id).catch(() => {});
        pendingRecoveryOnResume = true;
        pendingRecoveryTime = audio.currentTime > 0 ? audio.currentTime : state.currentTime;
        return;
      }
      // Seamlessly switch to offline cached blob if available while playing
      getCachedTrackUrl(state.currentTrack.id).then((blobUrl) => {
        if (blobUrl) {
          const latest = usePlayerStore.getState();
          if (!latest.isPlaying || audio.paused) {
            pendingRecoveryOnResume = true;
            pendingRecoveryTime = audio.currentTime > 0 ? audio.currentTime : latest.currentTime;
            return;
          }
          console.log('[Player] Switching to local offline blob URL during network loss');
          const curTime = audio.currentTime;
          isInternalSrcChange = true;
          audio.src = blobUrl;
          const applySeek = () => {
            try { audio.currentTime = curTime; } catch (_) {}
            if (usePlayerStore.getState().isPlaying) {
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
