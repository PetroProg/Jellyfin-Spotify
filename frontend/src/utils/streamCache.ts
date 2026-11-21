import { Track } from '../types';
import {
  ResolvedStreamQuality,
  StreamFormat,
  buildStreamUrl,
  recordTransferSample,
} from './networkQuality';

export const STREAM_CACHE_NAME = 'jellyfy-smart-stream-cache-v1';
const OFFLINE_AUDIO_CACHE_NAME = 'jellyfin-spotify-audio-cache-v3';
const STREAM_CACHE_INDEX_KEY = 'jellyfy_stream_cache_index_v1';
const STREAM_CACHE_LIMIT_MB_KEY = 'jellyfy_stream_cache_limit_mb';

export type StreamCacheLimitMb = 0 | 100 | 200 | 500;
const VALID_LIMITS = new Set<number>([0, 100, 200, 500]);

export interface StreamCacheEntry {
  url: string;
  trackId: number;
  quality: ResolvedStreamQuality;
  format: StreamFormat;
  sizeBytes: number;
  lastUsedAt: number;
}

const streamBlobUrls = new Map<number, { blobUrl: string; quality: ResolvedStreamQuality }>();
let activeStreamPlayingTrackId: number | null = null;
let cachedIndex: StreamCacheEntry[] | null = null;

export function setStreamCachePlayingTrackId(trackId: number | null): void {
  activeStreamPlayingTrackId = trackId;
}

function loadIndex(): StreamCacheEntry[] {
  if (cachedIndex) return cachedIndex;
  if (typeof localStorage === 'undefined') {
    cachedIndex = [];
    return cachedIndex;
  }
  try {
    const raw = localStorage.getItem(STREAM_CACHE_INDEX_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        cachedIndex = parsed.filter(
          (e) => e && typeof e.url === 'string' && Number(e.trackId) > 0
        );
        return cachedIndex;
      }
    }
  } catch {}
  cachedIndex = [];
  return cachedIndex;
}

function saveIndex(entries: StreamCacheEntry[]): void {
  cachedIndex = entries;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STREAM_CACHE_INDEX_KEY, JSON.stringify(entries));
  } catch {}
}

export function getStreamCacheLimitMb(): StreamCacheLimitMb {
  if (typeof localStorage === 'undefined') return 200;
  try {
    const raw = localStorage.getItem(STREAM_CACHE_LIMIT_MB_KEY);
    if (raw !== null) {
      const num = Number(raw);
      if (VALID_LIMITS.has(num)) return num as StreamCacheLimitMb;
    }
  } catch {}
  return 200;
}

export async function setStreamCacheLimitMb(limitMb: StreamCacheLimitMb): Promise<void> {
  const safeLimit: StreamCacheLimitMb = VALID_LIMITS.has(limitMb) ? limitMb : 200;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STREAM_CACHE_LIMIT_MB_KEY, String(safeLimit));
    } catch {}
  }
  if (safeLimit === 0) {
    await clearStreamCache();
  } else {
    await trimStreamCacheToLimit(safeLimit);
  }
}

export function hasTrackInStreamCache(trackId: number): boolean {
  if (!trackId || trackId <= 0 || typeof window === 'undefined') return false;
  if (streamBlobUrls.has(trackId)) return true;
  if (getStreamCacheLimitMb() === 0) return false;
  const idx = loadIndex();
  return idx.some((e) => e.trackId === trackId);
}

export function getSynchronousStreamBlob(
  trackId: number
): { blobUrl: string; quality: ResolvedStreamQuality } | null {
  if (!trackId || trackId <= 0) return null;
  return streamBlobUrls.get(trackId) || null;
}

function touchEntryInIndex(trackId: number, url?: string): void {
  const entries = loadIndex();
  let changed = false;
  const now = Date.now();
  for (const entry of entries) {
    if (entry.trackId === trackId && (!url || entry.url === url)) {
      entry.lastUsedAt = now;
      changed = true;
    }
  }
  if (changed) {
    saveIndex(entries);
  }
}

