import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';

export type StreamQuality = 'original' | 'high' | 'medium' | 'low';
export type StreamFormat = 'ogg' | 'm4a' | 'mp3';

const ALLOWED_QUALITIES = new Set<StreamQuality>(['original', 'high', 'medium', 'low']);
const ALLOWED_FORMATS = new Set<StreamFormat>(['ogg', 'm4a', 'mp3']);

const OPUS_BITRATES: Record<Exclude<StreamQuality, 'original'>, string> = {
  high: '160k',
  medium: '128k',
  low: '96k',
};

const MP3_BITRATES: Record<Exclude<StreamQuality, 'original'>, string> = {
  high: '256k',
  medium: '192k',
  low: '128k',
};

const FORMAT_CONTENT_TYPES: Record<StreamFormat, string> = {
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
};

const FFMPEG_TIMEOUT_MS = 60_000;
const MAX_LIVE_CONCURRENT = 2;
const MAX_BG_CONCURRENT = 1;
const MAX_PREPARE_QUEUE = 3;

const dbDir = path.dirname(process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db'));
export const TRANSCODE_CACHE_DIR = path.resolve(
  process.env.TRANSCODE_CACHE_DIR || path.join(dbDir, 'transcode-cache')
);
const MAX_CACHE_BYTES =
  Math.max(64, Number(process.env.TRANSCODE_CACHE_MAX_MB) || 1024) * 1024 * 1024;

export function parseStreamQuality(raw: unknown): StreamQuality {
  if (typeof raw === 'string' && ALLOWED_QUALITIES.has(raw as StreamQuality)) {
    return raw as StreamQuality;
  }
  return 'original';
}

export function parseStreamFormat(raw: unknown): StreamFormat {
  if (typeof raw === 'string' && ALLOWED_FORMATS.has(raw as StreamFormat)) {
    return raw as StreamFormat;
  }
  return 'ogg';
}

export function getTranscodeContentType(format: StreamFormat): string {
  return FORMAT_CONTENT_TYPES[format] || 'audio/ogg';
}

function isInsideCacheDir(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return resolved.startsWith(TRANSCODE_CACHE_DIR + path.sep) && resolved !== TRANSCODE_CACHE_DIR;
}

function ensureCacheDir(): void {
  try {
    if (!fs.existsSync(TRANSCODE_CACHE_DIR)) {
      fs.mkdirSync(TRANSCODE_CACHE_DIR, { recursive: true });
    }
  } catch (err: any) {
    console.warn('[Transcoder] Failed to create cache dir:', err?.message);
  }
}

// Initialize directory & remove orphaned tmp files from prior crashes
ensureCacheDir();
try {
  for (const name of fs.readdirSync(TRANSCODE_CACHE_DIR)) {
    if (name.includes('.tmp.')) {
      const p = path.join(TRANSCODE_CACHE_DIR, name);
      if (isInsideCacheDir(p)) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
    }
  }
} catch (_) {}

function buildCacheKey(
  trackId: number,
  sourceMtimeMs: number,
  quality: Exclude<StreamQuality, 'original'>,
  format: StreamFormat
): string {
  const safeTrackId = Math.max(1, Math.floor(Number(trackId) || 0));
  const safeMtime = Math.max(0, Math.floor(Number(sourceMtimeMs) || 0));
  return `${safeTrackId}_${quality}_${format}_${safeMtime}`;
}

function buildCachePath(cacheKey: string, format: StreamFormat): string {
  const filename = `${cacheKey}.${format}`;
  const full = path.resolve(TRANSCODE_CACHE_DIR, filename);
  if (!isInsideCacheDir(full)) {
    throw new Error('Invalid transcode cache path');
  }
  return full;
}

function buildFfmpegArgs(
  sourcePath: string,
  quality: Exclude<StreamQuality, 'original'>,
  format: StreamFormat,
  outputTarget: string
): string[] {
  const baseArgs = ['-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-vn', '-map', '0:a:0'];

  if (format === 'ogg') {
    return [
      ...baseArgs,
      '-c:a', 'libopus',
      '-b:a', OPUS_BITRATES[quality],
      '-vbr', 'on',
      '-compression_level', '5',
      '-application', 'audio',
      '-cutoff', '20000',
      '-f', 'ogg',
      outputTarget,
    ];
  }

  if (format === 'm4a') {
    return [
      ...baseArgs,
      '-c:a', 'libopus',
      '-b:a', OPUS_BITRATES[quality],
      '-vbr', 'on',
      '-compression_level', '5',
      '-application', 'audio',
      '-cutoff', '20000',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      outputTarget,
    ];
  }

  return [
    ...baseArgs,
    '-c:a', 'libmp3lame',
    '-b:a', MP3_BITRATES[quality],
    '-compression_level', '4',
    '-id3v2_version', '0',
    '-f', 'mp3',
    outputTarget,
  ];
}

// Throttled LRU atime updates
const lastTouchAt = new Map<string, number>();
export function touchCacheFile(filePath: string): void {
  const now = Date.now();
  const prev = lastTouchAt.get(filePath) || 0;
  if (now - prev < 60_000) return;
  if (lastTouchAt.size > 1000) {
    lastTouchAt.clear();
  }
  lastTouchAt.set(filePath, now);
  const d = new Date(now);
  fs.promises.utimes(filePath, d, d).catch(() => {});
}

let lastPruneMs = 0;
let isPruning = false;
export async function pruneTranscodeCacheIfNeeded(force = false): Promise<void> {
  const now = Date.now();
  if (isPruning) return;
  if (!force && now - lastPruneMs < 30_000) return;

  isPruning = true;
  lastPruneMs = now;
  try {
    ensureCacheDir();
    const names = await fs.promises.readdir(TRANSCODE_CACHE_DIR);
    const entries: Array<{ fullPath: string; size: number; lruMs: number }> = [];
    let totalBytes = 0;

    for (const name of names) {
      const fullPath = path.join(TRANSCODE_CACHE_DIR, name);
      if (!isInsideCacheDir(fullPath)) continue;
      try {
        const st = await fs.promises.stat(fullPath);
        if (!st.isFile()) continue;
        // Clean up orphaned tmp files older than 5 minutes
        if (name.includes('.tmp.')) {
          if (now - st.mtimeMs > 5 * 60_000) {
            await fs.promises.unlink(fullPath).catch(() => {});
          }
          continue;
        }
        totalBytes += st.size;
        entries.push({
          fullPath,
          size: st.size,
          lruMs: Math.max(st.atimeMs || 0, st.mtimeMs || 0),
        });
      } catch (_) {}
    }

    if (totalBytes <= MAX_CACHE_BYTES) return;

    const targetBytes = Math.floor(MAX_CACHE_BYTES * 0.85);
    entries.sort((a, b) => a.lruMs - b.lruMs);

    for (const entry of entries) {
      if (totalBytes <= targetBytes) break;
      try {
        await fs.promises.unlink(entry.fullPath);
        totalBytes -= entry.size;
        lastTouchAt.delete(entry.fullPath);
      } catch (_) {}
    }
  } catch (err: any) {
    console.warn('[Transcoder] Prune error:', err?.message);
  } finally {
    isPruning = false;
  }
}

const periodicPruneTimer = setInterval(() => {
  pruneTranscodeCacheIfNeeded(true).catch(() => {});
}, 10 * 60_000);
if (periodicPruneTimer.unref) periodicPruneTimer.unref();

export async function invalidateTranscodeCacheForTrack(trackId: number): Promise<void> {
  if (!trackId || trackId <= 0) return;
  try {
    ensureCacheDir();
    const prefix = `${trackId}_`;
    const names = await fs.promises.readdir(TRANSCODE_CACHE_DIR);
    for (const name of names) {
      if (name.startsWith(prefix)) {
        const full = path.join(TRANSCODE_CACHE_DIR, name);
        if (isInsideCacheDir(full)) {
          await fs.promises.unlink(full).catch(() => {});
          lastTouchAt.delete(full);
        }
      }
    }
  } catch (_) {}
}

export async function getCachedTranscodePath(
  trackId: number,
  sourceMtimeMs: number,
  quality: StreamQuality,
  format: StreamFormat
): Promise<{ path: string; stat: fs.Stats } | null> {
  if (quality === 'original') return null;
  try {
    const cacheKey = buildCacheKey(trackId, sourceMtimeMs, quality, format);
    const cachePath = buildCachePath(cacheKey, format);
    const stat = await fs.promises.stat(cachePath);
    if (stat.isFile() && stat.size > 512) {
      return { path: cachePath, stat };
    }
  } catch (_) {}
  return null;
}

interface InFlightJob {
  promise: Promise<string | null>;
  priority: 'live' | 'bg';
  trackId: number;
  killIfAbandoned?: () => void;
}

interface PrepareQueueItem {
  trackId: number;
  sourcePath: string;
  sourceMtimeMs: number;
  quality: Exclude<StreamQuality, 'original'>;
  format: StreamFormat;
}

const inFlightJobs = new Map<string, InFlightJob>();
let activeLiveTranscodes = 0;
let activeBgTranscodes = 0;
let latestLiveKey: string | null = null;
let prepareQueue: PrepareQueueItem[] = [];
let isPreparePumpRunning = false;

export function canStartLiveTranscode(): boolean {
  return activeLiveTranscodes < MAX_LIVE_CONCURRENT;
}

export function getInFlightTranscodeJob(
  trackId: number,
  sourceMtimeMs: number,
  quality: StreamQuality,
  format: StreamFormat
): { priority: 'live' | 'bg'; promise: Promise<string | null> } | null {
  if (quality === 'original') return null;
  const key = buildCacheKey(trackId, sourceMtimeMs, quality, format);
  const job = inFlightJobs.get(key);
  if (!job) return null;
  return { priority: job.priority, promise: job.promise };
}

function killFfmpegGracefully(proc: ChildProcess): void {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  try {
    proc.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      try {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      } catch (_) {}
    }, 2000);
    if (killTimer.unref) killTimer.unref();
  } catch (_) {}
}

