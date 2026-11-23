export type StreamQualityPreference = 'auto' | 'low' | 'medium' | 'high' | 'original';
export type ResolvedStreamQuality = 'low' | 'medium' | 'high' | 'original';
export type StreamFormat = 'ogg' | 'm4a' | 'mp3';

export const STREAM_QUALITY_PREF_KEY = 'jellyfy_stream_quality_pref';

const VALID_PREFS = new Set<StreamQualityPreference>(['auto', 'low', 'medium', 'high', 'original']);

export function parseStreamQualityPref(raw: unknown): StreamQualityPreference {
  if (typeof raw === 'string' && VALID_PREFS.has(raw as StreamQualityPreference)) {
    return raw as StreamQualityPreference;
  }
  return 'auto';
}

export function getSavedStreamQualityPref(): StreamQualityPreference {
  if (typeof localStorage === 'undefined') return 'auto';
  try {
    return parseStreamQualityPref(localStorage.getItem(STREAM_QUALITY_PREF_KEY));
  } catch {
    return 'auto';
  }
}

export function saveStreamQualityPref(pref: StreamQualityPreference): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STREAM_QUALITY_PREF_KEY, pref);
  } catch {}
}

let cachedFormat: StreamFormat | null = null;
export function getPreferredStreamFormat(): StreamFormat {
  if (cachedFormat) return cachedFormat;
  if (typeof document === 'undefined') return 'ogg';
  try {
    const probe = document.createElement('audio');
    if (probe.canPlayType('audio/ogg; codecs="opus"') !== '') {
      cachedFormat = 'ogg';
      return cachedFormat;
    }
    if (probe.canPlayType('audio/mp4; codecs="opus"') !== '') {
      cachedFormat = 'm4a';
      return cachedFormat;
    }
  } catch {}
  cachedFormat = 'mp3';
  return cachedFormat;
}

export function isLocalLanHost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = (window.location.hostname || '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '[::1]' || host.endsWith('.local')) {
    return true;
  }
  if (host.startsWith('127.') || host.startsWith('192.168.') || host.startsWith('10.')) {
    return true;
  }
  // Private RFC1918 172.16.0.0 - 172.31.255.255 (Tailscale CGNAT 100.64.0.0/10 is intentionally treated as remote)
  const m = host.match(/^172\.(\d+)\./);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

// EWMA real-world throughput estimator (handles VPN/Tailscale overlays accurately)
let ewmaKbps: number | null = null;
const EWMA_ALPHA = 0.35;

export function recordTransferSample(bytes: number, durationMs: number): void {
  if (!bytes || bytes < 16_384 || !durationMs || durationMs < 10 || durationMs > 120_000) {
    return;
  }
  const sampleKbps = Math.max(32, Math.min(100_000, (bytes * 8) / durationMs));
  ewmaKbps = ewmaKbps === null ? sampleKbps : ewmaKbps * (1 - EWMA_ALPHA) + sampleKbps * EWMA_ALPHA;
}

export function getMeasuredThroughputKbps(): number | null {
  return ewmaKbps !== null ? Math.round(ewmaKbps) : null;
}

// Temporary step-down state when active network encounters repeated stalls
let stallStepDown = 0;
let lastStallAt = 0;
const STALL_DECAY_MS = 3 * 60_000;

export function getStallStepDown(): number {
  if (stallStepDown > 0 && Date.now() - lastStallAt > STALL_DECAY_MS) {
    stallStepDown = 0;
  }
  return stallStepDown;
}

export function reportStreamStall(): number {
  if (Date.now() - lastStallAt > STALL_DECAY_MS) {
    stallStepDown = 0;
  }
  stallStepDown = Math.min(2, stallStepDown + 1);
  lastStallAt = Date.now();
  return stallStepDown;
}

export function resetStreamStalls(): void {
  stallStepDown = 0;
  lastStallAt = 0;
}

export function getNetworkConnectionInfo(): {
  saveData: boolean;
  effectiveType: string | null;
  type: string | null;
  downlinkMbps: number | null;
} {
  if (typeof navigator === 'undefined') {
    return { saveData: false, effectiveType: null, type: null, downlinkMbps: null };
  }
  const conn = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
  if (!conn) {
    return { saveData: false, effectiveType: null, type: null, downlinkMbps: null };
  }
  return {
    saveData: Boolean(conn.saveData),
    effectiveType: typeof conn.effectiveType === 'string' ? conn.effectiveType : null,
    type: typeof conn.type === 'string' ? conn.type : null,
    downlinkMbps: typeof conn.downlink === 'number' && isFinite(conn.downlink) ? conn.downlink : null,
  };
}

export function shouldAvoidBackgroundOfflineSync(): boolean {
  const { saveData, effectiveType } = getNetworkConnectionInfo();
  return saveData || effectiveType === '2g' || effectiveType === 'slow-2g';
}

let remoteStreamPriorityCheck: (() => boolean) | null = null;

export function registerRemoteStreamPriorityCheck(fn: () => boolean): void {
  remoteStreamPriorityCheck = fn;
}

export function isRemoteStreamPriorityActive(): boolean {
  try {
    return remoteStreamPriorityCheck ? remoteStreamPriorityCheck() : false;
  } catch {
    return false;
  }
}

const QUALITY_ORDER: ResolvedStreamQuality[] = ['original', 'high', 'medium', 'low'];