export async function getStreamCachedTrackUrl(
  trackId: number,
  preferredQuality?: ResolvedStreamQuality
): Promise<{ blobUrl: string; quality: ResolvedStreamQuality } | null> {
  if (typeof window === 'undefined' || !('caches' in window) || !trackId || trackId <= 0) {
    return null;
  }

  const existingRam = streamBlobUrls.get(trackId);
  if (existingRam) {
    touchEntryInIndex(trackId);
    return existingRam;
  }

  if (getStreamCacheLimitMb() === 0) return null;

  const entries = loadIndex().filter((e) => e.trackId === trackId);
  if (entries.length === 0) return null;

  // Prefer entry matching current target quality, otherwise most recently used
  entries.sort((a, b) => {
    if (preferredQuality) {
      const aMatch = a.quality === preferredQuality ? 1 : 0;
      const bMatch = b.quality === preferredQuality ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
    }
    return b.lastUsedAt - a.lastUsedAt;
  });

  try {
    const cache = await caches.open(STREAM_CACHE_NAME);
    for (const entry of entries) {
      const match = await cache.match(entry.url);
      if (!match) {
        saveIndex(loadIndex().filter((e) => e.url !== entry.url));
        continue;
      }

      const blob = await match.blob();
      if (!blob || blob.size <= 1024) {
        await cache.delete(entry.url).catch(() => {});
        saveIndex(loadIndex().filter((e) => e.url !== entry.url));
        continue;
      }

      if (streamBlobUrls.size >= 20) {
        for (const key of streamBlobUrls.keys()) {
          if (key !== activeStreamPlayingTrackId && key !== trackId) {
            const old = streamBlobUrls.get(key);
            if (old) {
              try {
                URL.revokeObjectURL(old.blobUrl);
              } catch {}
            }
            streamBlobUrls.delete(key);
            break;
          }
        }
      }

      const blobUrl = URL.createObjectURL(blob);
      const result = { blobUrl, quality: entry.quality };
      streamBlobUrls.set(trackId, result);
      touchEntryInIndex(trackId, entry.url);
      return result;
    }
  } catch (err) {
    console.warn('[StreamCache] Lookup error:', err);
  }
  return null;
}

async function trimStreamCacheToLimit(limitMbOverride?: StreamCacheLimitMb): Promise<void> {
  if (typeof window === 'undefined' || !('caches' in window)) return;
  const limitMb = limitMbOverride ?? getStreamCacheLimitMb();
  const maxBytes = limitMb * 1024 * 1024;
  const entries = [...loadIndex()];
  let totalBytes = entries.reduce((sum, e) => sum + (e.sizeBytes || 0), 0);

  if (totalBytes <= maxBytes) return;

  // Sort oldest-used first; avoid evicting the currently playing track
  entries.sort((a, b) => a.lastUsedAt - b.lastUsedAt);

  try {
    const cache = await caches.open(STREAM_CACHE_NAME);
    const keep: StreamCacheEntry[] = [];

    for (const entry of entries) {
      if (totalBytes > maxBytes && entry.trackId !== activeStreamPlayingTrackId) {
        await cache.delete(entry.url).catch(() => {});
        const ram = streamBlobUrls.get(entry.trackId);
        if (ram) {
          try {
            URL.revokeObjectURL(ram.blobUrl);
          } catch {}
          streamBlobUrls.delete(entry.trackId);
        }
        totalBytes -= entry.sizeBytes || 0;
      } else {
        keep.push(entry);
      }
    }
    saveIndex(keep);
  } catch (err) {
    console.warn('[StreamCache] Trim error:', err);
  }
}