function runFfmpegToFile(
  cacheKey: string,
  trackId: number,
  sourcePath: string,
  quality: Exclude<StreamQuality, 'original'>,
  format: StreamFormat,
  priority: 'live' | 'bg'
): Promise<string | null> {
  ensureCacheDir();
  const finalPath = buildCachePath(cacheKey, format);
  const tmpPath = path.resolve(
    TRANSCODE_CACHE_DIR,
    `${cacheKey}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.${format}`
  );
  if (!isInsideCacheDir(tmpPath)) {
    return Promise.resolve(null);
  }

  if (priority === 'live') activeLiveTranscodes++;
  else activeBgTranscodes++;

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = async (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (priority === 'live') activeLiveTranscodes = Math.max(0, activeLiveTranscodes - 1);
      else activeBgTranscodes = Math.max(0, activeBgTranscodes - 1);

      if (ok) {
        try {
          const st = await fs.promises.stat(tmpPath);
          if (st.size > 512) {
            await fs.promises.rename(tmpPath, finalPath);
            pruneTranscodeCacheIfNeeded().catch(() => {});
            inFlightJobs.delete(cacheKey);
            resolve(finalPath);
            pumpPrepareQueue();
            return;
          }
        } catch (_) {}
      }

      await fs.promises.unlink(tmpPath).catch(() => {});
      inFlightJobs.delete(cacheKey);
      resolve(null);
      pumpPrepareQueue();
    };

    const niceVal = priority === 'live' ? '5' : '12';
    const ffmpegArgs = buildFfmpegArgs(sourcePath, quality, format, tmpPath);
    const proc = spawn('nice', ['-n', niceVal, 'ffmpeg', ...ffmpegArgs], {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderrTail = '';
    proc.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-400);
    });

    const timeoutTimer = setTimeout(() => {
      console.warn(`[Transcoder] ffmpeg timeout for #${trackId} (${quality}/${format})`);
      killFfmpegGracefully(proc);
      finish(false);
    }, FFMPEG_TIMEOUT_MS);

    proc.on('close', (code) => {
      if (code === 0) {
        finish(true);
      } else {
        if (stderrTail) {
          console.warn(`[Transcoder] ffmpeg exit ${code} for #${trackId}: ${stderrTail.trim()}`);
        }
        finish(false);
      }
    });

    proc.on('error', (err: any) => {
      console.warn(`[Transcoder] spawn error for #${trackId}:`, err?.message);
      finish(false);
    });
  });
}