export function resolveEffectiveStreamQuality(pref: StreamQualityPreference): ResolvedStreamQuality {
  if (pref !== 'auto') {
    return pref;
  }

  const { saveData, effectiveType } = getNetworkConnectionInfo();
  const measured = getMeasuredThroughputKbps();

  let base: ResolvedStreamQuality;
  if (
    saveData ||
    effectiveType === 'slow-2g' ||
    effectiveType === '2g' ||
    (measured !== null && measured < 350)
  ) {
    base = 'low';
  } else if (effectiveType === '3g' || (measured !== null && measured < 900)) {
    base = 'medium';
  } else if (!isLocalLanHost()) {
    // Variant A default for remote connections (Tailscale / LTE / remote Wi-Fi): transparent Opus 160k
    base = 'high';
  } else {
    base = 'original';
  }

  const stepDown = getStallStepDown();
  if (stepDown <= 0) return base;

  const baseIdx = QUALITY_ORDER.indexOf(base);
  const nextIdx = Math.min(QUALITY_ORDER.length - 1, baseIdx + stepDown);
  return QUALITY_ORDER[nextIdx];
}

const trackStreamVersionMap = new Map<number, number>();

export function bumpTrackStreamVersion(trackId: number): void {
  if (trackId > 0) {
    trackStreamVersionMap.set(trackId, Date.now());
  }
}

export function buildStreamUrl(
  trackId: number,
  quality: ResolvedStreamQuality,
  format: StreamFormat,
  options?: { reconnectTs?: number; remoteStripId3?: boolean }
): string {
  let base: string;
  if (quality === 'original') {
    const strip = options?.remoteStripId3 !== false && !isLocalLanHost();
    base = strip ? `/api/stream/${trackId}?stripId3=1` : `/api/stream/${trackId}`;
  } else {
    base = `/api/stream/${trackId}?q=${quality}&fmt=${format}`;
  }

  const ver = trackStreamVersionMap.get(trackId);
  if (ver) {
    const sep = base.includes('?') ? '&' : '?';
    base = `${base}${sep}v=${ver}`;
  }

  if (options?.reconnectTs) {
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}r=${options.reconnectTs}`;
  }
  return base;
}

export function getPrefetchProfile(quality: ResolvedStreamQuality): {
  lookaheadTracks: number;
  minBufferAheadSec: number;
  allowBackgroundOfflineSync: boolean;
} {
  switch (quality) {
    case 'low':
      return { lookaheadTracks: 1, minBufferAheadSec: 18, allowBackgroundOfflineSync: false };
    case 'medium':
      return { lookaheadTracks: 2, minBufferAheadSec: 15, allowBackgroundOfflineSync: true };
    case 'high':
      return { lookaheadTracks: 3, minBufferAheadSec: 12, allowBackgroundOfflineSync: true };
    case 'original':
    default:
      return { lookaheadTracks: 3, minBufferAheadSec: 10, allowBackgroundOfflineSync: true };
  }
}

export function formatQualityLabel(
  quality: 'offline' | 'cache' | ResolvedStreamQuality | null,
  format: StreamFormat = getPreferredStreamFormat(),
  lang: 'ru' | 'en' = 'ru'
): string {
  if (!quality) return '';
  if (quality === 'offline') return lang === 'en' ? 'Offline' : 'Оффлайн';
  if (quality === 'cache') return lang === 'en' ? 'Cached' : 'Кеш';
  if (quality === 'original') return '320k MP3';
  const codec = format === 'mp3' ? 'MP3' : 'Opus';
  if (format === 'mp3') {
    if (quality === 'high') return `${codec} 256k`;
    if (quality === 'medium') return `${codec} 192k`;
    return `${codec} 128k`;
  }
  if (quality === 'high') return `${codec} 160k`;
  if (quality === 'medium') return `${codec} 128k`;
  return `${codec} 96k`;
}

export function getNetworkSummary(
  pref: StreamQualityPreference,
  lang: 'ru' | 'en' = 'ru'
): {
  isLocal: boolean;
  effectiveQuality: ResolvedStreamQuality;
  format: StreamFormat;
  measuredKbps: number | null;
  effectiveType: string | null;
  saveData: boolean;
  label: string;
} {
  const isLocal = isLocalLanHost();
  const effectiveQuality = resolveEffectiveStreamQuality(pref);
  const format = getPreferredStreamFormat();
  const measuredKbps = getMeasuredThroughputKbps();
  const conn = getNetworkConnectionInfo();

  const envLabel = isLocal
    ? (lang === 'en' ? 'Local LAN' : 'Локальная сеть')
    : (lang === 'en' ? 'Remote' : 'Удалённо');
  const speedPart = measuredKbps
    ? ` • ${(measuredKbps / 1000).toFixed(1)} ${lang === 'en' ? 'Mbps' : 'Мбит/с'}`
    : (conn.effectiveType ? ` • ${conn.effectiveType.toUpperCase()}` : '');
  const qualityPart = formatQualityLabel(effectiveQuality, format, lang);

  return {
    isLocal,
    effectiveQuality,
    format,
    measuredKbps,
    effectiveType: conn.effectiveType,
    saveData: conn.saveData,
    label: `${envLabel}${speedPart} → ${qualityPart}`,
  };
}
