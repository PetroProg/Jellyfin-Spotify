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
  saveOfflinePlaylistData,
  getSynchronousBlobUrl,
  prewarmQueueBlobUrls,
  shouldTrackBeCachedOffline,
  addTrackToOfflinePlaylist,
  removeTrackFromOfflinePlaylist,
  isTrackDownloadedLocally,
  setCurrentlyPlayingTrackId
} from '../utils/offline';
import {
  StreamQualityPreference,
  ResolvedStreamQuality,
  getSavedStreamQualityPref,
  saveStreamQualityPref,
  parseStreamQualityPref,
  getPreferredStreamFormat,
  resolveEffectiveStreamQuality,
  buildStreamUrl,
  getPrefetchProfile,
  reportStreamStall,
  resetStreamStalls,
  registerRemoteStreamPriorityCheck,
} from '../utils/networkQuality';
import {
  getSynchronousStreamBlob,
  hasTrackInStreamCache,
  getStreamCachedTrackUrl,
  prefetchTrackToStreamCache,
  getStreamCacheLimitMb,
} from '../utils/streamCache';
import { diag, diagHeartbeat, initPlaybackDiagnostics } from '../utils/playbackDiag';
import {
  onTrackPlaybackStart,
  onPreviewUpgradedToFull,
  onPlaybackTimeUpdate,
  onPlaybackPausedOrStopped,
  onTrackEndedOrRepeated,
} from '../utils/listeningTracker';

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

  // Remote Streaming Quality & Buffer Telemetry
  streamQualityPref: StreamQualityPreference;
  activeStreamQuality: 'offline' | 'cache' | ResolvedStreamQuality | null;
  isBuffering: boolean;
  bufferedEnd: number;
  setStreamQualityPref: (pref: StreamQualityPreference) => void;

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
  reloadCurrentTrackStream: (trackOverride?: Track, resetToStart?: boolean) => void;
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

// Resilient background prefetch & server pre-transcode controller (module scope so track transitions cancel immediately)
let prefetchTimeout: any = null;
let isPrefetching = false;
let prefetchAbortController: AbortController | null = null;
let prepareServerTimeout: any = null;
let lastPreparedKey = '';
let lastPreparedAt = 0;

function cancelActivePrefetch() {
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
}

function getBufferedEndAtCurrentTime(): number {
  try {
    const cur = audio.currentTime || 0;
    for (let i = 0; i < audio.buffered.length; i++) {
      const start = audio.buffered.start(i);
      const end = audio.buffered.end(i);
      if (start <= cur + 0.5 && cur <= end + 0.5) {
        return end;
      }
    }
    if (audio.buffered.length > 0) {
      return audio.buffered.end(audio.buffered.length - 1);
    }
  } catch (_) {}
  return 0;
}

function schedulePrepareUpcomingOnServer() {
  if (prepareServerTimeout) {
    clearTimeout(prepareServerTimeout);
  }
  prepareServerTimeout = setTimeout(() => {
    prepareServerTimeout = null;
    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      const store = usePlayerStore.getState();
      if (!store.isPlaying || !store.queue || store.queue.length === 0 || store.currentIndex < 0) return;

      const quality = resolveEffectiveStreamQuality(store.streamQualityPref);
      if (quality === 'original') return;
      const format = getPreferredStreamFormat();

      const ids: number[] = [];
      for (let offset = 1; offset <= 3; offset++) {
        const idx = store.currentIndex + offset;
        let candidate: Track | undefined;
        if (idx < store.queue.length) {
          candidate = store.queue[idx];
        } else if (store.repeat === 'all' && store.queue.length > 1) {
          const wrapped = idx % store.queue.length;
          if (wrapped !== store.currentIndex) candidate = store.queue[wrapped];
        }
        if (!candidate || !candidate.id || candidate.id <= 0) continue;
        if (candidate.is_downloaded === false || candidate.is_downloaded === 0) continue;
        if (isTrackDownloadedLocally(candidate.id) || hasTrackInStreamCache(candidate.id)) continue;
        if (!ids.includes(candidate.id)) {
          ids.push(candidate.id);
          if (ids.length >= 2) break;
        }
      }

      if (ids.length === 0) return;
      const key = `${quality}:${format}:${ids.join(',')}`;
      const now = Date.now();
      if (key === lastPreparedKey && now - lastPreparedAt < 20_000) return;
      lastPreparedKey = key;
      lastPreparedAt = now;

      apiRequest('/stream/prepare', {
        method: 'POST',
        body: JSON.stringify({ trackIds: ids, quality, format }),
        silentOffline: true,
        retries: 0,
        timeoutMs: 4000,
      }).catch(() => {});
    } catch (_) {}
  }, 600);
}

// Crossfade fade controller
let fadeInterval: any = null;
let isFadingIn = false;
let isFadingOut = false;

// WebAudio C++-thread infrasonic keep-alive to preserve Android AudioFocus & MediaSession importance
// during active playback and track transitions (suspended cleanly on pause so Bluetooth headsets
// do not see an active A2DP audio stream while paused).
let prewarmingPausedTrackId: number | null = null;
async function prewarmPausedTrack(track: Track | null | undefined) {
  if (!track || !track.id || track.id <= 0 || track.isPreview || track.streamUrl) return;
  if (getSynchronousBlobUrl(track.id) || getSynchronousStreamBlob(track.id)) return;
  if (prewarmingPausedTrackId === track.id) return;
  prewarmingPausedTrackId = track.id;
  try {
    const offlineCached = await isTrackCached(track.id);
    if (offlineCached) {
      await getCachedTrackUrl(track.id);
      return;
    }
    if (hasTrackInStreamCache(track.id)) {
      await getStreamCachedTrackUrl(track.id);
      return;
    }
    if ((typeof navigator === 'undefined' || navigator.onLine) && getStreamCacheLimitMb() > 0) {
      const q = resolveEffectiveStreamQuality(usePlayerStore.getState().streamQualityPref);
      const fmt = getPreferredStreamFormat();
      const ok = await prefetchTrackToStreamCache(track, q, fmt, undefined, 35000);
      if (ok) {
        await getStreamCachedTrackUrl(track.id, q);
      }
    }
  } catch (_) {
  } finally {
    if (prewarmingPausedTrackId === track.id) {
      prewarmingPausedTrackId = null;
    }
  }
}