export async function ensureTranscodedFile(
  trackId: number,
  sourcePath: string,
  sourceMtimeMs: number,
  quality: StreamQuality,
  format: StreamFormat,
  priority: 'live' | 'bg'
): Promise<string | null> {
  if (quality === 'original') return null;

  const existing = await getCachedTranscodePath(trackId, sourceMtimeMs, quality, format);
  if (existing) {
    touchCacheFile(existing.path);
    return existing.path;
  }

  const cacheKey = buildCacheKey(trackId, sourceMtimeMs, quality, format);
  const active = inFlightJobs.get(cacheKey);
  if (active) {
    return active.promise;
  }

  if (priority === 'live' && activeLiveTranscodes >= MAX_LIVE_CONCURRENT) {
    // Wait briefly or proceed if under safety ceiling
    return null;
  }

  const promise = runFfmpegToFile(cacheKey, trackId, sourcePath, quality, format, priority);
  inFlightJobs.set(cacheKey, { promise, priority, trackId });
  return promise;
}

/**
 * Streams live transcoded audio directly from ffmpeg stdout to the HTTP response
 * (~150ms TTFA) while simultaneously teeing bytes to a temp file for the disk LRU cache.
 */
export function streamAndCacheTranscode(
  trackId: number,
  sourcePath: string,
  sourceMtimeMs: number,
  quality: Exclude<StreamQuality, 'original'>,
  format: StreamFormat
): { stream: PassThrough; contentType: string; cleanup: () => void } {
  ensureCacheDir();
  const cacheKey = buildCacheKey(trackId, sourceMtimeMs, quality, format);
  const finalPath = buildCachePath(cacheKey, format);
  const tmpPath = path.resolve(
    TRANSCODE_CACHE_DIR,
    `${cacheKey}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.${format}`
  );

  latestLiveKey = cacheKey;

  // Terminate any disconnected older live transcodes that were superseded by this new track
  for (const [k, job] of inFlightJobs.entries()) {
    if (k !== cacheKey && job.priority === 'live' && job.killIfAbandoned) {
      job.killIfAbandoned();
    }
  }

  const passThrough = new PassThrough({ highWaterMark: 64 * 1024 });
  const contentType = getTranscodeContentType(format);

  if (!isInsideCacheDir(tmpPath) || activeLiveTranscodes >= MAX_LIVE_CONCURRENT) {
    // Safety fallback: reject gracefully on stream error so caller falls back to direct stream
    process.nextTick(() => {
      passThrough.destroy(new Error('Transcoder concurrency limit reached'));
    });
    return { stream: passThrough, contentType, cleanup: () => {} };
  }

  activeLiveTranscodes++;

  let clientClosed = false;
  let settled = false;
  let abortedBySupersede = false;
  let tmpWriteFailed = false;

  const tmpStream = fs.createWriteStream(tmpPath, { highWaterMark: 64 * 1024 });
  tmpStream.on('error', () => {
    tmpWriteFailed = true;
  });

  const ffmpegArgs = buildFfmpegArgs(sourcePath, quality, format, 'pipe:1');
  const proc = spawn('nice', ['-n', '5', 'ffmpeg', ...ffmpegArgs], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  proc.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-400);
  });

  let resolveShared!: (val: string | null) => void;
  const sharedPromise = new Promise<string | null>((res) => {
    resolveShared = res;
  });

  const finalize = async (ok: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    activeLiveTranscodes = Math.max(0, activeLiveTranscodes - 1);

    await new Promise<void>((res) => {
      if (tmpStream.closed || tmpStream.destroyed) return res();
      tmpStream.end(() => res());
    });

    if (ok && !abortedBySupersede && !tmpWriteFailed) {
      try {
        const st = await fs.promises.stat(tmpPath);
        if (st.size > 512) {
          await fs.promises.rename(tmpPath, finalPath);
          pruneTranscodeCacheIfNeeded().catch(() => {});
          inFlightJobs.delete(cacheKey);
          resolveShared(finalPath);
          pumpPrepareQueue();
          return;
        }
      } catch (_) {}
    }

    await fs.promises.unlink(tmpPath).catch(() => {});
    inFlightJobs.delete(cacheKey);
    resolveShared(null);
    pumpPrepareQueue();
  };

  const timeoutTimer = setTimeout(() => {
    console.warn(`[Transcoder Live] ffmpeg timeout for #${trackId} (${quality}/${format})`);
    killFfmpegGracefully(proc);
    if (!passThrough.destroyed) {
      passThrough.destroy(new Error('Transcode timeout'));
    }
    finalize(false);
  }, FFMPEG_TIMEOUT_MS);

  const killIfAbandoned = () => {
    if (clientClosed && latestLiveKey !== cacheKey && !settled) {
      abortedBySupersede = true;
      killFfmpegGracefully(proc);
    }
  };

  inFlightJobs.set(cacheKey, {
    promise: sharedPromise,
    priority: 'live',
    trackId,
    killIfAbandoned,
  });

  let waitingForDrain = false;
  proc.stdout?.on('data', (chunk: Buffer) => {
    if (!tmpWriteFailed && !abortedBySupersede) {
      tmpStream.write(chunk);
    }
    if (!clientClosed && !passThrough.destroyed) {
      const ok = passThrough.write(chunk);
      if (!ok && !waitingForDrain && passThrough.writableLength > 512 * 1024) {
        waitingForDrain = true;
        proc.stdout?.pause();
        passThrough.once('drain', () => {
          waitingForDrain = false;
          proc.stdout?.resume();
        });
      }
    }
  });

  proc.on('close', (code) => {
    if (!passThrough.destroyed) {
      if (code === 0) {
        passThrough.end();
      } else {
        passThrough.destroy(new Error(`ffmpeg exited with code ${code}`));
      }
    }
    if (code !== 0 && !abortedBySupersede && stderrTail) {
      console.warn(`[Transcoder Live] ffmpeg exit ${code} for #${trackId}: ${stderrTail.trim()}`);
    }
    finalize(code === 0);
  });

  proc.on('error', (err) => {
    if (!passThrough.destroyed) {
      passThrough.destroy(err);
    }
    finalize(false);
  });

  const cleanup = () => {
    clientClosed = true;
    // Unblock ffmpeg stdout if passThrough had paused it before disconnect
    if (waitingForDrain) {
      waitingForDrain = false;
      proc.stdout?.resume();
    }
    if (!passThrough.destroyed) {
      passThrough.destroy();
    }
    // If another track already superseded this one, abort ffmpeg immediately to save Celeron CPU
    if (latestLiveKey !== cacheKey) {
      abortedBySupersede = true;
      killFfmpegGracefully(proc);
    }
  };

  return { stream: passThrough, contentType, cleanup };
}

