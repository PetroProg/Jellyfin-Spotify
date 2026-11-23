import { apiRequest, getToken } from '../api/client';
import type { Track } from '../types';

interface PlaySession {
  sessionId: string;
  trackId: number | null;
  title: string;
  artist: string;
  durationSec: number;
  accumulatedSec: number;
  lastAudioTime: number | null;
  lastWallTime: number | null;
  qualified: boolean;
  lastReportedSec: number;
  startedAtIso: string;
}

const MIN_QUALIFY_SEC = 30;
const SHORT_TRACK_SEC = 60;
const SHORT_TRACK_MIN_SEC = 10;
const PERIODIC_UPDATE_STEP_SEC = 30;
const MAX_SEEK_TOLERANCE_SEC = 3;

let currentSession: PlaySession | null = null;
let listenersInitialized = false;

function generateSessionId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `ls_${Date.now().toString(36)}_${rand}`;
}

function getQualifyThresholdSec(durationSec: number): number {
  if (durationSec > 0 && durationSec < SHORT_TRACK_SEC) {
    return Math.max(SHORT_TRACK_MIN_SEC, Math.round(durationSec * 0.5));
  }
  return MIN_QUALIFY_SEC;
}

function createSession(track: Track): PlaySession | null {
  const title = (track.title || '').trim();
  const artist = (track.artist || '').trim();
  if (!title || !artist) return null;

  const durationSec =
    track.duration_ms && Number.isFinite(track.duration_ms) && track.duration_ms > 0
      ? Math.round(track.duration_ms / 1000)
      : 0;

  return {
    sessionId: generateSessionId(),
    trackId: typeof track.id === 'number' && Number.isInteger(track.id) && track.id > 0 ? track.id : null,
    title,
    artist,
    durationSec,
    accumulatedSec: 0,
    lastAudioTime: null,
    lastWallTime: null,
    qualified: false,
    lastReportedSec: 0,
    startedAtIso: new Date().toISOString(),
  };
}

function sendSessionUpdate(session: PlaySession): void {
  if (!getToken()) return;

  const listenedSec = Math.round(session.accumulatedSec);
  if (listenedSec < SHORT_TRACK_MIN_SEC) return;

  const maxSensible = session.durationSec > 0 ? Math.max(session.durationSec + 5, MIN_QUALIFY_SEC) : 7200;
  const clampedListened = Math.min(maxSensible, listenedSec);

  if (clampedListened <= session.lastReportedSec && session.lastReportedSec > 0) {
    return;
  }

  session.lastReportedSec = clampedListened;

  const payload = {
    clientEventId: session.sessionId,
    trackId: session.trackId,
    title: session.title,
    artist: session.artist,
    durationSec: session.durationSec,
    listenedSec: clampedListened,
    playedAt: session.startedAtIso,
  };

  apiRequest('/listening/log', {
    method: 'POST',
    body: JSON.stringify(payload),
    queueIfOffline: true,
    silentOffline: true,
    coalesceKey: `listen_${session.sessionId}`,
    actionType: 'LOG_LISTENING',
    retries: 1,
    timeoutMs: 12000,
  }).catch(() => {
    // Non-critical telemetry; offline or transient failures are absorbed by outbox or safely ignored
  });
}

function flushIfQualified(session: PlaySession | null, minDeltaSec = 2): void {
  if (!session) return;

  const threshold = getQualifyThresholdSec(session.durationSec);
  if (!session.qualified && session.accumulatedSec >= threshold) {
    session.qualified = true;
  }

  if (!session.qualified) return;

  const deltaSinceLast = session.accumulatedSec - session.lastReportedSec;
  if (session.lastReportedSec === 0 || deltaSinceLast >= minDeltaSec) {
    sendSessionUpdate(session);
  }
}

function ensureLifecycleListeners(): void {
  if (listenersInitialized || typeof window === 'undefined') return;
  listenersInitialized = true;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushIfQualified(currentSession, 5);
    }
  });

  window.addEventListener('pagehide', () => {
    flushIfQualified(currentSession, 2);
  });
}

export function onTrackPlaybackStart(track: Track): void {
  ensureLifecycleListeners();
  flushIfQualified(currentSession, 2);
  currentSession = createSession(track);
}

export function onPreviewUpgradedToFull(fullTrack: Track): void {
  ensureLifecycleListeners();
  if (!currentSession) {
    currentSession = createSession(fullTrack);
    return;
  }

  if (typeof fullTrack.id === 'number' && Number.isInteger(fullTrack.id) && fullTrack.id > 0) {
    currentSession.trackId = fullTrack.id;
  }
  if (fullTrack.title?.trim()) {
    currentSession.title = fullTrack.title.trim();
  }
  if (fullTrack.artist?.trim()) {
    currentSession.artist = fullTrack.artist.trim();
  }
  if (fullTrack.duration_ms && fullTrack.duration_ms > 0) {
    currentSession.durationSec = Math.round(fullTrack.duration_ms / 1000);
  }
}

export function onPlaybackTimeUpdate(currentTime: number, duration: number, isPlaying: boolean): void {
  if (!currentSession) return;

  const now = Date.now();
  if (!isPlaying || !Number.isFinite(currentTime) || currentTime < 0) {
    currentSession.lastAudioTime = null;
    currentSession.lastWallTime = null;
    return;
  }

  if (Number.isFinite(duration) && duration > 0) {
    currentSession.durationSec = Math.round(duration);
  }

  if (currentSession.lastAudioTime === null || currentSession.lastWallTime === null) {
    currentSession.lastAudioTime = currentTime;
    currentSession.lastWallTime = now;
    return;
  }

  const deltaAudio = currentTime - currentSession.lastAudioTime;
  const deltaWall = (now - currentSession.lastWallTime) / 1000;

  currentSession.lastAudioTime = currentTime;
  currentSession.lastWallTime = now;

  // Count only genuine forward playback (ignore seeks and negative jumps)
  if (deltaAudio > 0 && deltaWall >= 0 && deltaAudio <= deltaWall + MAX_SEEK_TOLERANCE_SEC) {
    currentSession.accumulatedSec += deltaAudio;

    const threshold = getQualifyThresholdSec(currentSession.durationSec);
    if (!currentSession.qualified && currentSession.accumulatedSec >= threshold) {
      currentSession.qualified = true;
      sendSessionUpdate(currentSession);
    } else if (
      currentSession.qualified &&
      currentSession.accumulatedSec - currentSession.lastReportedSec >= PERIODIC_UPDATE_STEP_SEC
    ) {
      sendSessionUpdate(currentSession);
    }
  }
}

export function onPlaybackPausedOrStopped(): void {
  if (!currentSession) return;
  currentSession.lastAudioTime = null;
  currentSession.lastWallTime = null;
  flushIfQualified(currentSession, 5);
}

export function onTrackEndedOrRepeated(isRepeatOne: boolean, track?: Track | null): void {
  if (currentSession) {
    flushIfQualified(currentSession, 2);
  }

  if (isRepeatOne && track) {
    currentSession = createSession(track);
    if (currentSession) {
      currentSession.lastAudioTime = 0;
      currentSession.lastWallTime = Date.now();
    }
  } else {
    currentSession = null;
  }
}