function activateSilentAnchor() {
  if (typeof window === 'undefined') return;

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
}

function deactivateSilentAnchor() {
  if (audioCtx && audioCtxKeepAliveGain) {
    try {
      audioCtxKeepAliveGain.gain.cancelScheduledValues(audioCtx.currentTime);
      audioCtxKeepAliveGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.01);
      audioCtxKeepAliveGain.gain.value = 0;
    } catch (_) {
      try {
        audioCtxKeepAliveGain.gain.value = 0;
      } catch (_) {}
    }
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
let internalSrcChangeTimeout: any = null;
let pendingRecoveryOnResume = false;
let pendingRecoveryTime = 0;

function setInternalSrcChange(active: boolean) {
  isInternalSrcChange = active;
  if (internalSrcChangeTimeout) {
    clearTimeout(internalSrcChangeTimeout);
    internalSrcChangeTimeout = null;
  }
  if (active) {
    internalSrcChangeTimeout = setTimeout(() => {
      internalSrcChangeTimeout = null;
      isInternalSrcChange = false;
    }, 6000);
  }
}

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
        isActiveLocalPlay
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
let lastWatchdogBufferedEnd = 0;
let lastWatchdogWallTime = 0;
let lastBufferProgressWallTime = 0;
let stallsOnCurrentTrack = 0;

function stopPlaybackWatchdog() {
  if (playbackWatchdogTimer) {
    clearInterval(playbackWatchdogTimer);
    playbackWatchdogTimer = null;
  }
  lastWatchdogMediaTime = -1;
  lastWatchdogBufferedEnd = 0;
  lastWatchdogWallTime = 0;
}

function startPlaybackWatchdog() {
  if (playbackWatchdogTimer) return;
  lastWatchdogMediaTime = audio.currentTime || 0;
  lastWatchdogBufferedEnd = getBufferedEndAtCurrentTime();
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
      lastWatchdogBufferedEnd = getBufferedEndAtCurrentTime();
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
      lastWatchdogBufferedEnd = 0;
      lastWatchdogWallTime = Date.now();
      return;
    }

    // Do not force-resume or treat a paused element as frozen (e.g. Android ACTION_AUDIO_BECOMING_NOISY pause)
    if (audio.paused) {
      return;
    }

    // 3. Check for frozen playhead: if buffer is actively growing over WAN, do NOT abort the stream!
    const bufEnd = getBufferedEndAtCurrentTime();
    if (Math.abs(cur - lastWatchdogMediaTime) >= 0.05) {
      lastWatchdogMediaTime = cur;
      lastWatchdogBufferedEnd = bufEnd;
      lastWatchdogWallTime = Date.now();
    } else if (
      audio.networkState === HTMLMediaElement.NETWORK_LOADING &&
      bufEnd > lastWatchdogBufferedEnd + 0.25
    ) {
      lastWatchdogBufferedEnd = bufEnd;
      lastWatchdogWallTime = Date.now();
    } else if (Date.now() - lastWatchdogWallTime > 14000) {
      console.warn('[Watchdog] Playhead and buffer frozen for >14s, triggering stream recovery...');
      diag(`[watchdog] playhead frozen at ${cur.toFixed(1)}s → recovery`);
      lastWatchdogWallTime = Date.now();
      recoverAudioStream(cur > 0 ? cur : store.currentTime, true);
    }
  }, 2500);
}