function pumpPrepareQueue(): void {
  if (isPreparePumpRunning) return;
  if (activeLiveTranscodes > 0 || activeBgTranscodes >= MAX_BG_CONCURRENT) return;
  if (prepareQueue.length === 0) return;

  isPreparePumpRunning = true;
  (async () => {
    try {
      while (prepareQueue.length > 0) {
        if (activeLiveTranscodes > 0 || activeBgTranscodes >= MAX_BG_CONCURRENT) {
          break;
        }
        const next = prepareQueue.shift()!;
        const existing = await getCachedTranscodePath(
          next.trackId,
          next.sourceMtimeMs,
          next.quality,
          next.format
        );
        if (existing) continue;
        await ensureTranscodedFile(
          next.trackId,
          next.sourcePath,
          next.sourceMtimeMs,
          next.quality,
          next.format,
          'bg'
        );
      }
    } finally {
      isPreparePumpRunning = false;
    }
  })();
}

export async function enqueuePrepareTracks(
  entries: Array<{
    trackId: number;
    sourcePath: string;
    sourceMtimeMs: number;
    quality: StreamQuality;
    format: StreamFormat;
  }>
): Promise<{ cached: number[]; queued: number[] }> {
  const cached: number[] = [];
  const queued: number[] = [];
  const nextQueue: PrepareQueueItem[] = [];

  for (const item of entries.slice(0, MAX_PREPARE_QUEUE)) {
    if (item.quality === 'original') continue;
    const hit = await getCachedTranscodePath(
      item.trackId,
      item.sourceMtimeMs,
      item.quality,
      item.format
    );
    if (hit) {
      touchCacheFile(hit.path);
      cached.push(item.trackId);
      continue;
    }

    const key = buildCacheKey(item.trackId, item.sourceMtimeMs, item.quality, item.format);
    if (inFlightJobs.has(key)) {
      queued.push(item.trackId);
      continue;
    }

    nextQueue.push({
      trackId: item.trackId,
      sourcePath: item.sourcePath,
      sourceMtimeMs: item.sourceMtimeMs,
      quality: item.quality,
      format: item.format,
    });
    queued.push(item.trackId);
  }

  // Replace stale queued items so rapid playlist changes do not waste CPU
  prepareQueue = nextQueue;
  pumpPrepareQueue();

  return { cached, queued };
}

export async function getTranscodeCacheStats(): Promise<{
  files: number;
  sizeBytes: number;
  maxBytes: number;
  activeLive: number;
  activeBg: number;
}> {
  let files = 0;
  let sizeBytes = 0;
  try {
    ensureCacheDir();
    const names = await fs.promises.readdir(TRANSCODE_CACHE_DIR);
    for (const name of names) {
      if (name.includes('.tmp.')) continue;
      const full = path.join(TRANSCODE_CACHE_DIR, name);
      if (!isInsideCacheDir(full)) continue;
      try {
        const st = await fs.promises.stat(full);
        if (st.isFile()) {
          files++;
          sizeBytes += st.size;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return {
    files,
    sizeBytes,
    maxBytes: MAX_CACHE_BYTES,
    activeLive: activeLiveTranscodes,
    activeBg: activeBgTranscodes,
  };
}
