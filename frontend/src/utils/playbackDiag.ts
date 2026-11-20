// Lightweight persistent playback diagnostics (ring buffer in localStorage).
// Helps to understand why Android/Chrome stops background playback or kills the PWA renderer:
// records page lifecycle events (hidden/freeze/resume/pagehide), track transitions and
// detects on next launch whether the previous session was killed while playing.
// Never logs tokens, URLs with credentials or personal data — only track ids and states.

const DIAG_KEY = 'jellyfy_playback_diag_v1';
const HEARTBEAT_KEY = 'jellyfy_playback_heartbeat_v1';
const MAX_ENTRIES = 250;

type DiagEntry = { t: number; m: string };

let buffer: DiagEntry[] | null = null;
let flushTimer: any = null;

function load(): DiagEntry[] {
  if (buffer) return buffer;
  try {
    const raw = localStorage.getItem(DIAG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    buffer = Array.isArray(parsed) ? parsed.slice(-MAX_ENTRIES) : [];
  } catch (_) {
    buffer = [];
  }
  return buffer!;
}

function flush() {
  flushTimer = null;
  try {
    localStorage.setItem(DIAG_KEY, JSON.stringify(load().slice(-MAX_ENTRIES)));
  } catch (_) {}
}

export function diag(message: string, immediate = false): void {
  if (typeof window === 'undefined') return;
  const buf = load();
  buf.push({ t: Date.now(), m: String(message).slice(0, 300) });
  if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES);
  if (immediate) {
    if (flushTimer) clearTimeout(flushTimer);
    flush();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flush, 1500);
  }
}

/** Periodic heartbeat while playing: lets the next launch detect an unexpected renderer kill. */
export function diagHeartbeat(isPlaying: boolean, trackId: number | null | undefined): void {
  try {
    localStorage.setItem(
      HEARTBEAT_KEY,
      JSON.stringify({ t: Date.now(), playing: isPlaying, track: trackId ?? null, hidden: document.hidden })
    );
  } catch (_) {}
}

export function getDiagLogText(): string {
  const fmt = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  };
  const header = `Jellyfy playback diagnostics\nUA: ${navigator.userAgent}\nExported: ${fmt(Date.now())}\n\n`;
  return header + load().map((e) => `${fmt(e.t)}  ${e.m}`).join('\n');
}

export function clearDiagLog(): void {
  buffer = [];
  try {
    localStorage.removeItem(DIAG_KEY);
  } catch (_) {}
}

let initialized = false;
export function initPlaybackDiagnostics(): void {
  if (initialized || typeof window === 'undefined' || typeof document === 'undefined') return;
  initialized = true;

  // Detect how the previous session ended
  try {
    const raw = localStorage.getItem(HEARTBEAT_KEY);
    const hb = raw ? JSON.parse(raw) : null;
    const wasDiscarded = Boolean((document as any).wasDiscarded);
    if (hb && hb.playing) {
      const ago = Math.round((Date.now() - Number(hb.t || 0)) / 1000);
      diag(
        `[startup] previous session was PLAYING (track #${hb.track}, hidden=${hb.hidden}) — last heartbeat ${ago}s ago` +
          ` → app was killed during playback${wasDiscarded ? ' (document.wasDiscarded=true: Chrome tab discard)' : ' (renderer process killed by OS / Chrome)'}`,
        true
      );
    } else {
      diag(`[startup] app launched (wasDiscarded=${wasDiscarded})`, true);
    }
  } catch (_) {}

  const mem = () => {
    try {
      const m = (performance as any).memory;
      return m ? ` heap=${Math.round(m.usedJSHeapSize / 1048576)}MB` : '';
    } catch (_) {
      return '';
    }
  };

  document.addEventListener('visibilitychange', () => diag(`[lifecycle] visibility=${document.visibilityState}${mem()}`, true));
  document.addEventListener('freeze', () => diag('[lifecycle] FREEZE (page frozen by Chrome)', true));
  document.addEventListener('resume', () => diag('[lifecycle] resume after freeze', true));
  window.addEventListener('pagehide', (e) => diag(`[lifecycle] pagehide persisted=${(e as PageTransitionEvent).persisted}`, true));
  window.addEventListener('online', () => diag('[net] online'));
  window.addEventListener('offline', () => diag('[net] offline'));
}