function startPlaybackForTrack(track: Track, startTime = 0, autoPlay = true) {
  onTrackPlaybackStart(track);
  cancelActivePrefetch();
  const reqId = ++currentPlayRequestId;
  stallsOnCurrentTrack = 0;
  pendingRecoveryOnResume = false;
  pendingRecoveryTime = 0;
  setCurrentlyPlayingTrackId(track.id);
  markTrackTransitionStart();

  // Ensure WebAudio C++-thread keep-alive is running BEFORE mutating audio.src
  // so Chromium keeps the renderer audible and at high importance during track handover.
  if (autoPlay) {
    activateSilentAnchor();
    // Hold the Android MediaSession / media notification while audio.src is swapped in background
    if (typeof document !== 'undefined' && document.hidden) {
      startTransitionBridge(`track #${track.id}`);
    }
  }
  diag(`[track] start #${track.id} autoPlay=${autoPlay} hidden=${typeof document !== 'undefined' && document.hidden} blob=${Boolean(track.id > 0 && (getSynchronousBlobUrl(track.id) || getSynchronousStreamBlob(track.id)))}`);

  // If track has an explicit streamUrl (e.g. instant streaming from search)
  if (track.streamUrl) {
    usePlayerStore.setState({ activeStreamQuality: null, isBuffering: autoPlay, bufferedEnd: 0 });
    const applyInstantPlayback = (targetSrc: string) => {
      const needsChange = !audio.src.endsWith(targetSrc) && audio.src !== targetSrc;
      if (needsChange) {
        setInternalSrcChange(true);
        audio.src = targetSrc;
      }

      const applySeek = () => {
        if (reqId !== currentPlayRequestId) return;
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
              setInternalSrcChange(false);
              markTrackTransitionEnd();
            }
          }).catch((err) => {
            if (reqId !== currentPlayRequestId) return;
            setInternalSrcChange(false);
            console.warn('[Audio instant play interrupted / autoplay]:', err);
            if (err?.name === 'NotSupportedError' || audio.error !== null) {
              return;
            }
            setTimeout(() => {
              if (reqId !== currentPlayRequestId || isUserInitiatedPause || !audio.paused || audio.error !== null) return;
              audio.play().catch(() => {
                if (reqId === currentPlayRequestId && !isUserInitiatedPause) {
                  recoverAudioStream(startTime || 0, true);
                }
              });
            }, 250);
          });
        } else {
          setInternalSrcChange(false);
          markTrackTransitionEnd();
        }
      } else {
        audio.pause();
        markTrackTransitionEnd();
        setTimeout(() => { setInternalSrcChange(false); }, 100);
      }
    };

    applyInstantPlayback(track.streamUrl);
    return;
  }

  const applyPlayback = (targetSrc: string) => {
    const needsChange = !audio.src.endsWith(targetSrc) && audio.src !== targetSrc;
    if (needsChange) {
      setInternalSrcChange(true);
      audio.src = targetSrc;
    }

    const applySeek = () => {
      if (reqId !== currentPlayRequestId) return;
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
            setInternalSrcChange(false);
            markTrackTransitionEnd();
          }
        }).catch((err) => {
          if (reqId !== currentPlayRequestId) return;
          setInternalSrcChange(false);
          console.warn('[Audio play interrupted / autoplay]:', err);
          if (err.name === 'NotAllowedError' && typeof document !== 'undefined' && document.visibilityState === 'visible') {
            markTrackTransitionEnd();
            toast.info(tr('Click anywhere to enable audio on this device', 'Нажмите в любом месте для включения звука на этом устройстве'));
            return;
          }
          // If the underlying media element already failed (e.g. HTTP 404 / NotSupportedError),
          // let audio.onerror handle recovery or skipping instead of racing with a blind retry.
          if (err?.name === 'NotSupportedError' || audio.error !== null) {
            return;
          }
          // Automatic retry after 200ms if play() was interrupted at track boundary in background
          setTimeout(() => {
            if (reqId !== currentPlayRequestId || isUserInitiatedPause || !audio.paused || audio.error !== null) return;
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
        setInternalSrcChange(false);
        markTrackTransitionEnd();
      }
    } else {
      audio.pause();
      markTrackTransitionEnd();
      setTimeout(() => { setInternalSrcChange(false); }, 100);
    }
  };

  // 1. If synchronous blob URL is already in RAM (Offline or Smart Stream Cache), play directly (0ms latency)!
  const syncOfflineBlob = track.id > 0 ? getSynchronousBlobUrl(track.id) : null;
  if (syncOfflineBlob) {
    usePlayerStore.setState({
      activeStreamQuality: 'offline',
      isBuffering: false,
      bufferedEnd: (track.duration_ms || 0) / 1000,
    });
    applyPlayback(syncOfflineBlob);
    return;
  }

  const syncStreamBlob = track.id > 0 ? getSynchronousStreamBlob(track.id) : null;
  if (syncStreamBlob) {
    usePlayerStore.setState({
      activeStreamQuality: 'cache',
      isBuffering: false,
      bufferedEnd: (track.duration_ms || 0) / 1000,
    });
    applyPlayback(syncStreamBlob.blobUrl);
    return;
  }

  // 2. If index indicates track is already on disk in CacheStorage, read locally (~5-15ms) without firing wasted network request
  const maybeOffline = track.id > 0 && isTrackDownloadedLocally(track.id);
  const maybeStreamCached = track.id > 0 && hasTrackInStreamCache(track.id);

  if (maybeOffline || maybeStreamCached) {
    usePlayerStore.setState({
      activeStreamQuality: maybeOffline ? 'offline' : 'cache',
      isBuffering: false,
      bufferedEnd: 0,
    });
    (async () => {
      let localBlob: string | null = null;
      let sourceKind: 'offline' | 'cache' = 'offline';
      if (maybeOffline) {
        localBlob = await getCachedTrackUrl(track.id).catch(() => null);
      }
      if (!localBlob && maybeStreamCached) {
        const sc = await getStreamCachedTrackUrl(track.id).catch(() => null);
        if (sc) {
          localBlob = sc.blobUrl;
          sourceKind = 'cache';
        }
      }
      if (reqId !== currentPlayRequestId) return;

      if (localBlob) {
        usePlayerStore.setState({
          activeStreamQuality: sourceKind,
          isBuffering: false,
          bufferedEnd: (track.duration_ms || 0) / 1000,
        });
        applyPlayback(localBlob);
        return;
      }

      // Fallback if CacheStorage entry was evicted externally
      const q = resolveEffectiveStreamQuality(usePlayerStore.getState().streamQualityPref);
      const fmt = getPreferredStreamFormat();
      const remoteUrl = buildStreamUrl(track.id, q, fmt);
      usePlayerStore.setState({ activeStreamQuality: q, isBuffering: autoPlay, bufferedEnd: 0 });
      applyPlayback(remoteUrl);
      schedulePrepareUpcomingOnServer();
    })();
    return;
  }

  // 3. Remote track: select adaptive quality/codec and stream immediately
  const quality = resolveEffectiveStreamQuality(usePlayerStore.getState().streamQualityPref);
  const format = getPreferredStreamFormat();
  const streamUrl = buildStreamUrl(track.id, quality, format);
  usePlayerStore.setState({
    activeStreamQuality: quality,
    isBuffering: autoPlay,
    bufferedEnd: 0,
  });
  applyPlayback(streamUrl);
  schedulePrepareUpcomingOnServer();

  // 4. Safety check: if CacheStorage has this track even though localStorage index missed it, upgrade if stalled
  if (track.id > 0) {
    Promise.all([
      getCachedTrackUrl(track.id).catch(() => null),
      getStreamCachedTrackUrl(track.id, quality).catch(() => null),
    ]).then(([offlineUrl, streamCached]) => {
      if (reqId !== currentPlayRequestId || !autoPlay || isUserInitiatedPause) return;
      const blobUrl = offlineUrl || streamCached?.blobUrl;
      if (blobUrl && (audio.paused || audio.readyState < 2 || audio.error !== null)) {
        usePlayerStore.setState({
          activeStreamQuality: offlineUrl ? 'offline' : 'cache',
          isBuffering: false,
        });
        applyPlayback(blobUrl);
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
      activateSilentAnchor();
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
        const rate = (audio.playbackRate && isFinite(audio.playbackRate) && audio.playbackRate > 0)
          ? audio.playbackRate
          : 1;
        navigator.mediaSession.setPositionState({
          duration: Math.max(d, c),
          playbackRate: rate,
          position: Math.min(c, d)
        });
      } catch (_) {}
    }
  }
};

let networkRetryCount = 0;
let consecutiveErrors = 0;
let isRecoveringStream = false;
let errorRecoveryTimeout: any = null;
let stallTimeout: any = null;
let waitingTimeout: any = null;
let downloadedInstantTrack: Track | null = null;

async function isTrackMissingOnServer(trackId: number): Promise<boolean> {
  if (!trackId || trackId <= 0) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`/api/stream/${trackId}`, {
      method: 'HEAD',
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    return res.status === 404 || res.status === 410 || res.status === 403;
  } catch {
    return false;
  }
}

function skipUnavailableTrack(track: Track, reason: string) {
  const store = usePlayerStore.getState();
  if (!store.currentTrack || store.currentTrack.id !== track.id) return;
  if (isUserInitiatedPause) return;

  consecutiveErrors++;
  networkRetryCount = 0;

  if (consecutiveErrors >= 3) {
    consecutiveErrors = 0;
    usePlayerStore.setState({ isPlaying: false, isBuffering: false });
    stopTransitionBridge('playback error', true);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    diag(`[error] 3 consecutive track failures (${reason}) → stopped`, true);
    toast.error(tr('Playback error: network connection lost', 'Ошибка воспроизведения: потеряно подключение к сети'));
    return;
  }

  diag(`[error] skipping #${track.id} (${reason}, streak=${consecutiveErrors}/3)`, true);
  toast.warning(tr(`Skipping «${track.title}»`, `Пропуск «${track.title}» (файл недоступен)`));
  if (typeof document !== 'undefined' && document.hidden) {
    startTransitionBridge(`skip #${track.id}`);
  }
  if (errorRecoveryTimeout) clearTimeout(errorRecoveryTimeout);
  errorRecoveryTimeout = setTimeout(() => {
    const latest = usePlayerStore.getState();
    if (isUserInitiatedPause || !latest.currentTrack || latest.currentTrack.id !== track.id) return;
    latest.nextTrack();
  }, 300);
}

/**
 * Resilient stream recovery when network drops, switches from Wi-Fi to LTE,
 * seeks on an unseekable live transcode, or when the HTMLMediaElement encounters an error state.
 */
async function recoverAudioStream(
  resumeTime?: number,
  autoPlay: boolean = true,
  forceCacheBust: boolean = true,
  skipStreamCache: boolean = false
): Promise<void> {
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

    if (autoPlay && !isUserInitiatedPause && forceCacheBust) {
      stallsOnCurrentTrack++;
      if (stallsOnCurrentTrack >= 2 && store.streamQualityPref === 'auto') {
        reportStreamStall();
      }
    }

    console.log(`[Audio Recovery] Reconnecting stream for "${track.title}" at ${targetTime.toFixed(1)}s (autoPlay: ${autoPlay})`);
    diag(`[recovery] #${track.id} at ${targetTime.toFixed(1)}s autoPlay=${autoPlay}`);

    if (autoPlay && !isUserInitiatedPause && typeof document !== 'undefined' && document.hidden) {
      startTransitionBridge('recovery');
    }

    // 1. Check local offline cache & Smart Stream Cache first for instant 0ms playback without internet
    let targetSrc: string | null = getSynchronousBlobUrl(track.id);
    let recoveredQuality: 'offline' | 'cache' | ResolvedStreamQuality = 'offline';
    if (!targetSrc && !skipStreamCache) {
      const streamRam = getSynchronousStreamBlob(track.id);
      if (streamRam) {
        targetSrc = streamRam.blobUrl;
        recoveredQuality = 'cache';
      }
    }
    if (!targetSrc) {
      try {
        targetSrc = await getCachedTrackUrl(track.id);
        if (targetSrc) recoveredQuality = 'offline';
      } catch (_) {}
    }
    if (!targetSrc && !skipStreamCache) {
      try {
        const sc = await getStreamCachedTrackUrl(track.id);
        if (sc) {
          targetSrc = sc.blobUrl;
          recoveredQuality = 'cache';
        }
      } catch (_) {}
    }

    // 2. If not in cache, use canonical remote stream URL (with adaptive quality step-down on repeated stalls)
    if (!targetSrc) {
      const q = resolveEffectiveStreamQuality(store.streamQualityPref);
      const fmt = getPreferredStreamFormat();
      recoveredQuality = q;
      targetSrc = buildStreamUrl(track.id, q, fmt, forceCacheBust ? { reconnectTs: Date.now() } : undefined);
    }

    usePlayerStore.setState({
      activeStreamQuality: recoveredQuality,
      isBuffering: autoPlay && !targetSrc.startsWith('blob:'),
    });

    // 3. Reset HTMLMediaElement cleanly to wipe any MediaError state
    setInternalSrcChange(true);
    try {
      audio.pause();
    } catch (_) {}

    audio.removeAttribute('src');
    audio.load(); // W3C spec: resets media error to null, networkState to NETWORK_EMPTY
    audio.src = targetSrc;
    audio.load();

    // 4. Wait for metadata, canplay, or immediate error before restoring playback position
    await new Promise<void>((resolve) => {
      let resolved = false;
      const cleanupListeners = () => {
        audio.removeEventListener('loadedmetadata', onCanPlay);
        audio.removeEventListener('canplay', onCanPlay);
        audio.removeEventListener('error', onLoadError);
      };
      const done = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(fallbackTimer);
          cleanupListeners();
          resolve();
        }
      };

      const fallbackTimer = setTimeout(done, 4000);

      const onCanPlay = () => {
        if (targetTime > 0 && isFinite(targetTime)) {
          try {
            audio.currentTime = Math.min(targetTime, audio.duration || targetTime);
          } catch (e) {
            console.warn('[Seek on recover]:', e);
          }
        }
        done();
      };

      const onLoadError = () => {
        done();
      };

      if (audio.readyState >= 1 || audio.error !== null) {
        if (audio.readyState >= 1) onCanPlay();
        else done();
      } else {
        audio.addEventListener('loadedmetadata', onCanPlay, { once: true });
        audio.addEventListener('canplay', onCanPlay, { once: true });
        audio.addEventListener('error', onLoadError, { once: true });
      }
    });

    if (autoPlay && !isUserInitiatedPause) {
      checkAndInitAudioGraph();
      if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
        audioCtx.resume().catch(() => {});
      }

      try {
        await audio.play();
        setInternalSrcChange(false);
        usePlayerStore.setState({ isPlaying: true, isBuffering: false });
        activateSilentAnchor();
        startPlaybackWatchdog();
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
        networkRetryCount = 0;
      } catch (playErr: any) {
        setInternalSrcChange(false);
        console.warn('[Play after recovery failed]:', playErr);
        diag(`[recovery] play() failed: ${playErr?.name || playErr}`, true);
        if (playErr?.name === 'NotAllowedError') {
          stopTransitionBridge('recovery ended', true);
          usePlayerStore.setState({ isPlaying: false, isBuffering: false });
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'paused';
          }
        } else if (playErr?.name === 'NotSupportedError' || audio.error?.code === 4) {
          const missing = await isTrackMissingOnServer(track.id);
          if (missing || (typeof navigator !== 'undefined' && navigator.onLine)) {
            usePlayerStore.setState({ isBuffering: false });
            skipUnavailableTrack(track, missing ? 'recovery HTTP 404' : 'recovery NotSupportedError');
          } else {
            stopTransitionBridge('recovery ended', true);
          }
        } else {
          stopTransitionBridge('recovery ended', true);
        }
      }
    } else {
      if (autoPlay && isUserInitiatedPause) {
        pendingRecoveryOnResume = true;
        pendingRecoveryTime = targetTime;
      }
      stopTransitionBridge('recovery ended', true);
      setInternalSrcChange(false);
    }
  } catch (err) {
    setInternalSrcChange(false);
    stopTransitionBridge('recovery ended', true);
    console.warn('[Audio Recovery Exception]:', err);
  } finally {
    isRecoveringStream = false;
  }
}