export async function prefetchTrackToStreamCache(
  track: Track,
  quality: ResolvedStreamQuality,
  format: StreamFormat,
  externalSignal?: AbortSignal,
  timeoutMs = 45_000
): Promise<boolean> {
  if (typeof window === 'undefined' || !('caches' in window)) return false;
  if (!track || !track.id || track.id <= 0) return false;
  if (track.is_downloaded === false || track.is_downloaded === 0) return false;
  if (getStreamCacheLimitMb() === 0) return false;
  if (externalSignal?.aborted) return false;

  const targetUrl = buildStreamUrl(track.id, quality, format);

  try {
    // Skip if already present in permanent offline storage
    const offlineCache = await caches.open(OFFLINE_AUDIO_CACHE_NAME);
    const offlineMatch = await offlineCache.match(`/api/stream/${track.id}`);
    if (offlineMatch) {
      return true;
    }

    const streamCache = await caches.open(STREAM_CACHE_NAME);
    const existing = await streamCache.match(targetUrl);
    if (existing) {
      const idx = loadIndex();
      if (!idx.some((e) => e.url === targetUrl)) {
        const sizeBytes = Number(existing.headers.get('content-length') || '0') || 3_500_000;
        saveIndex([
          ...idx.filter((e) => e.trackId !== track.id),
          {
            url: targetUrl,
            trackId: track.id,
            quality,
            format,
            sizeBytes,
            lastUsedAt: Date.now(),
          },
        ]);
      } else {
        touchEntryInIndex(track.id, targetUrl);
      }
      return true;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => {
      clearTimeout(timer);
      controller.abort();
    };
    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const startedAt = performance.now();
      const res = await fetch(targetUrl, {
        signal: controller.signal,
        headers: { 'Cache-Control': 'no-cache' },
      });

      if (!res.ok || res.status !== 200 || res.headers.get('x-stream-partial') === '1') {
        return false;
      }

      const blob = await res.blob();
      const elapsedMs = performance.now() - startedAt;

      if (!blob || blob.size <= 1024) {
        return false;
      }

      recordTransferSample(blob.size, elapsedMs);

      // Remove any previous quality variant of the same track so we keep 1 entry per trackId
      const currentEntries = loadIndex();
      for (const oldEntry of currentEntries) {
        if (oldEntry.trackId === track.id && oldEntry.url !== targetUrl) {
          await streamCache.delete(oldEntry.url).catch(() => {});
        }
      }

      await streamCache.put(
        targetUrl,
        new Response(blob, {
          status: 200,
          statusText: 'OK',
          headers: res.headers,
        })
      );

      const ram = streamBlobUrls.get(track.id);
      if (ram && ram.quality !== quality) {
        try {
          URL.revokeObjectURL(ram.blobUrl);
        } catch {}
        streamBlobUrls.delete(track.id);
      }

      const nextIndex = [
        ...currentEntries.filter((e) => e.trackId !== track.id),
        {
          url: targetUrl,
          trackId: track.id,
          quality,
          format,
          sizeBytes: blob.size,
          lastUsedAt: Date.now(),
        },
      ];
      saveIndex(nextIndex);
      await trimStreamCacheToLimit();

      // Warm album cover non-blockingly into image cache
      if (track.cover_url && !track.cover_url.startsWith('data:')) {
        caches
          .open('jellyfy-images-cache')
          .then((imgCache) =>
            imgCache.match(track.cover_url!).then((m) => {
              if (!m) {
                fetch(track.cover_url!, { signal: AbortSignal.timeout(5000) })
                  .then((cRes) => {
                    if (cRes.ok) imgCache.put(track.cover_url!, cRes);
                  })
                  .catch(() => {});
              }
            })
          )
          .catch(() => {});
      }

      return true;
    } finally {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      console.warn(`[StreamCache] Prefetch failed for #${track.id}:`, err?.message || err);
    }
    return false;
  }
}

export async function evictTrackFromStreamCache(trackId: number): Promise<void> {
  if (!trackId || typeof window === 'undefined') return;
  const entries = loadIndex();
  const toDelete = entries.filter((e) => e.trackId === trackId);

  try {
    if ('caches' in window && toDelete.length > 0) {
      const cache = await caches.open(STREAM_CACHE_NAME);
      for (const entry of toDelete) {
        await cache.delete(entry.url).catch(() => {});
      }
    }
  } catch {}

  const ram = streamBlobUrls.get(trackId);
  if (ram) {
    try {
      URL.revokeObjectURL(ram.blobUrl);
    } catch {}
    streamBlobUrls.delete(trackId);
  }

  if (toDelete.length > 0) {
    saveIndex(entries.filter((e) => e.trackId !== trackId));
  }
}

export async function clearStreamCache(): Promise<void> {
  if (typeof window !== 'undefined' && 'caches' in window) {
    await caches.delete(STREAM_CACHE_NAME).catch(() => {});
  }
  for (const item of streamBlobUrls.values()) {
    try {
      URL.revokeObjectURL(item.blobUrl);
    } catch {}
  }
  streamBlobUrls.clear();
  saveIndex([]);
}

export function getStreamCacheStats(): {
  trackCount: number;
  sizeBytes: number;
  limitMb: StreamCacheLimitMb;
} {
  const entries = loadIndex();
  const sizeBytes = entries.reduce((sum, e) => sum + (e.sizeBytes || 0), 0);
  return {
    trackCount: entries.length,
    sizeBytes,
    limitMb: getStreamCacheLimitMb(),
  };
}
