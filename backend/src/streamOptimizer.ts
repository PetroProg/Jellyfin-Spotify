import fs from 'fs';
import path from 'path';

export interface TrackStreamMeta {
  trackId: number;
  mtimeMs: number;
  size: number;
  audioOffset: number;
  cachedAt: number;
}

const MAX_META_CACHE_ENTRIES = 500;
const META_CACHE_TTL_MS = 15_000;
const streamMetaCache = new Map<string, TrackStreamMeta>();

/**
 * Computes the byte offset where actual MPEG audio frames begin in an MP3 file,
 * safely skipping embedded ID3v2 headers (often 400KB-1.6MB of cover art).
 * Returns 0 if no valid ID3v2 header or MPEG sync word is found at the offset.
 */
export async function getMp3AudioOffset(filePath: string, fileSize: number): Promise<number> {
  if (fileSize <= 2048 || path.extname(filePath).toLowerCase() !== '.mp3') {
    return 0;
  }

  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const hdr = Buffer.allocUnsafe(10);
    const { bytesRead } = await fh.read(hdr, 0, 10, 0);
    if (bytesRead < 10) return 0;

    // Must start with "ID3" and valid ID3v2 version/revision
    if (hdr[0] !== 0x49 || hdr[1] !== 0x44 || hdr[2] !== 0x33) {
      return 0;
    }
    if (hdr[3] === 0xff || hdr[3] > 4 || hdr[4] === 0xff) {
      return 0;
    }

    // ID3v2 size is a 28-bit synchsafe integer (MSB of each byte must be 0)
    if (
      (hdr[6] & 0x80) !== 0 ||
      (hdr[7] & 0x80) !== 0 ||
      (hdr[8] & 0x80) !== 0 ||
      (hdr[9] & 0x80) !== 0
    ) {
      return 0;
    }

    const synchsafeSize =
      ((hdr[6] & 0x7f) << 21) |
      ((hdr[7] & 0x7f) << 14) |
      ((hdr[8] & 0x7f) << 7) |
      (hdr[9] & 0x7f);

    const hasFooter = (hdr[5] & 0x10) !== 0;
    const offset = 10 + synchsafeSize + (hasFooter ? 10 : 0);

    if (offset <= 10 || offset >= fileSize - 1024) {
      return 0;
    }

    const syncBuf = Buffer.allocUnsafe(2);
    const syncRead = await fh.read(syncBuf, 0, 2, offset);
    if (syncRead.bytesRead < 2) return 0;

    // Verify MPEG audio frame sync (11 set bits: 0xFF followed by 0b111xxxxx)
    if (syncBuf[0] === 0xff && (syncBuf[1] & 0xe0) === 0xe0) {
      return offset;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fh) {
      await fh.close().catch(() => {});
    }
  }
}

/**
 * Returns cached ID3v2 audio offset for a track, keyed by trackId + mtimeMs + size.
 * Uses a bounded Map (LRU by insertion-refresh) so repeat HTTP Range requests incur zero disk header reads.
 */
export async function getCachedMp3Offset(
  trackId: number,
  filePath: string,
  stat: fs.Stats
): Promise<number> {
  const key = `${trackId}:${Math.floor(stat.mtimeMs)}:${stat.size}`;
  const now = Date.now();
  const cached = streamMetaCache.get(key);

  if (cached && now - cached.cachedAt <= META_CACHE_TTL_MS) {
    // Refresh LRU order
    streamMetaCache.delete(key);
    streamMetaCache.set(key, cached);
    return cached.audioOffset;
  }

  const audioOffset = await getMp3AudioOffset(filePath, stat.size);

  if (streamMetaCache.size >= MAX_META_CACHE_ENTRIES) {
    // Evict oldest entries first
    const toRemove = Math.max(1, Math.floor(MAX_META_CACHE_ENTRIES * 0.1));
    let removed = 0;
    for (const k of streamMetaCache.keys()) {
      streamMetaCache.delete(k);
      if (++removed >= toRemove) break;
    }
  }

  streamMetaCache.set(key, {
    trackId,
    mtimeMs: Math.floor(stat.mtimeMs),
    size: stat.size,
    audioOffset,
    cachedAt: now,
  });

  return audioOffset;
}

/**
 * Invalidates any cached metadata for a track when its underlying file is replaced or upgraded.
 */
export function invalidateTrackStreamMeta(trackId: number): void {
  const prefix = `${trackId}:`;
  for (const key of streamMetaCache.keys()) {
    if (key.startsWith(prefix)) {
      streamMetaCache.delete(key);
    }
  }
}