export const usePlayerStore = create<PlayerState>((set, get) => {
  // Sync Audio Events
  let lastSyncTime = 0;
  let lastBufferedReport = 0;

  registerRemoteStreamPriorityCheck(() => {
    const s = get();
    if (!s.isPlaying || !s.currentTrack) return false;
    if (audio.src.startsWith('blob:')) return false;
    if (s.activeStreamQuality === 'offline' || s.activeStreamQuality === 'cache') return false;
    return s.isBuffering || (audio.currentTime || s.currentTime) < 15;
  });

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

  audio.onloadstart = () => {
    if (get().isPlaying && !audio.src.startsWith('blob:')) {
      set({ isBuffering: true, bufferedEnd: 0 });
    }
  };

  audio.onplay = () => {
    clearInterruptionRetries();
    setInternalSrcChange(false);
    isUserInitiatedPause = false;
    wasInterruptedByExternalApp = false;
    activateSilentAnchor();
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

    // 1b. Ignore browser-generated pause triggered by a fatal media load error (e.g. HTTP 404 / MEDIA_ERR_SRC_NOT_SUPPORTED)
    //     so audio.onerror / skipUnavailableTrack can recover or advance the queue instead of treating it as a user pause.
    if (audio.error !== null && get().isPlaying && !isUserInitiatedPause) {
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
    deactivateSilentAnchor();
    prewarmPausedTrack(get().currentTrack).catch(() => {});
    diag(`[pause] main element paused at ${cur.toFixed(1)}/${(dur || 0).toFixed(1)}s hidden=${document.hidden}`, true);
    diagHeartbeat(false, get().currentTrack?.id);

    set({ isPlaying: false, isBuffering: false });
    onPlaybackPausedOrStopped();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
    updateMediaPositionState();
    savePlayerSessionState(get(), true);
    useSyncStore.getState().sendPlaybackState({ isPlaying: false });
  };

  audio.onerror = () => {
    markTrackTransitionEnd();
    setInternalSrcChange(false);
    set({ isBuffering: false });
    const err = audio.error;
    const { currentTrack, isPlaying } = get();
    console.warn('[Audio Error Event]: code =', err?.code, 'message =', err?.message, 'track =', currentTrack?.title);
    diag(`[error] media error code=${err?.code} track=#${currentTrack?.id} online=${navigator.onLine}`);

    if (!currentTrack) return;

    // If recoverAudioStream is actively running, let it handle the error itself (avoids duplicate retries/skips)
    if (isRecoveringStream) return;

    const savedPos = audio.currentTime > 0 ? audio.currentTime : get().currentTime;

    // Never call audio.load() / mutate audio.src while genuinely paused: Chromium removes the MediaSession
    // player and tears down the Android Media Notification when load() runs without play().
    // Note: do NOT check audio.paused here — Chromium sets audio.paused = true before firing 'error' on
    // MEDIA_ERR_SRC_NOT_SUPPORTED (e.g. HTTP 404), which would otherwise suppress auto-skip & recovery.
    if (!isPlaying || isUserInitiatedPause) {
      pendingRecoveryOnResume = true;
      pendingRecoveryTime = savedPos;
      console.log(`[Audio Error while paused] Deferring stream recovery at ${savedPos.toFixed(1)}s until resume to keep MediaSession alive.`);
      return;
    }

    const failedTrack = currentTrack;
    const errCode = err?.code;
    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;

    // Fast-path for MEDIA_ERR_SRC_NOT_SUPPORTED (code=4) while online:
    // probe HEAD to immediately distinguish a missing file (HTTP 404) from a transient network/gateway error.
    if (errCode === 4 && !isOffline && failedTrack.id > 0 && !failedTrack.streamUrl) {
      isTrackMissingOnServer(failedTrack.id).then((missing) => {
        const latest = get();
        if (isUserInitiatedPause || !latest.isPlaying || latest.currentTrack?.id !== failedTrack.id) return;

        if (missing) {
          skipUnavailableTrack(failedTrack, 'HTTP 404');
          return;
        }

        if (networkRetryCount < 2) {
          networkRetryCount++;
          console.warn(`[Audio Error] Source not supported (transient?). Retry ${networkRetryCount}/2 at ${savedPos.toFixed(1)}s...`);
          if (errorRecoveryTimeout) clearTimeout(errorRecoveryTimeout);
          const delay = 600 + networkRetryCount * 700;
          errorRecoveryTimeout = setTimeout(() => {
            const cur = get();
            if (!cur.isPlaying || isUserInitiatedPause || cur.currentTrack?.id !== failedTrack.id) return;
            recoverAudioStream(savedPos, true);
          }, delay);
          return;
        }

        skipUnavailableTrack(failedTrack, 'code=4 retries exhausted');
      }).catch(() => {
        skipUnavailableTrack(failedTrack, 'code=4 probe failed');
      });
      return;
    }

    // Check if offline or network/decode stream failure:
    // MediaError.MEDIA_ERR_NETWORK (2)
    // MediaError.MEDIA_ERR_DECODE (3 - abruptly severed stream causes decode error at EOF)
    // MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED (4 when offline or instant streamUrl)
    const isNetworkErr = isOffline || errCode === 2 || errCode === 3 || errCode === 4;
    const maxRetries = errCode === 4 ? 2 : 10;

    if (isNetworkErr && networkRetryCount < maxRetries) {
      networkRetryCount++;
      console.warn(`[Audio Error] Network stream interrupted. Attempting auto-reconnect ${networkRetryCount}/${maxRetries} at ${savedPos.toFixed(1)}s...`);

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

    // Persistent error or retries exhausted → skip to next track
    skipUnavailableTrack(failedTrack, `code=${errCode ?? 'unknown'}`);
  };

  audio.onplaying = () => {
    clearInterruptionRetries();
    setInternalSrcChange(false);
    markTrackTransitionEnd();
    consecutiveErrors = 0;
    networkRetryCount = 0;
    if (errorRecoveryTimeout) clearTimeout(errorRecoveryTimeout);
    if (stallTimeout) clearTimeout(stallTimeout);
    if (waitingTimeout) clearTimeout(waitingTimeout);
    activateSilentAnchor();
    if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
      audioCtx.resume().catch(() => {});
    }
    startPlaybackWatchdog();
    const bEnd = getBufferedEndAtCurrentTime();
    set({ isPlaying: true, isBuffering: false, ...(bEnd > 0 ? { bufferedEnd: bEnd } : {}) });
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
    if (get().isPlaying && !audio.src.startsWith('blob:')) {
      set({ isBuffering: true });
    }
    if (get().isPlaying && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
    // WAN buffer resilience: give connection up to 14s and avoid resetting if buffer is actively arriving
    if (waitingTimeout) clearTimeout(waitingTimeout);
    waitingTimeout = setTimeout(() => {
      if (
        get().isPlaying &&
        audio.readyState < 3 &&
        Date.now() - lastBufferProgressWallTime > 10000
      ) {
        console.warn('[Audio Waiting]: Stalled waiting for buffer for >14s, reconnecting stream...');
        recoverAudioStream(audio.currentTime || get().currentTime, true);
      }
    }, 14000);
  };

  audio.onstalled = () => {
    if (isPrefetching) {
      cancelActivePrefetch();
    }
    if (!get().isPlaying) return;
    if (stallTimeout) clearTimeout(stallTimeout);
    stallTimeout = setTimeout(() => {
      if (get().isPlaying && audio.readyState < 3) {
        console.warn('[Audio Stalled]: Stream stalled for >15s, reconnecting stream...');
        recoverAudioStream(audio.currentTime || get().currentTime, true);
      }
    }, 15000);
  };

  audio.onprogress = () => {
    lastBufferProgressWallTime = Date.now();
    if (stallTimeout) {
      clearTimeout(stallTimeout);
      stallTimeout = null;
    }
    const bEnd = getBufferedEndAtCurrentTime();
    if (Math.abs(bEnd - lastBufferedReport) >= 0.5) {
      lastBufferedReport = bEnd;
      set({ bufferedEnd: bEnd });
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

    const bEnd = getBufferedEndAtCurrentTime();
    if (Math.abs(bEnd - lastBufferedReport) >= 1.0) {
      lastBufferedReport = bEnd;
      update.bufferedEnd = bEnd;
    }

    set(update);
    savePlayerSessionState(get(), false);

    if (cur >= 60 && stallsOnCurrentTrack === 0) {
      resetStreamStalls();
    }

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

    onPlaybackTimeUpdate(cur, effectiveDur, !audio.paused);

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
      onPreviewUpgradedToFull(nextTrack);
      const q = resolveEffectiveStreamQuality(get().streamQualityPref);
      const fmt = getPreferredStreamFormat();
      set({
        currentTrack: { ...nextTrack, isPreview: false },
        duration: (nextTrack.duration_ms || 180000) / 1000,
        queue: [nextTrack],
        activeStreamQuality: q,
      });
      setInternalSrcChange(true);
      audio.src = buildStreamUrl(nextTrack.id, q, fmt);
      const onReady = () => {
        try { audio.currentTime = savedTime; } catch (_) {}
        audio.play().then(() => { setInternalSrcChange(false); }).catch(() => { setInternalSrcChange(false); });
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
      onTrackEndedOrRepeated(repeat === 'one', get().currentTrack);
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
  audio.oncanplay = () => {
    handleAudioDuration();
    if (get().isBuffering) {
      set({ isBuffering: false });
    }
  };

  audio.onended = () => {
    diag(`[ended] #${get().currentTrack?.id} transitioning=${isTransitioningTrack}`);
    set({ isBuffering: false });
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
      onPreviewUpgradedToFull(nextTrack);
      const q = resolveEffectiveStreamQuality(get().streamQualityPref);
      const fmt = getPreferredStreamFormat();
      set({
        currentTrack: { ...nextTrack, isPreview: false },
        duration: (nextTrack.duration_ms || 180000) / 1000,
        queue: [nextTrack],
        activeStreamQuality: q,
      });
      setInternalSrcChange(true);
      audio.src = buildStreamUrl(nextTrack.id, q, fmt);
      const onReady = () => {
        try { audio.currentTime = 29; } catch (_) {}
        audio.play().then(() => { setInternalSrcChange(false); }).catch(() => { setInternalSrcChange(false); });
        markTrackTransitionEnd();
      };
      if (audio.readyState >= 1) onReady();
      else audio.addEventListener('loadedmetadata', onReady, { once: true });
      return;
    }

    const { repeat, nextTrack } = get();
    onTrackEndedOrRepeated(repeat === 'one', get().currentTrack);
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
          isActiveLocalPlay
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
        diag(`[mediaSession] play (hidden=${document.hidden}, audio.paused=${audio.paused})`, true);
        if (!useSyncStore.getState().isLocalActive) {
          useSyncStore.setState({ isLocalActive: true });
        }
        clearInterruptionRetries();
        isUserInitiatedPause = false;
        wasInterruptedByExternalApp = false;
        activateSilentAnchor();
        get().resume();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        diag(`[mediaSession] pause (hidden=${document.hidden}, audio.paused=${audio.paused})`, true);
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
          diag(`[mediaSession] stop (hidden=${document.hidden})`, true);
          clearInterruptionRetries();
          isUserInitiatedPause = true;
          wasInterruptedByExternalApp = false;
          get().pause();
        });
      } catch (_) {}
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        diag('[mediaSession] previoustrack', true);
        if (!useSyncStore.getState().isLocalActive) {
          useSyncStore.setState({ isLocalActive: true });
        }
        get().prevTrack();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        diag('[mediaSession] nexttrack', true);
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

  const isBufferSafeForPrefetch = (minBufferAheadSec: number): boolean => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
    // If playing from a local blob URL, network bandwidth is 100% free immediately!
    if (audio.src.startsWith('blob:')) return true;

    const cur = audio.currentTime;
    if (cur < 4) return false;

    if (!audio.duration || !isFinite(audio.duration) || audio.duration <= 0) {
      return cur >= 10 && audio.readyState >= 3;
    }

    for (let i = 0; i < audio.buffered.length; i++) {
      if (audio.buffered.start(i) <= cur && cur <= audio.buffered.end(i)) {
        const bufferedAhead = audio.buffered.end(i) - cur;
        return bufferedAhead >= minBufferAheadSec || audio.buffered.end(i) >= (audio.duration - 1);
      }
    }
    return cur >= minBufferAheadSec && audio.readyState >= 3;
  };

  let lastPrefetchCheckTime = 0;

  const triggerEventDrivenPrefetch = async () => {
    if (isPrefetching) return;
    const now = Date.now();
    if (now - lastPrefetchCheckTime < 1500) return;
    lastPrefetchCheckTime = now;

    const { queue, currentIndex, currentTrack, isPlaying, repeat, streamQualityPref } = get();
    if (!isPlaying || !currentTrack || !queue || queue.length === 0 || currentIndex < 0) return;

    const effectiveQuality = resolveEffectiveStreamQuality(streamQualityPref);
    const format = getPreferredStreamFormat();
    const profile = getPrefetchProfile(effectiveQuality);

    // Keep server pre-transcoding 1-2 upcoming remote tracks warm
    schedulePrepareUpcomingOnServer();

    const upcomingIndices: number[] = [];
    for (let offset = 1; offset <= profile.lookaheadTracks; offset++) {
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

    let targetTrack: Track | null = null;
    let isImmediateNext = false;
    let targetOffsetIndex = 0;
    let remainingCandidates = 0;

    for (let i = 0; i < upcomingIndices.length; i++) {
      const idx = upcomingIndices[i];
      const candidate = queue[idx];
      if (!candidate || candidate.id <= 0) continue;

      const existingOfflineBlob = getSynchronousBlobUrl(candidate.id);
      const existingStreamBlob = getSynchronousStreamBlob(candidate.id);
      const existingBlob = existingOfflineBlob || existingStreamBlob?.blobUrl;
      if (existingBlob) {
        if (i === 0) {
          preloadNextTrackElement(existingBlob);
        }
        continue;
      }

      if (isTrackDownloadedLocally(candidate.id)) {
        const offlineUrl = await getCachedTrackUrl(candidate.id).catch(() => null);
        if (offlineUrl) {
          if (i === 0) preloadNextTrackElement(offlineUrl);
          continue;
        }
      }

      if (hasTrackInStreamCache(candidate.id)) {
        const sc = await getStreamCachedTrackUrl(candidate.id, effectiveQuality).catch(() => null);
        if (sc) {
          if (i === 0) preloadNextTrackElement(sc.blobUrl);
          continue;
        }
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
    if (isImmediateNext) {
      preloadNextTrackElement(buildStreamUrl(targetTrack.id, effectiveQuality, format));
    }
    if (getStreamCacheLimitMb() === 0) return;
    if (!isBufferSafeForPrefetch(profile.minBufferAheadSec)) return;

    isPrefetching = true;
    prefetchAbortController = new AbortController();

    try {
      console.log(`[Smart Prefetch] Pre-caching upcoming track (+${targetOffsetIndex + 1}) at ${effectiveQuality}/${format}: "${targetTrack.title}"`);
      const ok = await prefetchTrackToStreamCache(
        targetTrack,
        effectiveQuality,
        format,
        prefetchAbortController.signal
      );

      if (ok && targetOffsetIndex < 2) {
        const sc = await getStreamCachedTrackUrl(targetTrack.id, effectiveQuality).catch(() => null);
        if (isImmediateNext) {
          preloadNextTrackElement(sc?.blobUrl || buildStreamUrl(targetTrack.id, effectiveQuality, format));
        }
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.warn('[Smart Prefetch] Prefetch error:', err);
      }
    } finally {
      isPrefetching = false;
      prefetchAbortController = null;
      if (remainingCandidates > 0 && get().isPlaying) {
        if (prefetchTimeout) clearTimeout(prefetchTimeout);
        prefetchTimeout = setTimeout(() => {
          triggerEventDrivenPrefetch();
        }, 1200);
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
        const q = resolveEffectiveStreamQuality(get().streamQualityPref);
        const fmt = getPreferredStreamFormat();
        let streamUrl = buildStreamUrl(restoredTrack.id, q, fmt);
        let restoredQuality: 'offline' | 'cache' | ResolvedStreamQuality = q;
        try {
          const cachedUrl = await getCachedTrackUrl(restoredTrack.id);
          if (cachedUrl) {
            streamUrl = cachedUrl;
            restoredQuality = 'offline';
          } else {
            const sc = await getStreamCachedTrackUrl(restoredTrack.id);
            if (sc) {
              streamUrl = sc.blobUrl;
              restoredQuality = 'cache';
            }
          }
        } catch (_) {}
        if (audio.src || get().currentTrack?.id !== restoredTrack.id) return;
        set({ activeStreamQuality: restoredQuality });
        setInternalSrcChange(true);
        audio.src = streamUrl;
        updateMediaSession(restoredTrack);
        const applyRestoredPos = () => {
          if (get().currentTrack?.id !== restoredTrack.id) return;
          try {
            if (restoredTime > 0 && isFinite(audio.duration) && restoredTime < audio.duration) {
              audio.currentTime = restoredTime;
            }
          } catch (_) {}
          setInternalSrcChange(false);
          updateMediaSession(restoredTrack);
          updateMediaPositionState();
        };
        if (audio.readyState >= 1) applyRestoredPos();
        else audio.addEventListener('loadedmetadata', applyRestoredPos, { once: true });
      } catch (_) {
        setInternalSrcChange(false);
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

    streamQualityPref: getSavedStreamQualityPref(),
    activeStreamQuality: null,
    isBuffering: false,
    bufferedEnd: 0,
    setStreamQualityPref: (pref: StreamQualityPreference) => {
      const normalized = parseStreamQualityPref(pref);
      saveStreamQualityPref(normalized);
      resetStreamStalls();
      set({ streamQualityPref: normalized });
      apiRequest('/user/settings', {
        method: 'PUT',
        body: JSON.stringify({ streamQualityPref: normalized }),
      }).catch(() => {});

      const { currentTrack, isPlaying, currentTime } = get();
      if (
        currentTrack &&
        currentTrack.id > 0 &&
        !currentTrack.isPreview &&
        !currentTrack.streamUrl &&
        !isTrackDownloadedLocally(currentTrack.id)
      ) {
        const pos = audio.currentTime > 0 ? audio.currentTime : currentTime;
        if (isPlaying && !audio.paused) {
          recoverAudioStream(pos, true, false, true);
        } else {
          pendingRecoveryOnResume = true;
          pendingRecoveryTime = pos;
        }
      }
      scheduleNextTrackPrefetch();
    },

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
      onPlaybackPausedOrStopped();
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
        get().pause();
      } else {
        get().resume();
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
        deactivateSilentAnchor();
        prewarmPausedTrack(get().currentTrack).catch(() => {});
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
      setInternalSrcChange(false);
      activateSilentAnchor();
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

      diag(
        `[resume] #${currentTrack.id} paused=${audio.paused} rs=${audio.readyState} ns=${audio.networkState} err=${audio.error?.code ?? 'none'} pending=${pendingRecoveryOnResume}`,
        true
      );
      startPlaybackWatchdog();
      checkAndInitAudioGraph();
      if (audioCtx && (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted')) {
        audioCtx.resume().catch(() => {});
      }

      const isBroken = !audio.src ||
        audio.error !== null ||
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
          diag(`[resume] audio.play() failed: ${err?.name || err}`, true);
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
          let isUnseekableLiveStream = false;
          try {
            if (!audio.src.startsWith('blob:')) {
              if (audio.seekable.length === 0) {
                isUnseekableLiveStream = true;
              } else {
                const maxSeekable = audio.seekable.end(audio.seekable.length - 1);
                if (isFinite(maxSeekable) && seconds > maxSeekable + 1) {
                  isUnseekableLiveStream = true;
                }
              }
            }
          } catch (_) {}

          if (isUnseekableLiveStream) {
            recoverAudioStream(seconds, get().isPlaying, false);
          } else {
            try {
              audio.currentTime = seconds;
            } catch (_) {
              recoverAudioStream(seconds, get().isPlaying);
            }
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
          setInternalSrcChange(true);
          audio.pause();
          audio.src = '';
          setTimeout(() => { setInternalSrcChange(false); }, 100);
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

      if (settings.streamQualityPref !== undefined) {
        const parsedQuality = parseStreamQualityPref(settings.streamQualityPref);
        updates.streamQualityPref = parsedQuality;
        saveStreamQualityPref(parsedQuality);
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

    reloadCurrentTrackStream: (trackOverride?: Track, resetToStart: boolean = false) => {
      const { currentTrack, isPlaying, currentTime, queue, originalQueue } = get();
      const t = trackOverride || currentTrack;
      if (t && t.id > 0) {
        if (trackOverride) {
          const updatedQueue = queue.map((q) => (q.id === trackOverride.id ? { ...q, ...trackOverride } : q));
          const updatedOrigQueue = originalQueue.map((q) => (q.id === trackOverride.id ? { ...q, ...trackOverride } : q));
          if (currentTrack?.id !== trackOverride.id) {
            set({
              queue: updatedQueue,
              originalQueue: updatedOrigQueue,
            });
            return;
          }
          const nextCurrent = { ...currentTrack, ...trackOverride };
          const nextDuration = (trackOverride.duration_ms || 180000) / 1000;
          const shouldReset = resetToStart || currentTime >= nextDuration;
          set({
            currentTrack: nextCurrent,
            duration: nextDuration,
            queue: updatedQueue,
            originalQueue: updatedOrigQueue,
            ...(shouldReset ? { currentTime: 0 } : {}),
          });
          updateMediaSession(nextCurrent);
        } else if (currentTrack?.id !== t.id) {
          return;
        }
        const activeDuration = (t.duration_ms || 180000) / 1000;
        const shouldReset = resetToStart || currentTime >= activeDuration;
        const targetTime = shouldReset ? 0 : (currentTime > 0 ? currentTime : 0);
        if (shouldReset) {
          set({ currentTime: 0 });
          try {
            audio.currentTime = 0;
          } catch (_) {}
        }
        if (!isPlaying || audio.paused) {
          setInternalSrcChange(true);
          try {
            audio.removeAttribute('src');
            audio.load();
          } catch (_) {}
          setInternalSrcChange(false);
          pendingRecoveryOnResume = true;
          pendingRecoveryTime = targetTime;
          return;
        }
        recoverAudioStream(targetTime, true, true, true);
      }
    },
  };
});

// Global network change listeners for automatic stream recovery & offline resilience
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    console.log('[Player] Network connection restored (online event)');
    resetStreamStalls();
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

      if (isBroken || (state.isPlaying && !audio.src.startsWith('blob:'))) {
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
        getStreamCachedTrackUrl(state.currentTrack.id).catch(() => {});
        pendingRecoveryOnResume = true;
        pendingRecoveryTime = audio.currentTime > 0 ? audio.currentTime : state.currentTime;
        return;
      }
      // Seamlessly switch to offline cached or smart-stream-cached blob if available while playing
      Promise.all([
        getCachedTrackUrl(state.currentTrack.id).catch(() => null),
        getStreamCachedTrackUrl(state.currentTrack.id).catch(() => null),
      ]).then(([offlineUrl, streamCached]) => {
        const blobUrl = offlineUrl || streamCached?.blobUrl;
        if (blobUrl) {
          const latest = usePlayerStore.getState();
          if (!latest.isPlaying || audio.paused) {
            pendingRecoveryOnResume = true;
            pendingRecoveryTime = audio.currentTime > 0 ? audio.currentTime : latest.currentTime;
            return;
          }
          console.log('[Player] Switching to local cached blob URL during network loss');
          const curTime = audio.currentTime;
          setInternalSrcChange(true);
          audio.src = blobUrl;
          const applySeek = () => {
            try { audio.currentTime = curTime; } catch (_) {}
            if (usePlayerStore.getState().isPlaying) {
              audio.play().then(() => { setInternalSrcChange(false); }).catch(() => { setInternalSrcChange(false); });
            } else {
              setInternalSrcChange(false);
            }
          };
          if (audio.readyState >= 1) applySeek();
          else audio.addEventListener('loadedmetadata', applySeek, { once: true });
        }
      }).catch(() => {});
    }
  });
}
