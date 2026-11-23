import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { db } from './db';
import { refreshJellyfinLibrary } from './jellyfin';
import { SpotifyTrack, resolveSpotifyTrackDetails, fetchSpotifyPlaylist, resolveDeezerTrackInfo } from './spotify';
import { broadcastToUser, broadcastToAll } from './sync';
import { invalidateTrackStreamMeta } from './streamOptimizer';
import { invalidateTranscodeCacheForTrack } from './transcoder';

const MUSIC_DIR = process.env.MUSIC_DIR || path.join(process.cwd(), 'music');

interface QueueItem {
  jobId: string;
  userId: number;
  playlistId: number | null;
  track: SpotifyTrack;
  position: number;
  isLikedOnly?: boolean;
}

const queue: QueueItem[] = [];
let isWorkerRunning = false;

export function sanitizeFilename(name: string): string {
  if (!name) return 'track';
  let safe = String(name)
    .replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .trim();
  if (!safe || safe === '.' || safe === '..') {
    safe = 'track';
  }
  return safe.slice(0, 100);
}

export function getSafeArtistDir(artist: string): string {
  const artistFolder = sanitizeFilename(artist || 'Unknown Artist');
  const resolvedMusicDir = path.resolve(MUSIC_DIR);
  const targetDir = path.resolve(MUSIC_DIR, artistFolder);
  if (!targetDir.startsWith(resolvedMusicDir + path.sep) && targetDir !== resolvedMusicDir) {
    return path.join(resolvedMusicDir, 'Unknown Artist');
  }
  return targetDir;
}

export function isPathInsideMusicDir(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  const resolvedFile = path.resolve(filePath);
  const resolvedMusic = path.resolve(MUSIC_DIR);
  return resolvedFile.startsWith(resolvedMusic + path.sep);
}

export function resolveAudioFilePath(targetDir: string, safeTitle: string): string | null {
  const extensions = ['.mp3', '.m4a', '.opus', '.webm', '.flac', '.ogg'];
  for (const ext of extensions) {
    const candidate = path.join(targetDir, `${safeTitle}${ext}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function cleanupPartialFiles(targetDir: string, safeTitle: string) {
  try {
    if (!fs.existsSync(targetDir)) return;
    const files = fs.readdirSync(targetDir);
    const tempExts = ['.part', '.ytdl', '.temp', '.webp', '.png', '.jpg'];
    const audioExts = ['.mp3', '.m4a', '.opus', '.webm', '.flac', '.ogg'];

    for (const f of files) {
      // 1. Temporary/partial files starting with safeTitle followed by . or _
      const isTempWithPrefix =
        (f.startsWith(`${safeTitle}.`) || f.startsWith(`${safeTitle}_`)) &&
        tempExts.some(ext => f.endsWith(ext));

      // 2. Exact file matching safeTitle + audioExt (never match other tracks like "Title (Remix).mp3")
      const isExactAudioFile = audioExts.some(ext => f === `${safeTitle}${ext}`);

      if (isTempWithPrefix || isExactAudioFile) {
        try {
          fs.unlinkSync(path.join(targetDir, f));
        } catch (_) {}
      }
    }
  } catch (_) {}
}

function killProcessGroup(proc: ReturnType<typeof spawn>, signal: NodeJS.Signals = 'SIGKILL') {
  try {
    if (proc.pid) {
      process.kill(-proc.pid, signal);
    }
  } catch (_) {}
  try {
    proc.kill(signal);
  } catch (_) {}
}

export enum DownloadPriority {
  HIGH = 0,   // Instant Play / Direct user single track download / Studio master redownload
  NORMAL = 1, // Playlist & Daily Mix queue worker
  LOW = 2     // Opportunistic healer & bulk quality upgrader
}

const MAX_CONCURRENT_DOWNLOADS = 2;
let activeDownloads = 0;

interface QueuedDownloadRequest {
  id: number;
  priority: DownloadPriority;
  taskName: string;
  resolve: (acquired: boolean) => void;
  queuedAt: number;
}

let nextRequestId = 1;
const downloadWaitQueue: QueuedDownloadRequest[] = [];
const MAX_WAIT_QUEUE = 200;

function enqueueRequest(priority: DownloadPriority, taskName: string, resolve: (acquired: boolean) => void) {
  if (downloadWaitQueue.length >= MAX_WAIT_QUEUE) {
    // Drop the lowest priority item from the tail to prevent unbounded memory growth
    const dropped = downloadWaitQueue.pop();
    if (dropped) {
      console.warn(`[DownloadScheduler] Wait queue saturated (${MAX_WAIT_QUEUE}). Dropped lowest priority task "${dropped.taskName}"`);
      try { dropped.resolve(false); } catch (_) {}
    }
  }

  const req: QueuedDownloadRequest = {
    id: nextRequestId++,
    priority,
    taskName,
    resolve,
    queuedAt: Date.now()
  };

  // Higher priority (smaller numeric value) comes first.
  // Same priority: FIFO order (stable sort).
  let insertIdx = downloadWaitQueue.length;
  for (let i = 0; i < downloadWaitQueue.length; i++) {
    if (priority < downloadWaitQueue[i].priority) {
      insertIdx = i;
      break;
    }
  }
  downloadWaitQueue.splice(insertIdx, 0, req);
  console.log(`[DownloadScheduler] Enqueued #${req.id} [${DownloadPriority[priority]}] "${taskName}". Active: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}, Queued: ${downloadWaitQueue.length}`);
}

function processDownloadQueue() {
  while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && downloadWaitQueue.length > 0) {
    const next = downloadWaitQueue.shift();
    if (!next) break;
    activeDownloads++;
    const waitMs = Date.now() - next.queuedAt;
    console.log(`[DownloadScheduler] Dispatched #${next.id} [${DownloadPriority[next.priority]}] "${next.taskName}" (waited ${waitMs}ms). Active: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`);
    try { next.resolve(true); } catch (_) {}
  }
}

export async function runWithPrioritySlot<T>(
  priority: DownloadPriority,
  taskName: string,
  fn: () => Promise<T>
): Promise<T> {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS || downloadWaitQueue.length > 0) {
    const acquired = await new Promise<boolean>((resolve) => {
      enqueueRequest(priority, taskName, resolve);
      processDownloadQueue();
    });
    if (!acquired) {
      throw new Error(`Download wait queue saturated. Task "${taskName}" was dropped.`);
    }
  } else {
    activeDownloads++;
    console.log(`[DownloadScheduler] Direct dispatch [${DownloadPriority[priority]}] "${taskName}". Active: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}`);
  }

  try {
    return await fn();
  } finally {
    activeDownloads--;
    console.log(`[DownloadScheduler] Released [${DownloadPriority[priority]}] "${taskName}". Active: ${activeDownloads}/${MAX_CONCURRENT_DOWNLOADS}, Waiting: ${downloadWaitQueue.length}`);
    processDownloadQueue();
  }
}

// Deprecated alias for backwards compatibility
async function runWithSingleDownloadSlot<T>(fn: () => Promise<T>): Promise<T> {
  return runWithPrioritySlot(DownloadPriority.HIGH, 'legacy-single-slot', fn);
}

export function getDownloadSchedulerStats() {
  return {
    activeDownloads,
    maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
    waitingInQueue: downloadWaitQueue.length,
    queue: downloadWaitQueue.map(q => ({
      id: q.id,
      priority: DownloadPriority[q.priority],
      taskName: q.taskName,
      waitingMs: Date.now() - q.queuedAt
    }))
  };
}

interface BlacklistCacheEntry {
  rows: any[];
  cachedAt: number;
}
const userBlacklistMemoryCache = new Map<number, BlacklistCacheEntry>();
const BLACKLIST_CACHE_TTL_MS = 30000; // 30 seconds in-memory TTL to eliminate N+1 queries
const MAX_BLACKLIST_CACHE_SIZE = 500;

function pruneBlacklistCache() {
  if (userBlacklistMemoryCache.size > MAX_BLACKLIST_CACHE_SIZE) {
    const now = Date.now();
    for (const [k, v] of userBlacklistMemoryCache.entries()) {
      if (now - v.cachedAt > BLACKLIST_CACHE_TTL_MS) {
        userBlacklistMemoryCache.delete(k);
      }
    }
    if (userBlacklistMemoryCache.size > MAX_BLACKLIST_CACHE_SIZE) {
      let toRemove = userBlacklistMemoryCache.size - Math.floor(MAX_BLACKLIST_CACHE_SIZE * 0.8);
      for (const k of userBlacklistMemoryCache.keys()) {
        userBlacklistMemoryCache.delete(k);
        if (--toRemove <= 0) break;
      }
    }
  }
}

export function invalidateUserBlacklistCache(userId?: number) {
  if (userId !== undefined) {
    userBlacklistMemoryCache.delete(userId);
  } else {
    userBlacklistMemoryCache.clear();
  }
}

function getUserBlacklistRows(userId: number): any[] {
  const now = Date.now();
  const cached = userBlacklistMemoryCache.get(userId);
  if (cached && (now - cached.cachedAt) < BLACKLIST_CACHE_TTL_MS) {
    return cached.rows;
  }
  const rows: any[] = db.prepare(`
    SELECT title, artist, spotify_id FROM blacklist WHERE user_id = ?
  `).all(userId);
  pruneBlacklistCache();
  userBlacklistMemoryCache.set(userId, { rows, cachedAt: now });
  return rows;
}

export function matchesArtistPattern(fullArtist: string, ruleArtist: string): boolean {
  if (!ruleArtist || ruleArtist === '*') return true;
  if (!fullArtist) return false;
  const lFull = fullArtist.toLowerCase().trim();
  const lRule = ruleArtist.toLowerCase().trim();
  if (lFull === lRule) return true;

  // Split on common collaboration delimiters: comma, &, slash, semicolon, feat, ft, with
  const splitRegex = /[,&/;\\]|\s+(?:feat\.?|ft\.?|with)\s+/i;
  const fullParts = lFull.split(splitRegex).map(s => s.trim()).filter(Boolean);
  const ruleParts = lRule.split(splitRegex).map(s => s.trim()).filter(Boolean);

  if (fullParts.some(p => p === lRule || ruleParts.includes(p))) {
    return true;
  }

  // If starts with ruleArtist, require word/collaboration boundary (not arbitrary substring like "The" -> "The Weeknd")
  if (lFull.startsWith(lRule)) {
    const remainder = lFull.slice(lRule.length).trim();
    if (!remainder || /^([,&/;\\]|\b(feat|ft|with)\b)/i.test(remainder)) {
      return true;
    }
  }

  return false;
}

export function isTrackBlacklistedForUser(
  userId: number,
  title: string,
  artist: string,
  spotifyId?: string
): boolean {
  if (!userId || !title) return false;
  try {
    const lTitle = title.toLowerCase().trim();
    const lArtist = (artist || '').toLowerCase().trim();

    const cleanTitle = (s: string) =>
      s
        .toLowerCase()
        .replace(/[\(\[][^\)\]]*(feat|ft|with|remix|version|bonus|edit)[^\)\]]*[\)\]]/gi, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();

    const cTitle = cleanTitle(lTitle);
    const rows = getUserBlacklistRows(userId);

    return rows.some((b) => {
      if (spotifyId && b.spotify_id && b.spotify_id === spotifyId) return true;
      const bTitle = (b.title || '').toLowerCase().trim();
      const bArtist = (b.artist || '').toLowerCase().trim();

      const artistMatches = matchesArtistPattern(lArtist, bArtist);
      if (!artistMatches) return false;

      // Artist-wide ban
      if (bTitle === '*') return true;

      // Exact title match or normalized title match
      if (bTitle === lTitle) return true;
      if (cTitle && cleanTitle(bTitle) === cTitle) return true;

      return false;
    });
  } catch (err: any) {
    console.error('[Blacklist Check Error]', err.message);
    return false;
  }
}

export function filterBlacklistedTracksForUser<T extends { title: string; artist: string; spotify_id?: string }>(
  userId: number,
  tracks: T[]
): T[] {
  if (!userId || !tracks || tracks.length === 0) return tracks;
  try {
    const rows = getUserBlacklistRows(userId);
    if (!rows || rows.length === 0) return tracks;

    const cleanTitle = (s: string) =>
      s
        .toLowerCase()
        .replace(/[\(\[][^\)\]]*(feat|ft|with|remix|version|bonus|edit)[^\)\]]*[\)\]]/gi, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();

    const preparedRules = rows.map((b) => {
      const bTitle = (b.title || '').toLowerCase().trim();
      const bArtist = (b.artist || '').toLowerCase().trim();
      return {
        spotifyId: b.spotify_id || null,
        title: bTitle,
        cleanTitle: cleanTitle(bTitle),
        artist: bArtist,
        isArtistOnly: bTitle === '*'
      };
    });

    return tracks.filter((t) => {
      if (!t || !t.title) return true;
      const lTitle = t.title.toLowerCase().trim();
      const lArtist = (t.artist || '').toLowerCase().trim();
      const cTitle = cleanTitle(lTitle);
      const spotifyId = t.spotify_id || (t as any).spotifyId;

      return !preparedRules.some((b) => {
        if (spotifyId && b.spotifyId && b.spotifyId === spotifyId) return true;

        const artistMatches = matchesArtistPattern(lArtist, b.artist);
        if (!artistMatches) return false;

        if (b.isArtistOnly) return true;
        if (b.title === lTitle) return true;
        if (cTitle && b.cleanTitle === cTitle) return true;

        return false;
      });
    });
  } catch (err: any) {
    console.error('[Filter Blacklisted Error]', err.message);
    return tracks;
  }
}

export function cancelBlacklistedDownloads(
  userId: number,
  title: string,
  artist: string,
  spotifyId?: string
): void {
  const lTitle = title.toLowerCase().trim();
  const lArtist = (artist || '').toLowerCase().trim();

  const cleanTitle = (s: string) =>
    s
      .toLowerCase()
      .replace(/[\(\[][^\)\]]*(feat|ft|with|remix|version|bonus|edit)[^\)\]]*[\)\]]/gi, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();

  const cTitle = cleanTitle(lTitle);

  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i];
    if (item.userId !== userId) continue;

    if (spotifyId && item.track.id && item.track.id === spotifyId) {
      queue.splice(i, 1);
      continue;
    }

    const itemArtist = (item.track.artist || '').toLowerCase().trim();
    const artistMatches = matchesArtistPattern(itemArtist, lArtist);
    if (!artistMatches) continue;

    if (lTitle === '*') {
      queue.splice(i, 1);
      continue;
    }

    const itemTitle = (item.track.title || '').toLowerCase().trim();
    if (itemTitle === lTitle || (cTitle && cleanTitle(itemTitle) === cTitle)) {
      queue.splice(i, 1);
    }
  }
}

export interface AudioProbeResult {
  valid: boolean;
  durationSec: number;
  bitrateKbps: number;
  sampleRate?: number;
  isHighQuality: boolean;
  reason?: string;
  sourceVideoId?: string;
  embeddedTitle?: string;
  embeddedAlbum?: string;
}

export async function probeAudioFile(filePath: string, expectedDurationMs?: number): Promise<AudioProbeResult> {
  if (!filePath || !fs.existsSync(filePath)) {
    return { valid: false, durationSec: 0, bitrateKbps: 0, isHighQuality: false, reason: 'FILE_NOT_FOUND' };
  }
  if (!isPathInsideMusicDir(filePath)) {
    return { valid: false, durationSec: 0, bitrateKbps: 0, isHighQuality: false, reason: 'PATH_OUTSIDE_MUSIC_DIR' };
  }
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 100000) {
      return { valid: false, durationSec: 0, bitrateKbps: 0, isHighQuality: false, reason: 'FILE_TOO_SMALL' };
    }
  } catch (e: any) {
    return { valid: false, durationSec: 0, bitrateKbps: 0, isHighQuality: false, reason: e.message };
  }

  return new Promise<AudioProbeResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: AudioProbeResult) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      }
    };

    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,sample_rate,bit_rate',
      '-show_format',
      '-of', 'json',
      '--',
      filePath
    ], { detached: true });

    let stdout = '';
    proc.stdout.on('data', d => {
      if (stdout.length < 512 * 1024) stdout += d.toString();
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        return finish({ valid: false, durationSec: 0, bitrateKbps: 0, isHighQuality: false, reason: 'PROBE_FAILED' });
      }
      try {
        const parsed = JSON.parse(stdout) || {};
        const data = parsed.format || {};
        const stream = parsed.streams?.[0] || {};
        const tags = data.tags || {};
        const rawUrl = String(tags.purl || tags.comment || tags.PURL || tags.COMMENT || '').trim();
        const ytMatch = rawUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/);
        const sourceVideoId = ytMatch ? ytMatch[1] : undefined;
        const embeddedTitle = String(tags.title || tags.TITLE || '').trim() || undefined;
        const embeddedAlbum = String(tags.album || tags.ALBUM || '').trim() || undefined;
        const durationSec = parseFloat(data.duration) || 0;
        const bitrateBps = parseInt(data.bit_rate || stream.bit_rate, 10) || 0;
        const bitrateKbps = Math.round(bitrateBps / 1000);
        const sampleRate = parseInt(stream.sample_rate, 10) || 0;

        const expectedSec = expectedDurationMs ? expectedDurationMs / 1000 : 0;
        let isTruncated = false;
        if (expectedSec > 60) {
          if (durationSec < 55 || durationSec < expectedSec * 0.6) {
            isTruncated = true;
          }
        } else if (expectedSec > 20 && durationSec < 15) {
          isTruncated = true;
        }

        const ext = path.extname(filePath).toLowerCase();
        const isLossless = ext === '.flac' || ext === '.wav';
        // Require true 320 kbps 48 kHz studio MP3 (or lossless); flag legacy 128k .m4a and 44.1 kHz Format-18 sources
        const isLowBitrate = !isLossless && (ext !== '.mp3' || bitrateKbps < 250);
        const isSuboptimalSampleRate = !isLossless && sampleRate > 0 && sampleRate < 48000;

        if (isTruncated || isLowBitrate || isSuboptimalSampleRate) {
          const reasons: string[] = [];
          if (isTruncated) reasons.push(`Обрезан (${Math.round(durationSec)}с вместо ${Math.round(expectedSec)}с)`);
          if (isLowBitrate) reasons.push(`Низкий битрейт/формат (${bitrateKbps} kbps ${ext})`);
          if (isSuboptimalSampleRate) reasons.push(`Частота дискретизации ${sampleRate} Hz (Format 18 вместо 48000 Hz Opus Master)`);
          return finish({
            valid: true,
            durationSec,
            bitrateKbps,
            sampleRate,
            isHighQuality: false,
            reason: reasons.join(', '),
            sourceVideoId,
            embeddedTitle,
            embeddedAlbum
          });
        }

        return finish({
          valid: true,
          durationSec,
          bitrateKbps,
          sampleRate,
          isHighQuality: true,
          sourceVideoId,
          embeddedTitle,
          embeddedAlbum
        });
      } catch (err: any) {
        finish({ valid: false, durationSec: 0, bitrateKbps: 0, isHighQuality: false, reason: err.message });
      }
    });

    proc.on('error', (err) => {
      finish({ valid: false, durationSec: 0, bitrateKbps: 0, isHighQuality: false, reason: err.message });
    });

    timer = setTimeout(() => {
      try { killProcessGroup(proc, 'SIGKILL'); } catch (_) {}
      finish({ valid: false, durationSec: 0, bitrateKbps: 0, isHighQuality: false, reason: 'PROBE_TIMEOUT' });
    }, 10000);
  });
}

export function cancelPlaylistDownloads(playlistIds: number[] | number) {
  if (playlistIds === undefined || playlistIds === null) return;
  const ids = Array.isArray(playlistIds) ? playlistIds : [playlistIds];
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].playlistId !== null && idSet.has(queue[i].playlistId!)) {
      queue.splice(i, 1);
    }
  }
  try {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM download_jobs WHERE playlist_id IN (${placeholders})`).run(...ids);
  } catch (_) {}
}

export function cancelUserDownloads(userId: number) {
  if (!userId) return;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].userId === userId) {
      queue.splice(i, 1);
    }
  }
  try {
    db.prepare('DELETE FROM download_jobs WHERE user_id = ?').run(userId);
  } catch (_) {}
}

const MAX_PLAYLIST_QUEUE_SIZE = 2000;

export function enqueuePlaylistDownload(
  jobId: string,
  userId: number,
  playlistId: number | null,
  tracks: SpotifyTrack[],
  startPosition?: number,
  isLikedOnly: boolean = false
) {
  let pos = startPosition;
  if (pos === undefined && playlistId) {
    const maxRow: any = db.prepare('SELECT MAX(position) as maxPos FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
    pos = (maxRow?.maxPos !== null && maxRow?.maxPos !== undefined) ? maxRow.maxPos + 1 : 0;
  } else if (pos === undefined) {
    pos = 0;
  }

  for (let i = 0; i < tracks.length; i++) {
    if (queue.length >= MAX_PLAYLIST_QUEUE_SIZE) {
      console.warn(`[Downloader] Queue reached maximum capacity (${MAX_PLAYLIST_QUEUE_SIZE}). Dropping excess tracks.`);
      break;
    }
    if (/https?:\/\//i.test(tracks[i].title) || /https?:\/\//i.test(tracks[i].artist)) {
      console.warn(`[Downloader] Skipping invalid URL-as-title track "${tracks[i].artist} - ${tracks[i].title}"`);
      continue;
    }
    if (isTrackBlacklistedForUser(userId, tracks[i].title, tracks[i].artist, tracks[i].id)) {
      console.log(`[Downloader] Skipping queued blacklisted track "${tracks[i].artist} - ${tracks[i].title}" for user ${userId}`);
      continue;
    }
    const customPos = (tracks[i] as any).position;
    queue.push({
      jobId,
      userId,
      playlistId,
      track: tracks[i],
      position: typeof customPos === 'number' ? customPos : pos + i,
      isLikedOnly
    });
  }

  if (!isWorkerRunning) {
    runWorkerLoop().catch(err => console.error('[Downloader Worker Error]', err));
  }
}

/**
 * Resumes any unfinished download jobs (status = 'downloading' or 'pending') from DB on server startup.
 */
export async function resumePendingDownloads() {
  try {
    const pendingJobs: any[] = db.prepare(`
      SELECT * FROM download_jobs
      WHERE status IN ('downloading', 'pending')
    `).all();

    if (pendingJobs.length === 0) return;

    console.log(`[Downloader] Found ${pendingJobs.length} unfinished download job(s). Resuming...`);

    for (const job of pendingJobs) {
      await resumePlaylistDownload(job.playlist_id, job.id);
    }
  } catch (err: any) {
    console.error('[Downloader] Failed to resume pending downloads:', err.message);
  }
}

/**
 * Resumes or re-queues missing tracks for a playlist.
 */
export async function resumePlaylistDownload(playlistId: number, existingJobId?: string): Promise<{ success: boolean; queued: number; message: string }> {
  try {
    const playlist: any = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId);
    if (!playlist || (!playlist.spotify_id && !playlist.daily_mix_tracks_json)) {
      if (existingJobId) {
        db.prepare("UPDATE download_jobs SET status = 'failed' WHERE id = ?").run(existingJobId);
      }
      return { success: false, queued: 0, message: 'Плейлист или ссылка Spotify не найдены' };
    }

    let targetTracks: SpotifyTrack[] = [];
    if (playlist.daily_mix_tracks_json) {
      try {
        targetTracks = JSON.parse(playlist.daily_mix_tracks_json) || [];
      } catch (_) {}
    } else if (playlist.spotify_id) {
      const playlistData = await fetchSpotifyPlaylist(playlist.spotify_id);
      targetTracks = playlistData.tracks || [];
    }

    if (!targetTracks || targetTracks.length === 0) {
      return { success: false, queued: 0, message: 'Не удалось получить треки для загрузки' };
    }
    const playlistData = { tracks: targetTracks };

    let jobId = existingJobId;
    if (!jobId) {
      const activeJob: any = db.prepare(`
        SELECT id FROM download_jobs
        WHERE playlist_id = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(playlistId);

      jobId = activeJob?.id || Math.random().toString(36).substring(2, 10);
      const countRow: any = db.prepare('SELECT COUNT(*) as cnt FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
      const initialDownloaded = countRow?.cnt || 0;
      if (!activeJob) {
        db.prepare(`
          INSERT INTO download_jobs (id, user_id, playlist_id, playlist_name, total_tracks, downloaded_tracks, status)
          VALUES (?, ?, ?, ?, ?, ?, 'downloading')
        `).run(jobId, playlist.user_id, playlistId, playlist.name, playlistData.tracks.length, initialDownloaded);
      } else {
        db.prepare(`
          UPDATE download_jobs
          SET status = 'downloading', total_tracks = ?, downloaded_tracks = MAX(COALESCE(downloaded_tracks, 0), ?)
          WHERE id = ?
        `).run(playlistData.tracks.length, initialDownloaded, jobId);
      }
    }

    // Get tracks already linked to this playlist
    const existingPlaylistTracks: any[] = db.prepare(`
      SELECT pt.position, t.spotify_id, LOWER(t.title) as title, LOWER(t.artist) as artist
      FROM playlist_tracks pt
      JOIN tracks t ON pt.track_id = t.id
      WHERE pt.playlist_id = ?
    `).all(playlistId);

    const existingTrackSet = new Set<string>();
    for (const r of existingPlaylistTracks) {
      if (r.spotify_id) existingTrackSet.add(`sp:${r.spotify_id}`);
      existingTrackSet.add(`name:${r.title}|${r.artist}`);
    }

    const maxPosRow: any = db.prepare('SELECT MAX(position) as maxPos FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
    let nextAvailablePos = (maxPosRow?.maxPos !== null && maxPosRow?.maxPos !== undefined) ? maxPosRow.maxPos + 1 : 0;

    let queuedCount = 0;
    playlistData.tracks.forEach((track) => {
      if (isTrackBlacklistedForUser(playlist.user_id, track.title, track.artist, track.id)) {
        console.log(`[Downloader] Skipping resume of blacklisted track "${track.artist} - ${track.title}" for user ${playlist.user_id}`);
        return;
      }

      const isAlreadyAdded = (track.id && existingTrackSet.has(`sp:${track.id}`)) ||
        existingTrackSet.has(`name:${track.title.toLowerCase().trim()}|${track.artist.toLowerCase().trim()}`);

      const alreadyInQueue = queue.some(q => q.playlistId === playlistId && (
        (track.id && q.track.id === track.id) ||
        (q.track.title.toLowerCase() === track.title.toLowerCase() && q.track.artist.toLowerCase() === track.artist.toLowerCase())
      ));

      if (!isAlreadyAdded && !alreadyInQueue) {
        if (queue.length >= MAX_PLAYLIST_QUEUE_SIZE) {
          console.warn(`[Downloader] Queue reached maximum capacity (${MAX_PLAYLIST_QUEUE_SIZE}) during playlist resume.`);
          return;
        }
        const customPos = (track as any).position;
        queue.push({
          jobId: jobId!,
          userId: playlist.user_id,
          playlistId,
          track,
          position: typeof customPos === 'number' ? customPos : nextAvailablePos++
        });
        queuedCount++;
      }
    });

    const currentDownloaded = existingPlaylistTracks.length;
    db.prepare(`
      UPDATE download_jobs
      SET downloaded_tracks = ?, total_tracks = ?
      WHERE id = ?
    `).run(currentDownloaded, currentDownloaded + queuedCount, jobId);

    if (queuedCount === 0 && currentDownloaded >= playlistData.tracks.length) {
      db.prepare(`
        UPDATE download_jobs
        SET status = 'completed', current_track = NULL
        WHERE id = ?
      `).run(jobId);
      await refreshJellyfinLibrary();
      return { success: true, queued: 0, message: 'Все треки уже успешно скачаны' };
    }

    if (!isWorkerRunning && queue.length > 0) {
      runWorkerLoop().catch(err => console.error('[Downloader Worker Error]', err));
    }

    return {
      success: true,
      queued: queuedCount,
      message: `Возобновлено скачивание: ${queuedCount} треков добавлено в очередь`
    };
  } catch (err: any) {
    console.error(`[Downloader] Resume error for playlist ${playlistId}:`, err.message);
    return { success: false, queued: 0, message: err.message };
  }
}

async function runWorkerLoop() {
  if (isWorkerRunning) return;
  isWorkerRunning = true;

  console.log('[Downloader] Background worker loop started. Total in queue:', queue.length);

  while (queue.length > 0) {
    const item = queue.shift()!;
    try {
      await downloadSingleTrack(item);
    } catch (err: any) {
      console.error(`[Downloader] Error downloading ${item.track.artist} - ${item.track.title}:`, err.message);
    }

    // Check if remaining tracks for this job
    const remainingForJob = queue.filter(q => q.jobId === item.jobId).length;
    if (remainingForJob === 0) {
      let count = 0;
      if (item.playlistId) {
        const countRow: any = db.prepare('SELECT COUNT(*) as cnt FROM playlist_tracks WHERE playlist_id = ?').get(item.playlistId);
        count = countRow?.cnt || 0;
      } else {
        const countRow: any = db.prepare('SELECT COUNT(*) as cnt FROM liked_tracks WHERE user_id = ?').get(item.userId);
        count = countRow?.cnt || 0;
      }

      const jobRow: any = db.prepare('SELECT total_tracks FROM download_jobs WHERE id = ?').get(item.jobId);
      const totalTracks = jobRow?.total_tracks || 0;
      const finalStatus = (count === 0 && totalTracks > 0) ? 'failed' : 'completed';

      db.prepare(`
        UPDATE download_jobs
        SET status = ?, downloaded_tracks = ?, current_track = NULL
        WHERE id = ?
      `).run(finalStatus, count, item.jobId);

      // Trigger Jellyfin library refresh
      await refreshJellyfinLibrary();

      // Broadcast real-time updates to user's connected devices
      broadcastToUser(item.userId, { type: 'LIKES_UPDATED' });
      broadcastToUser(item.userId, { type: 'PLAYLISTS_UPDATED' });
    }
  }

  isWorkerRunning = false;
  console.log('[Downloader] Background worker loop completed and idle.');
}

export interface StudioSearchOptions {
  album?: string;
  excludeVideoIds?: Set<string>;
}

interface StudioCandidateCacheEntry {
  url: string;
  cachedAt: number;
}
const studioCandidateCache = new Map<string, StudioCandidateCacheEntry>();
const CANDIDATE_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export async function findBestStudioAudioSource(
  artist: string,
  title: string,
  durationMs?: number,
  bypassCache: boolean = false,
  options?: StudioSearchOptions
): Promise<string> {
  const targetSec = durationMs ? Math.round(durationMs / 1000) : 0;
  // Security: strip leading dashes/flags to prevent argument injection, normalize unicode
  const cleanArtist = (artist || '')
    .replace(/[∅Ø]/g, 'O')
    .replace(/^[- \t]+/, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanTitle = (title || '')
    .replace(/[∅Ø]/g, 'O')
    .replace(/^[- \t]+/, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanTitleNoFeat = cleanTitle.replace(/\s*\((feat|ft)\.?\s+[^)]+\)/gi, '').trim();
  const cleanTitleBase = (cleanTitleNoFeat || cleanTitle)
    .replace(/\s*[-–—]\s*(?:Remastered(?:\s+\d{4})?|\d{4}\s*[-–—]?\s*Remaster(?:ed)?|Single Version|Album Version|Radio Edit|Original Mix|Explicit|Clean)\b.*$/i, '')
    .replace(/\s*\((?:Remastered(?:\s+\d{4})?|\d{4}\s+Remaster(?:ed)?|Single Version|Album Version|Radio Edit|Original Mix|Explicit|Clean)\)/gi, '')
    .trim();
  const cleanAlbum = (options?.album || '')
    .replace(/[∅Ø]/g, 'O')
    .replace(/^[- \t]+/, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const isUsefulAlbum = cleanAlbum.length >= 3 && !/^(любимые треки|liked songs|single|-)$/i.test(cleanAlbum);

  const hasExclusions = Boolean(options?.excludeVideoIds && options.excludeVideoIds.size > 0);
  const cacheKey = `${cleanArtist.toLowerCase()}:::${cleanTitle.toLowerCase()}`;
  if (!bypassCache && !hasExclusions) {
    const cached = studioCandidateCache.get(cacheKey);
    if (cached && (Date.now() - cached.cachedAt) < CANDIDATE_CACHE_TTL_MS) {
      console.log(`[Studio Audio Match Cache HIT] "${cleanArtist} - ${cleanTitle}": ${cached.url}`);
      return cached.url;
    }
  }

  // Helper to query yt-dlp flat playlist / dump json
  const fetchCandidates = async (queryOrUrl: string, defaultSearch?: string, timeoutMs: number = 45000): Promise<any[]> => {
    return new Promise<any[]>((resolve) => {
      const isUrl = queryOrUrl.startsWith('http://') || queryOrUrl.startsWith('https://');
      const nodePath = process.execPath || '/usr/local/bin/node';
      const args = [
        '--js-runtimes', `node:${nodePath}`,
        '--dump-json',
        '--flat-playlist'
      ];
      if (!isUrl && defaultSearch) {
        args.push('--default-search', defaultSearch);
      }
      args.push('--', queryOrUrl);

      const proc = spawn('yt-dlp', args, { detached: true });
      let stdout = '';
      proc.stdout.on('data', d => {
        if (stdout.length < 2 * 1024 * 1024) stdout += d.toString();
      });
      proc.stderr.on('data', () => {});
      const timer = setTimeout(() => {
        killProcessGroup(proc, 'SIGKILL');
        resolve([]);
      }, timeoutMs);

      proc.on('close', () => {
        clearTimeout(timer);
        const list: any[] = [];
        for (const line of stdout.trim().split('\n')) {
          if (!line) continue;
          try {
            const item = JSON.parse(line);
            if (item && item.id) list.push(item);
          } catch (_) {}
        }
        resolve(list);
      });
      proc.on('error', () => {
        clearTimeout(timer);
        resolve([]);
      });
    });
  };

  // Unicode-aware word boundary matcher so ASCII and Cyrillic variant tags match without substring false positives (e.g. "alive")
  const wordRe = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'iu');

  // Variant detection helpers so Slowed / Super Slowed / Ultra Slowed / Sped Up / Nightcore / Reverb / Instrumental / Remix / Live / Acoustic / Cover never collide with normal studio tracks
  const reUltraSlowed = wordRe('ultra\\s*slowed|mega\\s*slowed|ультра\\s*слоуд|мега\\s*слоуд');
  const reSuperSlowed = wordRe('super\\s*slowed|супер\\s*слоуд');
  const reAnySlowed = wordRe('slowed|slow\\s*down|слоуд|замедленн\\p{L}*');
  const reReverb = wordRe('reverb|reverbed|реверб\\p{L}*');
  const reSpedUp = wordRe('sped\\s*up|speed\\s*up|nightcore|ускоренн\\p{L}*|fast\\s*version');
  const reInstrumental = wordRe('instrumental|инструментал|караоке|karaoke|минусовка|минус|off\\s*vocal');
  const re8d = wordRe('8d');
  const reBassBoost = wordRe('bass\\s*boosted|bassboost|басс\\s*буст\\p{L}*');
  const reRemix = wordRe('remix|ремикс|bootleg|flip');
  const reLive = wordRe('live|лайв|концерт|concert|unplugged|выступление|шоу|live\\s+at|live\\s+session|live\\s+in|live\\s+from|живой\\s+звук|вживую|festival|фестиваль');
  const reLiveInDesc = wordRe('live\\s+at|recorded\\s+live|live\\s+from|live\\s+in|live\\s+performance|концерт\\s+в');
  const reAcoustic = wordRe('acoustic|акустика|акустическ\\p{L}*|под\\s+гитару');
  const reCover = wordRe('cover|кавер');

  const hasUltraSlowed = (s: string) => reUltraSlowed.test(s);
  const hasSuperSlowed = (s: string) => reSuperSlowed.test(s);
  const hasAnySlowed = (s: string) => reAnySlowed.test(s);
  const hasReverb = (s: string) => reReverb.test(s);
  const hasSpedUp = (s: string) => reSpedUp.test(s);
  const hasInstrumental = (s: string) => reInstrumental.test(s);
  const has8d = (s: string) => re8d.test(s);
  const hasBassBoost = (s: string) => reBassBoost.test(s);
  const hasRemix = (s: string) => reRemix.test(s);
  const hasLive = (s: string) => reLive.test(s);
  const hasAcoustic = (s: string) => reAcoustic.test(s);
  const hasCover = (s: string) => reCover.test(s);

  const targetWantsUltraSlowed = hasUltraSlowed(cleanTitle);
  const targetWantsSuperSlowed = !targetWantsUltraSlowed && hasSuperSlowed(cleanTitle);
  const targetWantsSlowed = !targetWantsUltraSlowed && !targetWantsSuperSlowed && hasAnySlowed(cleanTitle);
  const targetWantsAnySlowed = targetWantsUltraSlowed || targetWantsSuperSlowed || targetWantsSlowed;
  const targetWantsReverb = hasReverb(cleanTitle);
  const targetWantsSpedUp = hasSpedUp(cleanTitle);
  const targetWantsInstrumental = hasInstrumental(cleanTitle);
  const targetWants8d = has8d(cleanTitle);
  const targetWantsBassBoost = hasBassBoost(cleanTitle);
  const targetWantsRemix = hasRemix(cleanTitle);
  const targetWantsLive = hasLive(cleanTitle);
  const targetWantsAcoustic = hasAcoustic(cleanTitle);
  const targetWantsCover = hasCover(cleanTitle);

  const targetHasVariant =
    targetWantsAnySlowed ||
    targetWantsReverb ||
    targetWantsSpedUp ||
    targetWantsInstrumental ||
    targetWants8d ||
    targetWantsBassBoost ||
    targetWantsRemix ||
    targetWantsLive ||
    targetWantsAcoustic ||
    targetWantsCover;

  // Normalize strings for artist/title/album matching
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const compactNorm = (s: string) => norm(s).replace(/\s+/g, '');

  const targetTitleLower = cleanTitle.toLowerCase();
  const artistLower = cleanArtist.toLowerCase();
  const artistNorm = norm(cleanArtist);
  const artistCompact = compactNorm(cleanArtist);
  const primaryArtistRaw = cleanArtist.split(/[,&/;]|\s+(?:feat\.?|ft\.?|with)\s+/i)[0] || cleanArtist;
  const primaryArtistNorm = norm(primaryArtistRaw);
  const primaryArtistCompact = compactNorm(primaryArtistRaw);
  const primaryArtistWords = primaryArtistNorm.split(' ').filter(w => w.length >= 2);
  const albumNorm = isUsefulAlbum ? norm(cleanAlbum) : '';
  const albumCompact = isUsefulAlbum ? compactNorm(cleanAlbum) : '';

  const targetCleanNorm = norm(cleanTitleBase || cleanTitleNoFeat || cleanTitle);
  const targetWords = targetCleanNorm.split(' ').filter(w => w.length > 1);
  const queryTitle = cleanTitleBase || cleanTitleNoFeat || cleanTitle;

  const analyzeCandidateMeta = (item: any) => {
    const tl = (item.title || '').toLowerCase();
    const cl = (item.channel || item.uploader || '').toLowerCase();
    const dl = (item.description || '').toLowerCase();
    const dlHeader = dl.split('\n').slice(0, 4).join(' ').slice(0, 260);
    const dur = Number(item.duration) || 0;
    const diff = targetSec > 0 && dur > 0 ? Math.abs(dur - targetSec) : 0;

    const candidateTitleNorm = norm(item.title || '');
    const matchingWords = targetWords.filter(w => candidateTitleNorm.includes(w));
    const wordMatchRatio = targetWords.length > 0 ? (matchingWords.length / targetWords.length) : 1;

    const clNorm = norm(cl);
    const clCompact = compactNorm(cl);
    const tlNorm = norm(tl);
    const dlNorm = norm(dl);
    const tlCompact = compactNorm(tl);
    const dlCompact = compactNorm(dl);

    const isArtistChannel = Boolean(
      (artistLower && cl.includes(artistLower)) ||
      (artistLower.length > 4 && cl.startsWith(artistLower)) ||
      (artistCompact.length >= 4 && clCompact.includes(artistCompact)) ||
      (primaryArtistCompact.length >= 4 && clCompact.includes(primaryArtistCompact)) ||
      (primaryArtistWords.length >= 2 && primaryArtistWords.every(w => clNorm.includes(w)))
    );

    const hasArtistMention = Boolean(
      isArtistChannel ||
      (artistNorm && (tlNorm.includes(artistNorm) || dlNorm.includes(artistNorm))) ||
      (primaryArtistNorm.length >= 3 && (tlNorm.includes(primaryArtistNorm) || dlNorm.includes(primaryArtistNorm))) ||
      (primaryArtistCompact.length >= 4 && (tlCompact.includes(primaryArtistCompact) || dlCompact.includes(primaryArtistCompact))) ||
      (primaryArtistWords.length >= 2 && (
        primaryArtistWords.every(w => tlNorm.includes(w)) ||
        primaryArtistWords.every(w => dlNorm.includes(w))
      ))
    );

    const isTopic = cl.includes('topic');
    const isProvidedToYouTube = dl.includes('provided to youtube') || dl.includes('auto-generated by youtube');

    const candUltraSlowed = hasUltraSlowed(tl);
    const candSuperSlowed = !candUltraSlowed && hasSuperSlowed(tl);
    const candAnySlowed = hasAnySlowed(tl);
    const candReverb = hasReverb(tl);
    const candSpedUp = hasSpedUp(tl);
    const candInstrumental = hasInstrumental(tl);
    const cand8d = has8d(tl);
    const candBassBoost = hasBassBoost(tl);
    const candRemix = hasRemix(tl);
    const candLive = hasLive(tl) || hasLive(dlHeader) || reLiveInDesc.test(dl);
    const candAcoustic = hasAcoustic(tl) || hasAcoustic(dlHeader);
    const candCover = hasCover(tl) || hasCover(dlHeader);

    const hasUnwantedVariant =
      (!targetWantsLive && candLive) ||
      (!targetWantsAcoustic && candAcoustic) ||
      (!targetWantsCover && candCover) ||
      (!targetWantsRemix && candRemix) ||
      (!targetWantsInstrumental && candInstrumental) ||
      (!targetWantsAnySlowed && candAnySlowed) ||
      (!targetWantsSpedUp && candSpedUp) ||
      (!targetWantsReverb && candReverb) ||
      (!targetWants8d && cand8d) ||
      (!targetWantsBassBoost && candBassBoost);

    return {
      tl, cl, dl, dur, diff,
      candidateTitleNorm, wordMatchRatio,
      tlNorm, dlNorm, tlCompact, dlCompact,
      isArtistChannel, hasArtistMention, isTopic, isProvidedToYouTube,
      candUltraSlowed, candSuperSlowed, candAnySlowed, candReverb, candSpedUp,
      candInstrumental, cand8d, candBassBoost, candRemix, candLive, candAcoustic, candCover,
      hasUnwantedVariant
    };
  };

  try {
    const rawItems: any[] = [];

    if (targetHasVariant) {
      // Variant tracks (Slowed, Super Slowed, Sped Up, Remix, Instrumental, etc.):
      // Query the exact variant title directly first so Topic/Official Audio doesn't shadow it with the normal version
      const vq1 = `ytsearch8:${cleanArtist} - ${cleanTitleNoFeat || cleanTitle}`;
      const resV1 = await fetchCandidates(vq1);
      rawItems.push(...resV1);

      const vq2 = `ytsearch6:${cleanArtist} ${cleanTitleNoFeat || cleanTitle} audio`;
      const resV2 = await fetchCandidates(vq2);
      rawItems.push(...resV2);
    } else {
      // Stage 1: Explicit Topic query (direct targets for Warner, Sony, Believe, Universal, Symphonic, etc.)
      const tq1 = `ytsearch6:${cleanArtist} ${queryTitle} Topic`;
      const res1 = await fetchCandidates(tq1);
      rawItems.push(...res1);

      // Check if we found an indisputable clean studio match from the Topic query
      const hasDistributorStudioMatch = res1.some(it => {
        if (!it?.id || options?.excludeVideoIds?.has(String(it.id))) return false;
        const m = analyzeCandidateMeta(it);
        const isVerified = m.isTopic || m.isProvidedToYouTube || (m.isArtistChannel && (m.tl.includes('audio') || m.tl.includes('visualizer')));
        if (!isVerified) return false;
        if (m.hasUnwantedVariant || m.wordMatchRatio < 0.6 || !m.hasArtistMention) return false;
        if (targetSec > 0 && m.dur > 0 && m.diff > 25) return false;
        return true;
      });

      // Stage 2: If no clean studio master found yet, query Official Audio
      if (!hasDistributorStudioMatch) {
        const tq2 = `ytsearch6:${cleanArtist} ${queryTitle} (Official Audio)`;
        const res2 = await fetchCandidates(tq2);
        rawItems.push(...res2);
      }

      // Stage 2b: Album-targeted query when album is known and no clean studio match was found
      if (isUsefulAlbum && !hasDistributorStudioMatch) {
        const tqAlbum = `ytsearch5:${cleanArtist} ${queryTitle} ${cleanAlbum}`;
        const resAlbum = await fetchCandidates(tqAlbum);
        rawItems.push(...resAlbum);
      }

      // Stage 3: Fallback Audio search if nothing found or all candidates are excluded
      const hasNonExcluded = rawItems.some(it => it?.id && !options?.excludeVideoIds?.has(String(it.id)));
      if (rawItems.length === 0 || !hasNonExcluded) {
        const aq1 = `ytsearch6:${cleanArtist} - ${cleanTitle} audio`;
        const res3 = await fetchCandidates(aq1);
        rawItems.push(...res3);
      }
    }

    // Deduplicate by ID
    const seenIds = new Set<string>();
    const items: any[] = [];
    for (const it of rawItems) {
      if (it && it.id && !seenIds.has(it.id)) {
        seenIds.add(it.id);
        items.push(it);
      }
    }

    if (items.length > 0) {
      // Multilingual Stop-Lists (Russian + English)
      const CLIP_KEYWORDS = [
        'клип', 'официальный клип', 'премьера клипа', 'видеоклип',
        'official video', 'music video', 'official music video', 'clip',
        'video clip', 'short film', 'фильм', 'cinematic', '2.0'
      ];

      const JUNK_KEYWORDS = [
        'remake', 'сниппет', 'snippet', 'отрывок', 'тизер', 'teaser',
        'реакция', 'reaction', 'parody', 'пародия'
      ];

      const stripArtistAndTags = (raw: string): string => {
        let s = raw.toLowerCase()
          .replace(/\s*[\(\[]\s*(?:official\s*(?:audio|music\s*video|video|lyric\s*video|visualizer)|audio|аудио|visualizer|hq|hd|4k|lyrics?|текст|remaster(?:ed)?(?:\s*\d{4})?|\d{4}\s*remaster(?:ed)?)\s*[\)\]]/gi, ' ')
          .replace(/\s*[-–—]\s*(?:official\s*audio|audio|remaster(?:ed)?(?:\s*\d{4})?)\s*$/gi, ' ')
          .trim();
        const n = norm(s);
        if (artistNorm && n.startsWith(artistNorm + ' ')) {
          return n.slice(artistNorm.length).trim();
        }
        if (primaryArtistNorm && n.startsWith(primaryArtistNorm + ' ')) {
          return n.slice(primaryArtistNorm.length).trim();
        }
        return n;
      };

      let bestItem: any = null;
      let bestScore = -99999;

      for (const item of items) {
        const m = analyzeCandidateMeta(item);
        const {
          tl, cl, dl, dur, diff,
          candidateTitleNorm, wordMatchRatio,
          tlNorm, dlNorm, tlCompact, dlCompact,
          isArtistChannel, hasArtistMention, isTopic, isProvidedToYouTube,
          candUltraSlowed, candSuperSlowed, candAnySlowed, candReverb, candSpedUp,
          candInstrumental, cand8d, candBassBoost, candRemix, candLive, candAcoustic, candCover,
          hasUnwantedVariant
        } = m;

        let score = 0;

        // Hard exclusion for explicitly rejected video IDs (e.g. previous bad download on Replace with Studio Master)
        if (options?.excludeVideoIds?.has(String(item.id))) {
          score -= 5000;
        }

        // MANDATORY: Track Title Matching
        // Prevents picking a completely different track by the same artist (e.g. "Down" instead of "10 Seconds from Panic")
        const strippedTitleNorm = stripArtistAndTags(item.title || '');
        if (wordMatchRatio < 0.6) {
          score -= 1500;
        } else if (candidateTitleNorm === targetCleanNorm || strippedTitleNorm === targetCleanNorm) {
          // Exact title match (Topic track or "<Artist> - <Title> (Official Audio)")
          score += 300;
        } else {
          score += 150;
        }

        // 1. YouTube Topic / Label Distributor Studio Master: +500 to +650 points
        // Guarded: NEVER award studio master bonus to unwanted Live/Acoustic/Cover/Remix releases or mismatched artists!
        const isGenericTopicChannel = /^(?:release|various artists)\s*-\s*topic$/i.test(cl);
        const hasConflictingArtistMeta = !hasArtistMention && (dl.length > 20 || (isTopic && !isGenericTopicChannel));
        if (!hasUnwantedVariant) {
          if (hasArtistMention) {
            if (isProvidedToYouTube) score += 650;
            else if (isTopic) score += 500;
          } else if (hasConflictingArtistMeta) {
            score -= 700;
          } else if (isProvidedToYouTube) {
            score += 150;
          }
        }

        // 2. Official Artist channel: +250 points
        if (isArtistChannel) score += 250;

        // 3. Audio & Visualizer markers
        if (tl.includes('official audio')) score += 200;
        else if (tl.includes('audio') || tl.includes('аудио')) score += 100;
        else if (tl.includes('official visualizer') || tl.includes('visualizer')) score += 80;

        // 3b. Album match bonus (helps pick original album studio version over compilation/live releases)
        if (isUsefulAlbum && (
          (albumNorm && (dlNorm.includes(albumNorm) || tlNorm.includes(albumNorm))) ||
          (albumCompact.length >= 4 && (dlCompact.includes(albumCompact) || tlCompact.includes(albumCompact)))
        )) {
          score += 180;
        }

        // 4. Music video penalty (dialogue, ambient noises, intro cutscenes)
        if (CLIP_KEYWORDS.some(k => tl.includes(k))) {
          score -= 300;
        }

        // 5. Bidirectional Variant Matching (Slowed, Super Slowed, Ultra Slowed, Reverb, Sped Up, Instrumental, 8D, Bass, Remix, Live, Acoustic, Cover)
        // Slowed hierarchy: Ultra/Mega Slowed vs Super Slowed vs Slowed vs Normal
        if (targetWantsUltraSlowed) {
          if (candUltraSlowed) score += 600;
          else if (candAnySlowed) score -= 250;
          else score -= 900;
        } else if (targetWantsSuperSlowed) {
          if (candSuperSlowed) score += 600;
          else if (candUltraSlowed) score -= 300;
          else if (candAnySlowed) score -= 250;
          else score -= 900;
        } else if (targetWantsSlowed) {
          if (candAnySlowed && !candSuperSlowed && !candUltraSlowed) score += 550;
          else if (candSuperSlowed || candUltraSlowed) score -= 450;
          else score -= 900;
        } else if (candAnySlowed) {
          score -= 600;
        }

        // Reverb
        if (targetWantsReverb) {
          score += candReverb ? 350 : -400;
        } else if (candReverb) {
          score -= 500;
        }

        // Sped Up / Speed Up / Nightcore
        if (targetWantsSpedUp) {
          score += candSpedUp ? 550 : -900;
        } else if (candSpedUp) {
          score -= 600;
        }

        // Instrumental / Karaoke / Minus
        if (targetWantsInstrumental) {
          score += candInstrumental ? 550 : -900;
        } else if (candInstrumental) {
          score -= 600;
        }

        // 8D & Bass Boost
        if (targetWants8d) {
          score += cand8d ? 500 : -800;
        } else if (cand8d) {
          score -= 500;
        }

        if (targetWantsBassBoost) {
          score += candBassBoost ? 500 : -800;
        } else if (candBassBoost) {
          score -= 500;
        }

        // Remix
        if (targetWantsRemix) {
          score += candRemix ? 400 : -700;
        } else if (candRemix) {
          score -= 650;
        }

        // Live / Acoustic / Cover
        if (targetWantsLive) {
          score += candLive ? 400 : -650;
        } else if (targetWantsAcoustic) {
          score += candAcoustic ? 400 : -650;
        } else if (candLive || candAcoustic) {
          score -= 850;
        }

        if (targetWantsCover) {
          score += candCover ? 400 : -650;
        } else if (candCover) {
          score -= 850;
        }

        // Junk / Snippet / TikTok edits (unless explicitly in target title)
        if (!targetTitleLower.includes('tiktok') && !targetTitleLower.includes('тикток') && (tl.includes('tiktok') || tl.includes('тикток'))) {
          score -= 350;
        }
        if (JUNK_KEYWORDS.some(k => tl.includes(k))) {
          score -= 350;
        }

        // 7. Lyrics penalty on unofficial channels (prevents choosing amateur movie maker rips)
        if ((tl.includes('lyrics') || tl.includes('со словами') || tl.includes('текст')) && !isTopic && !isArtistChannel && !isProvidedToYouTube) {
          score -= 200;
        }

        // 8. Duration alignment:
        // Verified studio tracks (Topic, Provided to YouTube, or official artist audio) get wide tolerance for streaming outro silence differences
        const isVerifiedStudio = !hasUnwantedVariant && hasArtistMention && (
          isTopic || isProvidedToYouTube || (isArtistChannel && (tl.includes('audio') || tl.includes('visualizer')))
        );
        if (targetSec > 0 && dur > 0) {
          if (isVerifiedStudio) {
            if (diff <= 5) score += 60;
            else if (diff <= 15) score += 40;
            else if (diff <= 25) score += 10;
            else if (diff > 120) score -= 450;
            else if (diff > 60) score -= 250;
            else score -= 100;
          } else {
            if (diff <= 2) score += 40;
            else if (diff <= 5) score += 20;
            else if (diff <= 10) score += 5;
            else if (diff > 120) score -= 450;
            else if (diff > 60) score -= 250;
            else if (diff > 25) score -= 120;
            else score -= 80;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestItem = item;
        }
      }

      const selected = bestItem || items[0];
      if (selected?.id && /^[a-zA-Z0-9_-]{6,20}$/.test(String(selected.id))) {
        if (options?.excludeVideoIds?.has(String(selected.id))) {
          console.warn(`[Studio Audio Match] "${cleanArtist} - ${cleanTitle}": only excluded candidate ${selected.id} matched; falling back to search query.`);
          return `ytsearch1:${cleanArtist} - ${queryTitle} studio audio`;
        }
        console.log(`[Studio Audio Match] "${cleanArtist} - ${cleanTitle}": selected ${selected.id} ("${selected.title}", channel="${selected.channel || selected.uploader}", diff=${targetSec > 0 && selected.duration ? Math.abs(selected.duration - targetSec) : 0}s, score=${bestScore})`);
        const resultUrl = `https://www.youtube.com/watch?v=${selected.id}`;
        if (studioCandidateCache.size > 2000) {
          const now = Date.now();
          for (const [k, v] of studioCandidateCache.entries()) {
            if (now - v.cachedAt > CANDIDATE_CACHE_TTL_MS) {
              studioCandidateCache.delete(k);
            }
          }
          if (studioCandidateCache.size > 2000) {
            let toRemove = studioCandidateCache.size - 1600;
            for (const k of studioCandidateCache.keys()) {
              studioCandidateCache.delete(k);
              if (--toRemove <= 0) break;
            }
          }
        }
        studioCandidateCache.set(cacheKey, { url: resultUrl, cachedAt: Date.now() });
        return resultUrl;
      }
    }
  } catch (err: any) {
    console.warn('[Studio Audio Search Fallback]:', err.message);
  }

  return `ytsearch1:${cleanArtist} - ${cleanTitle}`;
}

async function executeYtDlpMp3Download(
  sourceUrl: string,
  outputTemplate: string,
  targetDir: string,
  safeTitle: string,
  timeoutMs: number,
  lowCpuPriority: boolean
): Promise<{ ok: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    let isSettled = false;
    const finish = (ok: boolean, timedOut: boolean = false) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        resolve({ ok, timedOut });
      }
    };

    const nodePath = process.execPath || '/usr/local/bin/node';
    const ytDlpArgs = [
      '--js-runtimes', `node:${nodePath}`,
      '--concurrent-fragments', '4',
      '--buffer-size', '16M',
      '--no-mtime',
      '--socket-timeout', '15',
      '--extractor-retries', '3',
      '--force-overwrites',
      '--no-continue',
      '-f', 'bestaudio[acodec=opus]/bestaudio/best',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '320k',
      '--postprocessor-args', 'ExtractAudio:-af volume=-0.5dB -ar 48000 -compression_level 2',
      '--embed-thumbnail',
      '--add-metadata',
      '-o', outputTemplate
    ];

    // Only pass --no-playlist when NOT running a ytsearch query (yt-dlp treats search as a playlist!)
    if (!sourceUrl.startsWith('ytsearch')) {
      ytDlpArgs.push('--no-playlist');
    }

    ytDlpArgs.push('--', sourceUrl);

    const cmd = lowCpuPriority ? 'nice' : 'yt-dlp';
    const args = lowCpuPriority ? ['-n', '19', 'ionice', '-c', '3', 'yt-dlp', ...ytDlpArgs] : ytDlpArgs;

    let stderrOutput = '';
    const proc = spawn(cmd, args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    proc.stderr?.on('data', d => {
      stderrOutput = (stderrOutput + d.toString()).slice(-600);
    });

    const timer = setTimeout(() => {
      console.warn(`[yt-dlp timeout] "${safeTitle}" timed out after ${Math.round(timeoutMs / 1000)}s. Killing process tree.`);
      killProcessGroup(proc, 'SIGKILL');
      cleanupPartialFiles(targetDir, safeTitle);
      finish(false, true);
    }, timeoutMs);

    proc.on('close', (code) => {
      const found = resolveAudioFilePath(targetDir, safeTitle);
      if (code === 0 && found && fs.existsSync(found)) {
        finish(true, false);
      } else {
        if (stderrOutput) {
          console.warn(`[yt-dlp error] "${safeTitle}" (exit code ${code}):`, stderrOutput.trim());
        }
        cleanupPartialFiles(targetDir, safeTitle);
        finish(false, false);
      }
    });

    proc.on('error', (err: any) => {
      console.warn(`[yt-dlp spawn error] "${safeTitle}":`, err?.message || err);
      cleanupPartialFiles(targetDir, safeTitle);
      finish(false, false);
    });
  });
}

async function downloadAudioWithFallback(
  artist: string,
  title: string,
  durationMs: number | undefined,
  outputTemplate: string,
  targetDir: string,
  safeTitle: string,
  timeoutMs: number,
  lowCpuPriority: boolean,
  bypassCache: boolean = false,
  searchOptions?: StudioSearchOptions
): Promise<boolean> {
  const primaryUrl = await findBestStudioAudioSource(artist, title, durationMs, bypassCache, searchOptions);
  const firstAttempt = await executeYtDlpMp3Download(
    primaryUrl,
    outputTemplate,
    targetDir,
    safeTitle,
    timeoutMs,
    lowCpuPriority
  );
  if (firstAttempt.ok) return true;

  // If primary source failed (and didn't hard-timeout), retry once via clean ytsearch fallback
  const cleanArtist = (artist || '').replace(/[∅Ø]/g, 'O').replace(/^[- \t]+/, '').replace(/[\\/:*?"<>|]/g, ' ').trim();
  const cleanTitle = (title || '').replace(/[∅Ø]/g, 'O').replace(/^[- \t]+/, '').replace(/[\\/:*?"<>|]/g, ' ').trim();
  const fallbackQuery = searchOptions?.excludeVideoIds?.size
    ? `ytsearch1:${cleanArtist} - ${cleanTitle} studio audio`
    : `ytsearch1:${cleanArtist} - ${cleanTitle}`;

  if (!firstAttempt.timedOut && primaryUrl !== fallbackQuery) {
    console.warn(`[yt-dlp retry] Primary source ${primaryUrl} failed for "${artist} - ${title}". Retrying with search fallback...`);
    const secondAttempt = await executeYtDlpMp3Download(
      fallbackQuery,
      outputTemplate,
      targetDir,
      safeTitle,
      timeoutMs,
      lowCpuPriority
    );
    return secondAttempt.ok;
  }

  return false;
}

interface SingleDownloadResult {
  success: boolean;
  track?: any;
  error?: string;
  addedToPlaylist?: boolean;
  liked?: boolean;
  downloading?: boolean;
}

const inFlightSingleDownloads = new Map<string, Promise<SingleDownloadResult>>();

async function downloadSingleTrack(item: QueueItem): Promise<void> {
  const { jobId, playlistId, track, position } = item;

  if (/https?:\/\//i.test(track.title) || /https?:\/\//i.test(track.artist)) {
    console.warn(`[Downloader] Skipping invalid URL-as-title track "${track.artist} - ${track.title}"`);
    return;
  }

  // Resolve real individual track details (cover + real album) from Spotify / Deezer
  const details = await resolveSpotifyTrackDetails(track.id);
  if (details.cover_url && (!track.cover_url || track.cover_url.includes('mosaic.scdn.co'))) {
    track.cover_url = String(details.cover_url).slice(0, 2048);
  }
  if (details.album) {
    track.album = String(details.album).slice(0, 200);
  }
  if (details.artist && (!track.artist || track.artist === 'Unknown Artist')) {
    track.artist = String(details.artist).slice(0, 200);
  }

  if (!track.cover_url || !track.album) {
    try {
      const dz = await resolveDeezerTrackInfo(track.artist, track.title);
      if (dz.cover_url && (!track.cover_url || track.cover_url.includes('mosaic.scdn.co'))) {
        track.cover_url = String(dz.cover_url).slice(0, 2048);
      }
      if (dz.album && !track.album) {
        track.album = String(dz.album).slice(0, 200);
      }
      if (dz.duration && (!track.duration_ms || track.duration_ms <= 0)) {
        track.duration_ms = dz.duration * 1000;
      }
    } catch (_) {}
  }

  // Check if track already exists locally in DB AND file actually exists on disk
  const existing = db.prepare(`
    SELECT * FROM tracks 
    WHERE (spotify_id IS NOT NULL AND spotify_id = ?) 
       OR (LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?))
    LIMIT 1
  `).get(track.id || null, track.title, track.artist) as any;

  if (existing && existing.file_path && isPathInsideMusicDir(existing.file_path) && fs.existsSync(existing.file_path)) {
    // If existing track had missing or playlist fallback album/cover, update it
    if (details.album && (!existing.album || existing.album === 'Любимые треки' || existing.album === '-')) {
      db.prepare('UPDATE tracks SET album = ? WHERE id = ?').run(String(details.album).slice(0, 200), existing.id);
    }
    if (details.cover_url && (!existing.cover_url || existing.cover_url.includes('mosaic.scdn.co'))) {
      db.prepare('UPDATE tracks SET cover_url = ? WHERE id = ?').run(String(details.cover_url).slice(0, 2048), existing.id);
    }

    // Opportunistically queue quality upgrade in background if legacy .m4a or low bitrate
    queueTrackQualityUpgrade(existing);

    // Check blacklist before linking to playlist or liked_tracks
    if (isTrackBlacklistedForUser(item.userId, details.title || track.title, details.artist || track.artist, track.id)) {
      console.log(`[Downloader] Skipping blacklisted existing track "${track.artist} - ${track.title}" for user ${item.userId}`);
      return;
    }

    // Already downloaded: link to playlist or liked_tracks (verify user/playlist still exists)
    if (item.isLikedOnly || !playlistId) {
      const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(item.userId);
      if (userExists) {
        db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(item.userId, existing.id);
        broadcastToUser(item.userId, { type: 'LIKES_UPDATED', trackId: existing.id, liked: true });
      }
    } else {
      const plExists = db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(playlistId);
      if (plExists) {
        db.prepare(`
          INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
          VALUES (?, ?, ?)
        `).run(playlistId, existing.id, position);
      }
    }

    const doneCount = playlistId
      ? (db.prepare('SELECT COUNT(*) as cnt FROM playlist_tracks WHERE playlist_id = ?').get(playlistId) as any)?.cnt || 0
      : (db.prepare('SELECT COUNT(*) as cnt FROM liked_tracks WHERE user_id = ?').get(item.userId) as any)?.cnt || 0;

    db.prepare(`
      UPDATE download_jobs
      SET downloaded_tracks = ?, current_track = ?
      WHERE id = ?
    `).run(doneCount, `${track.artist} - ${track.title}`, jobId);
    return;
  }

  const downloadKey = (track.id || `${track.artist}:::${track.title}`).toLowerCase();

  // If another process (direct download or worker) is already downloading this track, wait for it!
  if (inFlightSingleDownloads.has(downloadKey)) {
    console.log(`[Downloader Worker] In-flight download detected for "${track.artist} - ${track.title}", waiting...`);
    try {
      await inFlightSingleDownloads.get(downloadKey);
    } catch (_) {}

    const reExisting: any = db.prepare(`
      SELECT * FROM tracks 
      WHERE (spotify_id IS NOT NULL AND spotify_id = ?) 
         OR (LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?))
      LIMIT 1
    `).get(track.id || null, track.title, track.artist);

    if (reExisting && reExisting.file_path && isPathInsideMusicDir(reExisting.file_path) && fs.existsSync(reExisting.file_path)) {
      if (isTrackBlacklistedForUser(item.userId, details.title || track.title, details.artist || track.artist, track.id)) {
        return;
      }
      if (item.isLikedOnly || !playlistId) {
        const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(item.userId);
        if (userExists) {
          db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(item.userId, reExisting.id);
          broadcastToUser(item.userId, { type: 'LIKES_UPDATED', trackId: reExisting.id, liked: true });
        }
      } else {
        const plExists = db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(playlistId);
        if (plExists) {
          db.prepare(`
            INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
            VALUES (?, ?, ?)
          `).run(playlistId, reExisting.id, position);
        }
      }

      const doneCount = playlistId
        ? (db.prepare('SELECT COUNT(*) as cnt FROM playlist_tracks WHERE playlist_id = ?').get(playlistId) as any)?.cnt || 0
        : (db.prepare('SELECT COUNT(*) as cnt FROM liked_tracks WHERE user_id = ?').get(item.userId) as any)?.cnt || 0;

      db.prepare(`
        UPDATE download_jobs
        SET downloaded_tracks = ?, current_track = ?
        WHERE id = ?
      `).run(doneCount, `${track.artist} - ${track.title}`, jobId);
      return;
    }
  }

  let workerResolve!: (res: SingleDownloadResult) => void;
  const workerDownloadPromise = new Promise<SingleDownloadResult>((resolve) => {
    workerResolve = resolve;
  });
  inFlightSingleDownloads.set(downloadKey, workerDownloadPromise);

  try {
    // Update status in DB
    db.prepare(`
      UPDATE download_jobs
      SET current_track = ?, status = 'downloading'
      WHERE id = ?
    `).run(`${track.artist} - ${track.title}`, jobId);

    // Prepare destination dir
    const targetDir = getSafeArtistDir(track.artist || 'Unknown Artist');
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const safeTitle = sanitizeFilename(track.title);
    const outputTemplate = path.join(targetDir, `${safeTitle}.%(ext)s`);

    const downloadedOk = await runWithPrioritySlot(
      DownloadPriority.NORMAL,
      `worker:${track.artist} - ${track.title}`,
      async () => {
        // Re-check if file appeared while waiting for download slot
        const existingCandidate = resolveAudioFilePath(targetDir, safeTitle);
        if (existingCandidate && fs.existsSync(existingCandidate)) {
          const probe = await probeAudioFile(existingCandidate, track.duration_ms);
          if (probe.valid && probe.durationSec > 15) {
            return true;
          }
        }
        return await downloadAudioWithFallback(
          track.artist,
          track.title,
          track.duration_ms,
          outputTemplate,
          targetDir,
          safeTitle,
          120000,
          true,
          false,
          { album: track.album }
        );
      }
    );

    if (!downloadedOk) {
      console.warn(`[yt-dlp] Failed to download "${track.artist} - ${track.title}"`);
      workerResolve({ success: false, error: 'Download failed' });
      return;
    }

    // Find saved file (.mp3 preferred studio 320k, or format fallback)
    const finalFile = resolveAudioFilePath(targetDir, safeTitle) || path.join(targetDir, `${safeTitle}.mp3`);

    // Verify audio file validity & duration
    const probe = await probeAudioFile(finalFile, track.duration_ms);
    if (track.duration_ms > 30000 && probe.valid && !probe.isHighQuality && probe.reason?.includes('Обрезан')) {
      console.warn(`[yt-dlp truncated audio detected] "${track.artist} - ${track.title}": probed ${probe.durationSec}s vs expected ${track.duration_ms / 1000}s. Discarding.`);
      try { fs.unlinkSync(finalFile); } catch (_) {}
      workerResolve({ success: false, error: 'Audio truncated' });
      return;
    }

    try {
      const doubleCheck: any = db.prepare(`
        SELECT * FROM tracks 
        WHERE (spotify_id IS NOT NULL AND spotify_id = ?) 
           OR (LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?))
        LIMIT 1
      `).get(track.id || null, track.title, track.artist);

      let trackId = doubleCheck?.id;
      const actualDurationMs = (probe.valid && probe.durationSec > 0)
        ? Math.round(probe.durationSec * 1000)
        : (track.duration_ms || 180000);

      if (!trackId) {
        const info = db.prepare(`
          INSERT INTO tracks (title, artist, album, duration_ms, file_path, cover_url, spotify_id, bitrate)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          track.title,
          track.artist,
          track.album || '',
          actualDurationMs,
          finalFile,
          track.cover_url || '',
          track.id || null,
          probe.bitrateKbps || 320
        );
        trackId = info.lastInsertRowid;
      } else {
        db.prepare(`
          UPDATE tracks 
          SET file_path = ?, duration_ms = ?, bitrate = ?,
              album = CASE WHEN album IS NULL OR album = '' OR album = '-' OR album = 'Любимые треки' THEN ? ELSE album END,
              cover_url = CASE WHEN cover_url IS NULL OR cover_url = '' OR cover_url LIKE '%mosaic.scdn.co%' THEN ? ELSE cover_url END
          WHERE id = ?
        `).run(finalFile, actualDurationMs, probe.bitrateKbps || 320, track.album || '', track.cover_url || '', trackId);
      }

      const freshTrack: any = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId);
      invalidateTrackStreamMeta(Number(trackId));
      invalidateTranscodeCacheForTrack(Number(trackId)).catch(() => {});
      workerResolve({ success: true, track: freshTrack });
      broadcastToAll({ type: 'TRACK_UPDATED', track: sanitizeTrackRecord(freshTrack) });

      if (isTrackBlacklistedForUser(item.userId, details.title || track.title, details.artist || track.artist, track.id)) {
        console.log(`[Downloader] Track "${track.artist} - ${track.title}" was blacklisted during download. Skipping playlist link.`);
      } else if (item.isLikedOnly || !playlistId) {
        const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(item.userId);
        if (userExists) {
          db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(item.userId, trackId);
          broadcastToUser(item.userId, { type: 'LIKES_UPDATED', trackId, liked: true });
        }
      } else {
        const plExists = db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(playlistId);
        if (plExists) {
          db.prepare(`
            INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
            VALUES (?, ?, ?)
          `).run(playlistId, trackId, position);
        }
      }

      const doneCount = playlistId
        ? (db.prepare('SELECT COUNT(*) as cnt FROM playlist_tracks WHERE playlist_id = ?').get(playlistId) as any)?.cnt || 0
        : (db.prepare('SELECT COUNT(*) as cnt FROM liked_tracks WHERE user_id = ?').get(item.userId) as any)?.cnt || 0;

      db.prepare(`
        UPDATE download_jobs
        SET downloaded_tracks = ?
        WHERE id = ?
      `).run(doneCount, jobId);
    } catch (dbErr: any) {
      console.error('[DB Insert Error after download]', dbErr.message);
      workerResolve({ success: false, error: dbErr.message });
    }
  } catch (err: any) {
    workerResolve({ success: false, error: err.message });
  } finally {
    inFlightSingleDownloads.delete(downloadKey);
  }
}

export async function downloadSingleSpotifyTrackDirect(
  track: SpotifyTrack,
  userId?: number,
  playlistId?: number,
  isLikedOnly?: boolean
): Promise<SingleDownloadResult> {
  const downloadKey = (track.id || `${track.artist}:::${track.title}`).toLowerCase();
  if (inFlightSingleDownloads.has(downloadKey)) {
    const result = await inFlightSingleDownloads.get(downloadKey)!;
    if (result.success && result.track) {
      if (userId && isTrackBlacklistedForUser(userId, result.track.title, result.track.artist, result.track.spotify_id || track.id)) {
        return { ...result, track: sanitizeTrackRecord(result.track), addedToPlaylist: false, liked: false };
      }
      if (isLikedOnly || playlistId === -1) {
        if (userId) {
          const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
          if (userExists) {
            db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(userId, result.track.id);
          }
        }
        return { ...result, track: sanitizeTrackRecord(result.track), liked: true };
      }
      if (playlistId) {
        if (userId) {
          const ownsPlaylist = db.prepare('SELECT 1 FROM playlists WHERE id = ? AND user_id = ? AND COALESCE(is_daily_mix, 0) = 0').get(playlistId, userId);
          if (!ownsPlaylist) return { ...result, track: sanitizeTrackRecord(result.track) };
        } else {
          const plExists = db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(playlistId);
          if (!plExists) return { ...result, track: sanitizeTrackRecord(result.track) };
        }
        const inPl: any = db.prepare('SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').get(playlistId, result.track.id);
        if (!inPl) {
          const maxPosRow: any = db.prepare('SELECT MAX(position) as maxPos FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
          const nextPos = (maxPosRow?.maxPos !== null && maxPosRow?.maxPos !== undefined) ? maxPosRow.maxPos + 1 : 0;
          db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)').run(playlistId, result.track.id, nextPos);
        }
        return { ...result, track: sanitizeTrackRecord(result.track), addedToPlaylist: true };
      }
      return { ...result, track: sanitizeTrackRecord(result.track) };
    }
    return result;
  }

  const promise = downloadSingleSpotifyTrackDirectInternal(track, userId, playlistId, isLikedOnly);
  inFlightSingleDownloads.set(downloadKey, promise);
  try {
    return await promise;
  } finally {
    inFlightSingleDownloads.delete(downloadKey);
  }
}

const inFlightTrackIdDownloads = new Set<number>();
const pendingTrackNotifyUsers = new Map<number, Set<number>>();

async function downloadSingleSpotifyTrackDirectInternal(
  track: SpotifyTrack,
  userId?: number,
  playlistId?: number,
  isLikedOnly?: boolean
): Promise<{ success: boolean; track?: any; error?: string; addedToPlaylist?: boolean; liked?: boolean; downloading?: boolean }> {
  try {
    // Helper to attach to playlist or liked tracks
    const attachToPlaylist = (trackRecord: any) => {
      if (!trackRecord?.id) return;
      if (userId && isTrackBlacklistedForUser(userId, trackRecord.title || track.title, trackRecord.artist || track.artist, trackRecord.spotify_id || track.id)) {
        console.log(`[Downloader] Skipping attach: track "${track.artist} - ${track.title}" is blacklisted for user ${userId}`);
        return;
      }
      if (isLikedOnly || playlistId === -1) {
        if (userId) {
          const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
          if (userExists) {
            db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(userId, trackRecord.id);
            broadcastToUser(userId, { type: 'LIKES_UPDATED', trackId: trackRecord.id, liked: true });
          }
        }
        return;
      }
      if (!playlistId) return;
      if (userId) {
        const ownsPlaylist = db.prepare('SELECT 1 FROM playlists WHERE id = ? AND user_id = ? AND COALESCE(is_daily_mix, 0) = 0').get(playlistId, userId);
        if (!ownsPlaylist) return;
      } else {
        const plExists = db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(playlistId);
        if (!plExists) return;
      }
      const inPl: any = db.prepare('SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').get(playlistId, trackRecord.id);
      if (!inPl) {
        const maxPosRow: any = db.prepare('SELECT MAX(position) as maxPos FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
        const nextPos = (maxPosRow?.maxPos !== null && maxPosRow?.maxPos !== undefined) ? maxPosRow.maxPos + 1 : 0;
        db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)').run(playlistId, trackRecord.id, nextPos);
      }
      const playlistRow: any = db.prepare('SELECT name FROM playlists WHERE id = ?').get(playlistId);
      if (playlistRow && (playlistRow.name === 'Любимые треки' || playlistRow.name.toLowerCase() === 'liked songs')) {
        if (userId) {
          const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
          if (userExists) {
            db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(userId, trackRecord.id);
            broadcastToUser(userId, { type: 'LIKES_UPDATED', trackId: trackRecord.id, liked: true });
          }
        }
      }
    };

    // 1. Check if already exists in DB
    let existing: any = db.prepare(`
      SELECT * FROM tracks 
      WHERE (spotify_id IS NOT NULL AND spotify_id = ?) 
         OR (LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?))
      LIMIT 1
    `).get(track.id || null, track.title, track.artist);

    if (existing && existing.file_path && isPathInsideMusicDir(existing.file_path) && fs.existsSync(existing.file_path)) {
      attachToPlaylist(existing);
      queueTrackQualityUpgrade(existing);
      return {
        success: true,
        track: sanitizeTrackRecord(existing),
        addedToPlaylist: !!playlistId && playlistId !== -1,
        liked: Boolean(isLikedOnly || playlistId === -1)
      };
    }

    // 2. Immediately create pending DB record if it doesn't exist yet, attach to playlist right away, and return!
    if (!existing) {
      const info = db.prepare(`
        INSERT INTO tracks (title, artist, album, duration_ms, file_path, cover_url, spotify_id, bitrate)
        VALUES (?, ?, ?, ?, '', ?, ?, NULL)
      `).run(
        track.title,
        track.artist,
        track.album || '',
        track.duration_ms || 180000,
        track.cover_url || '',
        track.id || null
      );
      existing = db.prepare('SELECT * FROM tracks WHERE id = ?').get(info.lastInsertRowid);
    }

    attachToPlaylist(existing);
    if (userId && playlistId && playlistId !== -1) {
      broadcastToUser(userId, { type: 'PLAYLIST_UPDATED', playlistId });
    }

    const pendingTrackId = Number(existing.id);
    if (userId) {
      let recipients = pendingTrackNotifyUsers.get(pendingTrackId);
      if (!recipients) {
        recipients = new Set<number>();
        pendingTrackNotifyUsers.set(pendingTrackId, recipients);
      }
      recipients.add(userId);
    }

    // 3. Run metadata resolution + yt-dlp download asynchronously in background
    if (!inFlightTrackIdDownloads.has(pendingTrackId)) {
      inFlightTrackIdDownloads.add(pendingTrackId);
      (async () => {
        try {
          if (track.id) {
            const details = await resolveSpotifyTrackDetails(track.id);
            if (details.cover_url && (!track.cover_url || track.cover_url.includes('mosaic.scdn.co'))) {
              track.cover_url = String(details.cover_url).slice(0, 2048);
            }
            if (details.album) {
              track.album = String(details.album).slice(0, 200);
            }
            if (details.artist && (!track.artist || track.artist === 'Unknown Artist')) {
              track.artist = String(details.artist).slice(0, 200);
            }
          }

          if (!track.cover_url || !track.album) {
            try {
              const dz = await resolveDeezerTrackInfo(track.artist, track.title);
              if (dz.cover_url && (!track.cover_url || track.cover_url.includes('mosaic.scdn.co'))) {
                track.cover_url = String(dz.cover_url).slice(0, 2048);
              }
              if (dz.album && !track.album) {
                track.album = String(dz.album).slice(0, 200);
              }
              if (dz.duration && (!track.duration_ms || track.duration_ms <= 0)) {
                track.duration_ms = dz.duration * 1000;
              }
            } catch (_) {}
          }

          const targetDir = getSafeArtistDir(track.artist || 'Unknown Artist');
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }

          const safeTitle = sanitizeFilename(track.title);
          const outputTemplate = path.join(targetDir, `${safeTitle}.%(ext)s`);

          const success = await runWithPrioritySlot(
            DownloadPriority.HIGH,
            `direct:${track.artist} - ${track.title}`,
            async () => {
              const existingCandidate = resolveAudioFilePath(targetDir, safeTitle);
              if (existingCandidate && fs.existsSync(existingCandidate)) {
                const preProbe = await probeAudioFile(existingCandidate, track.duration_ms);
                if (preProbe.valid && preProbe.durationSec > 15) {
                  return true;
                }
              }

              return await downloadAudioWithFallback(
                track.artist,
                track.title,
                track.duration_ms,
                outputTemplate,
                targetDir,
                safeTitle,
                150000,
                false,
                false,
                { album: track.album }
              );
            }
          );

          if (!success) {
            console.warn(`[Download Single Track Background Failed] "${track.artist} - ${track.title}"`);
            return;
          }

          const finalFile = resolveAudioFilePath(targetDir, safeTitle) || path.join(targetDir, `${safeTitle}.mp3`);
          const probe = await probeAudioFile(finalFile, track.duration_ms);
          if (track.duration_ms > 30000 && probe.valid && !probe.isHighQuality && probe.reason?.includes('Обрезан')) {
            console.warn(`[yt-dlp single direct] Truncated audio detected for "${track.artist} - ${track.title}". Discarding.`);
            try { fs.unlinkSync(finalFile); } catch (_) {}
            return;
          }

          const actualDurationMs = (probe.valid && probe.durationSec > 0)
            ? Math.round(probe.durationSec * 1000)
            : (track.duration_ms || 180000);

          db.prepare(`
            UPDATE tracks 
            SET file_path = ?, duration_ms = ?, bitrate = ?,
                album = CASE WHEN album IS NULL OR album = '' OR album = '-' OR album = 'Любимые треки' THEN ? ELSE album END,
                cover_url = CASE WHEN cover_url IS NULL OR cover_url = '' OR cover_url LIKE '%mosaic.scdn.co%' THEN ? ELSE cover_url END
            WHERE id = ?
          `).run(finalFile, actualDurationMs, probe.bitrateKbps || 320, track.album || '', track.cover_url || '', pendingTrackId);

          const updatedTrack = db.prepare('SELECT * FROM tracks WHERE id = ?').get(pendingTrackId);
          invalidateTrackStreamMeta(pendingTrackId);
          invalidateTranscodeCacheForTrack(pendingTrackId).catch(() => {});
          await refreshJellyfinLibrary();

          const safeUpdated = sanitizeTrackRecord(updatedTrack);
          broadcastToAll({ type: 'TRACK_UPDATED', track: safeUpdated });
          const spotifyIdToNotify = (updatedTrack as any)?.spotify_id || track.id;
          if (spotifyIdToNotify) {
            const recipients = pendingTrackNotifyUsers.get(pendingTrackId);
            if (recipients) {
              for (const uid of recipients) {
                broadcastToUser(uid, {
                  type: 'INSTANT_TRACK_DOWNLOADED',
                  spotifyId: spotifyIdToNotify,
                  track: safeUpdated,
                });
              }
            }
          }
          if (userId && playlistId && playlistId !== -1) {
            broadcastToUser(userId, { type: 'PLAYLIST_UPDATED', playlistId });
          }
          console.log(`[Download Single Track] Background download completed for #${pendingTrackId}: "${track.artist} - ${track.title}"`);
        } catch (bgErr: any) {
          console.error(`[Download Single Track Background Error] #${pendingTrackId}:`, bgErr.message);
        } finally {
          inFlightTrackIdDownloads.delete(pendingTrackId);
          pendingTrackNotifyUsers.delete(pendingTrackId);
        }
      })();
    }

    return {
      success: true,
      track: sanitizeTrackRecord(existing),
      addedToPlaylist: !!playlistId && playlistId !== -1,
      liked: Boolean(isLikedOnly || playlistId === -1),
      downloading: true,
    };
  } catch (err: any) {
    console.error('[Download Single Track Error]', err);
    return { success: false, error: 'Не удалось добавить или скачать трек' };
  }
}

export interface UpgradeProgress {
  isRunning: boolean;
  total: number;
  current: number;
  currentTrack: string;
  successCount: number;
  upgradedCount: number;
  skippedCount: number;
  errorCount: number;
}

export interface QualityStats {
  total: number;
  studioCount: number;
  lowQualityCount: number;
  m4aCount: number;
  unverifiedCount: number;
  isRunning: boolean;
  progress: UpgradeProgress;
}

const upgradeProgress: UpgradeProgress = {
  isRunning: false,
  total: 0,
  current: 0,
  currentTrack: '',
  successCount: 0,
  upgradedCount: 0,
  skippedCount: 0,
  errorCount: 0
};

let shouldStopUpgrade = false;

export function getUpgradeProgress(): UpgradeProgress {
  return { ...upgradeProgress };
}

export function stopQualityUpgrade(): boolean {
  if (upgradeProgress.isRunning) {
    shouldStopUpgrade = true;
    return true;
  }
  return false;
}

/**
 * Safely downloads studio 320k 48kHz audio and atomically replaces the existing track file.
 */
export async function upgradeSingleTrackFile(tr: any): Promise<boolean> {
  const targetDir = getSafeArtistDir(tr.artist || 'Unknown Artist');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const safeTitle = sanitizeFilename(tr.title);
  const tempPrefix = `${safeTitle}.upg.${Date.now()}`;
  const tempOutputTemplate = path.join(targetDir, `${tempPrefix}.%(ext)s`);

  // Invalidate any stale cached candidate to ensure fresh search for studio upgrade
  const cleanUpgKey = `${(tr.artist || '').toLowerCase()}:::${(tr.title || '').toLowerCase()}`;
  studioCandidateCache.delete(cleanUpgKey);

  const ok = await runWithPrioritySlot(
    DownloadPriority.LOW,
    `upgrade:${tr.artist} - ${tr.title}`,
    async () => {
      return await downloadAudioWithFallback(
        tr.artist,
        tr.title,
        tr.duration_ms,
        tempOutputTemplate,
        targetDir,
        tempPrefix,
        120000,
        true,
        true,
        { album: tr.album }
      );
    }
  );

  if (!ok) {
    return false;
  }

  const tempFound = resolveAudioFilePath(targetDir, tempPrefix);
  if (!tempFound) {
    return false;
  }
  const newProbe = await probeAudioFile(tempFound, tr.duration_ms);

  if (tr.duration_ms > 45000 && newProbe.valid && !newProbe.isHighQuality && newProbe.reason?.includes('Обрезан')) {
    console.warn(`[Upgrade Quality] Downloaded file for "${tr.artist} - ${tr.title}" was truncated (${newProbe.durationSec}s). Keeping existing file.`);
    try { fs.unlinkSync(tempFound); } catch (_) {}
    return false;
  }

  // Safely and atomically replace destination file!
  const newExt = path.extname(tempFound);
  const destinationFile = path.join(targetDir, `${safeTitle}${newExt}`);
  try {
    if (tr.file_path && fs.existsSync(tr.file_path) && tr.file_path !== destinationFile && isPathInsideMusicDir(tr.file_path)) {
      fs.unlinkSync(tr.file_path);
    } else if (fs.existsSync(destinationFile) && isPathInsideMusicDir(destinationFile)) {
      fs.unlinkSync(destinationFile);
    }
    fs.renameSync(tempFound, destinationFile);
  } catch (renErr: any) {
    console.warn('[Upgrade Quality Rename Error]', renErr.message);
  }

  if (!tr.cover_url || tr.cover_url.includes('mosaic.scdn.co')) {
    try {
      const dz = await resolveDeezerTrackInfo(tr.artist, tr.title);
      if (dz.cover_url) {
        db.prepare('UPDATE tracks SET cover_url = ? WHERE id = ?').run(dz.cover_url, tr.id);
      }
    } catch (_) {}
  }
  const updatedDur = Math.round(newProbe.durationSec * 1000) || tr.duration_ms;
  const newBitrate = newProbe.bitrateKbps || 320;
  db.prepare('UPDATE tracks SET file_path = ?, duration_ms = ?, bitrate = ? WHERE id = ?').run(destinationFile, updatedDur, newBitrate, tr.id);
  invalidateTrackStreamMeta(tr.id);
  invalidateTranscodeCacheForTrack(tr.id).catch(() => {});

  broadcastToAll({
    type: 'TRACK_QUALITY_UPGRADED',
    trackId: tr.id,
    bitrate: newBitrate
  });

  return true;
}

// Opportunistic healer queue for touched tracks
const pendingUpgrades = new Set<number>();
let isSingleUpgradeProcessing = false;

export function queueTrackQualityUpgrade(track: any): void {
  if (!track || !track.id || !track.file_path) return;
  // If already confirmed high quality (MP3 and bitrate >= 250), nothing to do
  if (track.file_path && track.file_path.endsWith('.mp3') && track.bitrate && track.bitrate >= 250) {
    return;
  }
  if (pendingUpgrades.has(track.id) || upgradeProgress.isRunning) {
    return;
  }

  pendingUpgrades.add(track.id);

  setTimeout(async () => {
    try {
      if (isSingleUpgradeProcessing || upgradeProgress.isRunning) {
        pendingUpgrades.delete(track.id);
        return;
      }
      isSingleUpgradeProcessing = true;
      const probe = await probeAudioFile(track.file_path, track.duration_ms);
      if (probe.isHighQuality) {
        db.prepare('UPDATE tracks SET bitrate = ? WHERE id = ?').run(probe.bitrateKbps || 320, track.id);
      } else {
        console.log(`[Opportunistic Healer] Upgrading touched low-quality track: "${track.artist} - ${track.title}" (Reason: ${probe.reason || 'Legacy format'})`);
        await upgradeSingleTrackFile(track);
      }
    } catch (err: any) {
      console.warn(`[Opportunistic Healer Error] on track ${track.id}:`, err.message);
    } finally {
      pendingUpgrades.delete(track.id);
      isSingleUpgradeProcessing = false;
    }
  }, 1000);
}

// Background lightweight crawler to populate bitrate for unverified mp3 tracks
let isProbingUnverified = false;
export async function populateUnverifiedBitrates(): Promise<void> {
  if (isProbingUnverified || upgradeProgress.isRunning) return;
  isProbingUnverified = true;
  try {
    const unverified = db.prepare("SELECT id, file_path, duration_ms FROM tracks WHERE file_path LIKE '%.mp3' AND bitrate IS NULL LIMIT 25").all() as any[];
    for (const t of unverified) {
      if (upgradeProgress.isRunning) break;
      const probe = await probeAudioFile(t.file_path, t.duration_ms);
      if (probe.valid) {
        db.prepare('UPDATE tracks SET bitrate = ? WHERE id = ?').run(probe.bitrateKbps || (probe.isHighQuality ? 320 : 128), t.id);
      }
    }
  } catch (_) {}
  finally {
    isProbingUnverified = false;
  }
}

export function getQualityAuditStats(): QualityStats {
  const totalRow: any = db.prepare('SELECT COUNT(*) as cnt FROM tracks').get();
  const m4aRow: any = db.prepare("SELECT COUNT(*) as cnt FROM tracks WHERE file_path LIKE '%.m4a'").get();
  const studioRow: any = db.prepare("SELECT COUNT(*) as cnt FROM tracks WHERE file_path LIKE '%.mp3' AND bitrate >= 250").get();
  const lowBitrateRow: any = db.prepare("SELECT COUNT(*) as cnt FROM tracks WHERE file_path LIKE '%.mp3' AND bitrate IS NOT NULL AND bitrate < 250").get();
  const unverifiedRow: any = db.prepare("SELECT COUNT(*) as cnt FROM tracks WHERE file_path LIKE '%.mp3' AND bitrate IS NULL").get();

  const total = totalRow?.cnt || 0;
  const m4aCount = m4aRow?.cnt || 0;
  const knownLow = lowBitrateRow?.cnt || 0;
  const studioCount = studioRow?.cnt || 0;
  const unverifiedCount = unverifiedRow?.cnt || 0;

  if (unverifiedCount > 0 && !upgradeProgress.isRunning) {
    populateUnverifiedBitrates().catch(() => {});
  }

  return {
    total,
    studioCount,
    lowQualityCount: m4aCount + knownLow,
    m4aCount,
    unverifiedCount,
    isRunning: upgradeProgress.isRunning,
    progress: getUpgradeProgress()
  };
}

export async function reDownloadAllTracksInHighQuality(): Promise<{ started: boolean; message: string }> {
  if (upgradeProgress.isRunning) {
    return { started: false, message: 'Процесс обновления уже выполняется' };
  }

  shouldStopUpgrade = false;

  const allTracks = db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, t.duration_ms, t.file_path, t.cover_url, t.spotify_id, t.bitrate
    FROM tracks t
    WHERE t.file_path IS NOT NULL AND t.file_path != ''
    ORDER BY
      CASE 
        WHEN t.file_path LIKE '%.m4a' THEN 0
        WHEN t.bitrate IS NOT NULL AND t.bitrate < 250 THEN 1
        WHEN t.bitrate IS NULL THEN 2
        ELSE 3
      END ASC,
      CASE WHEN EXISTS (SELECT 1 FROM liked_tracks lt WHERE lt.track_id = t.id)
             OR EXISTS (SELECT 1 FROM playlist_tracks pt WHERE pt.track_id = t.id)
           THEN 0 ELSE 1 END ASC,
      t.id DESC
  `).all() as any[];

  upgradeProgress.isRunning = true;
  upgradeProgress.total = allTracks.length;
  upgradeProgress.current = 0;
  upgradeProgress.successCount = 0;
  upgradeProgress.upgradedCount = 0;
  upgradeProgress.skippedCount = 0;
  upgradeProgress.errorCount = 0;

  broadcastToAll({ type: 'UPGRADE_PROGRESS', progress: getUpgradeProgress() });

  // Background worker loop
  (async () => {
    console.log(`[Upgrade Quality] Starting smart selective high-fidelity upgrade of ${allTracks.length} tracks...`);
    for (let i = 0; i < allTracks.length; i++) {
      if (shouldStopUpgrade) {
        console.log('[Upgrade Quality] Upgrade stopped by user request.');
        break;
      }

      const tr = allTracks[i];
      if (inFlightTrackIdDownloads.has(tr.id)) continue;
      upgradeProgress.current = i + 1;
      upgradeProgress.currentTrack = `${tr.artist} - ${tr.title}`;

      // Fast check: if already confirmed 320k in database and file exists
      if (tr.bitrate && tr.bitrate >= 250 && tr.file_path && tr.file_path.endsWith('.mp3') && fs.existsSync(tr.file_path)) {
        upgradeProgress.skippedCount++;
        upgradeProgress.successCount++;
        continue;
      }

      try {
        const probe = await probeAudioFile(tr.file_path, tr.duration_ms);

        if (probe.isHighQuality) {
          // Already 320 kbps (or >= 250 kbps) and full duration!
          db.prepare('UPDATE tracks SET bitrate = ? WHERE id = ?').run(probe.bitrateKbps || 320, tr.id);
          upgradeProgress.skippedCount++;
          upgradeProgress.successCount++;
          continue;
        }

        console.log(`[Upgrade Quality] [${i + 1}/${allTracks.length}] Upgrading "${tr.artist} - ${tr.title}" (Reason: ${probe.reason || 'Missing or low bitrate'})...`);
        broadcastToAll({ type: 'UPGRADE_PROGRESS', progress: getUpgradeProgress() });

        const ok = await upgradeSingleTrackFile(tr);
        if (ok) {
          upgradeProgress.upgradedCount++;
          upgradeProgress.successCount++;
        } else {
          upgradeProgress.errorCount++;
        }
      } catch (err: any) {
        console.warn(`[Upgrade Quality Error] on track "${tr.artist} - ${tr.title}":`, err.message);
        upgradeProgress.errorCount++;
      }

      broadcastToAll({ type: 'UPGRADE_PROGRESS', progress: getUpgradeProgress() });
      // Small cooldown to prevent CPU throttling
      await new Promise(r => setTimeout(r, 600));
    }

    upgradeProgress.isRunning = false;
    upgradeProgress.currentTrack = '';
    console.log(`[Upgrade Quality Completed] Upgraded: ${upgradeProgress.upgradedCount}, Already High Quality: ${upgradeProgress.skippedCount}, Errors: ${upgradeProgress.errorCount}`);
    broadcastToAll({ type: 'UPGRADE_PROGRESS', progress: getUpgradeProgress() });
    await refreshJellyfinLibrary();
  })().catch(err => {
    upgradeProgress.isRunning = false;
    broadcastToAll({ type: 'UPGRADE_PROGRESS', progress: getUpgradeProgress() });
    console.error('[Upgrade Quality Fatal]', err);
  });

  return { started: true, message: `Запущена выборочная проверка и перезагрузка треков низкого качества (320 kbps)` };
}

export function sanitizeTrackRecord(tr: any) {
  if (!tr) return tr;
  const { file_path, ...safe } = tr;
  const isDownloaded =
    file_path !== undefined
      ? Boolean(file_path && String(file_path).trim().length > 0)
      : Boolean(safe.is_downloaded);
  return {
    ...safe,
    is_downloaded: isDownloaded,
  };
}

const inFlightRedownloads = new Map<number, Promise<{ success: boolean; track?: any; error?: string }>>();
const rejectedVideoIdsByTrack = new Map<number, Set<string>>();

export async function redownloadTrackStudioMaster(trackId: number): Promise<{ success: boolean; track?: any; error?: string }> {
  if (inFlightRedownloads.has(trackId)) {
    return inFlightRedownloads.get(trackId)!;
  }
  const promise = redownloadTrackStudioMasterInternal(trackId);
  inFlightRedownloads.set(trackId, promise);
  try {
    return await promise;
  } finally {
    inFlightRedownloads.delete(trackId);
  }
}

async function redownloadTrackStudioMasterInternal(trackId: number): Promise<{ success: boolean; track?: any; error?: string }> {
  try {
    const track: any = db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId);
    if (!track) {
      return { success: false, error: 'Track not found' };
    }

    console.log(`[Redownload Studio Master] Starting replacement for #${track.id}: "${track.artist} - ${track.title}"`);

    // 1. Inspect currently installed file (if any) so we exclude its YouTube video ID from re-selection
    let currentProbe: AudioProbeResult | null = null;
    if (track.file_path && fs.existsSync(track.file_path) && isPathInsideMusicDir(track.file_path)) {
      currentProbe = await probeAudioFile(track.file_path);
    }
    let rejectedSet = rejectedVideoIdsByTrack.get(track.id);
    if (!rejectedSet) {
      rejectedSet = new Set<string>();
      if (rejectedVideoIdsByTrack.size > 500) {
        const firstKey = rejectedVideoIdsByTrack.keys().next().value;
        if (firstKey !== undefined) rejectedVideoIdsByTrack.delete(firstKey);
      }
      rejectedVideoIdsByTrack.set(track.id, rejectedSet);
    }
    if (currentProbe?.sourceVideoId) {
      rejectedSet.add(currentProbe.sourceVideoId);
    }

    // 2. Resolve canonical studio duration and album metadata (never rely on potentially polluted DB duration)
    let resolvedCanonicalDurationMs: number | undefined;
    let canonicalAlbum: string | undefined = track.album || undefined;
    let canonicalCoverUrl: string | undefined = track.cover_url || undefined;

    if (track.spotify_id) {
      try {
        const details = await resolveSpotifyTrackDetails(track.spotify_id);
        if (details.duration_ms && details.duration_ms > 0) {
          resolvedCanonicalDurationMs = details.duration_ms;
        }
        if (details.album && (!canonicalAlbum || canonicalAlbum === 'Любимые треки' || canonicalAlbum === '-')) {
          canonicalAlbum = String(details.album).slice(0, 200);
        }
        if (details.cover_url && (!canonicalCoverUrl || canonicalCoverUrl.includes('mosaic.scdn.co'))) {
          canonicalCoverUrl = String(details.cover_url).slice(0, 2048);
        }
      } catch (_) {}
    }

    if (!resolvedCanonicalDurationMs || !canonicalAlbum || canonicalAlbum === 'Любимые треки' || canonicalAlbum === '-') {
      try {
        const dz = await resolveDeezerTrackInfo(track.artist, track.title);
        if (!resolvedCanonicalDurationMs && dz.duration && dz.duration > 0) {
          resolvedCanonicalDurationMs = dz.duration * 1000;
        }
        if (dz.album && (!canonicalAlbum || canonicalAlbum === 'Любимые треки' || canonicalAlbum === '-')) {
          canonicalAlbum = String(dz.album).slice(0, 200);
        }
        if (dz.cover_url && (!canonicalCoverUrl || canonicalCoverUrl.includes('mosaic.scdn.co'))) {
          canonicalCoverUrl = String(dz.cover_url).slice(0, 2048);
        }
      } catch (_) {}
    }

    const canonicalDurationMs = resolvedCanonicalDurationMs || (track.duration_ms > 0 ? track.duration_ms : undefined);

    const targetDir = getSafeArtistDir(track.artist || 'Unknown Artist');
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const safeTitle = sanitizeFilename(track.title);
    const tempSafeTitle = `${safeTitle}__studio_tmp`;
    const tempOutputTemplate = path.join(targetDir, `${tempSafeTitle}.%(ext)s`);

    // Clean up any lingering temporary files from prior attempts
    cleanupPartialFiles(targetDir, tempSafeTitle);

    // Invalidate any stale cached candidate to ensure fresh search for studio master replacement
    const cleanRedownloadKey = `${(track.artist || '').toLowerCase()}:::${(track.title || '').toLowerCase()}`;
    studioCandidateCache.delete(cleanRedownloadKey);

    // Force re-download to temporary output first with HIGH priority download slot
    const success = await runWithPrioritySlot(
      DownloadPriority.HIGH,
      `studio-master:${track.artist} - ${track.title}`,
      async () => {
        return await downloadAudioWithFallback(
          track.artist,
          track.title,
          canonicalDurationMs,
          tempOutputTemplate,
          targetDir,
          tempSafeTitle,
          300000,
          false,
          true,
          {
            album: canonicalAlbum,
            excludeVideoIds: rejectedSet
          }
        );
      }
    );

    if (!success) {
      cleanupPartialFiles(targetDir, tempSafeTitle);
      return { success: false, error: 'Не удалось найти или скачать студийный аудиофайл' };
    }

    const tempFile = resolveAudioFilePath(targetDir, tempSafeTitle);
    if (!tempFile || !fs.existsSync(tempFile)) {
      cleanupPartialFiles(targetDir, tempSafeTitle);
      return { success: false, error: 'Скачанный файл не найден на диске' };
    }

    const probe = await probeAudioFile(tempFile, canonicalDurationMs);
    if (!probe.valid) {
      cleanupPartialFiles(targetDir, tempSafeTitle);
      return { success: false, error: `Скачанный файл поврежден: ${probe.reason || 'неизвестная ошибка'}` };
    }

    if (probe.sourceVideoId && rejectedSet.has(probe.sourceVideoId)) {
      cleanupPartialFiles(targetDir, tempSafeTitle);
      return { success: false, error: 'Не удалось найти другую студийную версию трека' };
    }

    // Now safely replace the old file with the verified new studio master
    const finalFile = path.join(targetDir, `${safeTitle}${path.extname(tempFile)}`);
    if (track.file_path && fs.existsSync(track.file_path) && track.file_path !== finalFile && isPathInsideMusicDir(track.file_path)) {
      try { fs.unlinkSync(track.file_path); } catch (_) {}
    }
    if (fs.existsSync(finalFile) && isPathInsideMusicDir(finalFile)) {
      try { fs.unlinkSync(finalFile); } catch (_) {}
    }
    fs.renameSync(tempFile, finalFile);
    cleanupPartialFiles(targetDir, tempSafeTitle);

    const actualDurationMs = (probe.valid && probe.durationSec > 0)
      ? Math.round(probe.durationSec * 1000)
      : (canonicalDurationMs || track.duration_ms);

    db.prepare(`
      UPDATE tracks
      SET file_path = ?, duration_ms = ?, bitrate = ?,
          album = CASE WHEN album IS NULL OR album = '' OR album = '-' OR album = 'Любимые треки' THEN ? ELSE album END,
          cover_url = CASE WHEN cover_url IS NULL OR cover_url = '' OR cover_url LIKE '%mosaic.scdn.co%' THEN ? ELSE cover_url END
      WHERE id = ?
    `).run(finalFile, actualDurationMs, probe.bitrateKbps || 320, canonicalAlbum || '', canonicalCoverUrl || '', track.id);
    invalidateTrackStreamMeta(track.id);
    invalidateTranscodeCacheForTrack(track.id).catch(() => {});

    const updatedTrack: any = db.prepare('SELECT * FROM tracks WHERE id = ?').get(track.id);
    const safeTrack = sanitizeTrackRecord(updatedTrack);

    broadcastToAll({
      type: 'TRACK_UPDATED',
      track: safeTrack,
      resetToStart: true
    });

    await refreshJellyfinLibrary();
    console.log(`[Redownload Studio Master] Successfully replaced #${track.id}: "${track.artist} - ${track.title}" (${probe.bitrateKbps || 320}kbps, ${Math.round(actualDurationMs / 1000)}s, video=${probe.sourceVideoId || 'unknown'})`);

    return { success: true, track: safeTrack };
  } catch (err: any) {
    console.error(`[Redownload Studio Master Error] Track #${trackId}:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * One-time background migration to re-download existing variant tracks
 * (Slowed, Super Slowed, Ultra Slowed, Sped Up, Nightcore, Reverb, Instrumental, 8D, Bass Boost)
 * that may have previously matched the normal studio version due to FAN_KEYWORDS penalty.
 */
export function repairVariantTracksIfNeeded(): void {
  const markerPath = path.join(process.cwd(), 'data', '.variant_tracks_repaired_v1');
  if (fs.existsSync(markerPath)) return;

  try {
    const variantTracks = db.prepare(`
      SELECT id, title, artist
      FROM tracks
      WHERE file_path IS NOT NULL AND file_path != ''
        AND (
          LOWER(title) LIKE '%slowed%' OR
          LOWER(title) LIKE '%sped up%' OR
          LOWER(title) LIKE '%speed up%' OR
          LOWER(title) LIKE '%nightcore%' OR
          LOWER(title) LIKE '%reverb%' OR
          LOWER(title) LIKE '%instrumental%' OR
          LOWER(title) LIKE '%инструментал%' OR
          LOWER(title) LIKE '%karaoke%' OR
          LOWER(title) LIKE '%караоке%' OR
          LOWER(title) LIKE '%минус%' OR
          LOWER(title) LIKE '%8d%' OR
          LOWER(title) LIKE '%bass boost%' OR
          LOWER(title) LIKE '%bassboost%'
        )
    `).all() as Array<{ id: number; title: string; artist: string }>;

    if (!variantTracks || variantTracks.length === 0) {
      fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
      return;
    }

    console.log(`[Variant Repair] Queuing ${variantTracks.length} variant track(s) for background re-download with variant-aware matching...`);

    (async () => {
      let fixed = 0;
      for (const tr of variantTracks) {
        try {
          const res = await redownloadTrackStudioMaster(tr.id);
          if (res.success) fixed++;
        } catch (err: any) {
          console.warn(`[Variant Repair] Failed for #${tr.id} ("${tr.artist} - ${tr.title}"):`, err.message);
        }
        await new Promise(r => setTimeout(r, 400));
      }
      try {
        fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
      } catch (_) {}
      console.log(`[Variant Repair] Completed! Re-downloaded ${fixed}/${variantTracks.length} variant tracks.`);
    })().catch(err => console.error('[Variant Repair] Fatal loop error:', err));
  } catch (err: any) {
    console.warn('[Variant Repair] Startup check failed:', err.message);
  }
}

/**
 * One-time background migration to detect and replace tracks whose downloaded MP3
 * contains an unwanted Live / Acoustic / Unplugged / Concert / Cover recording
 * despite the Spotify/DB track title being a normal studio release.
 */
export function repairMismatchedLiveTracksIfNeeded(): void {
  const markerPath = path.join(process.cwd(), 'data', '.live_mismatch_repaired_v1');
  if (fs.existsSync(markerPath)) return;

  try {
    const allTracks = db.prepare(`
      SELECT t.id, t.title, t.artist, t.file_path
      FROM tracks t
      WHERE t.file_path IS NOT NULL AND t.file_path != ''
      ORDER BY
        COALESCE(
          (SELECT MAX(pt.added_at) FROM playlist_tracks pt WHERE pt.track_id = t.id),
          (SELECT MAX(lt.created_at) FROM liked_tracks lt WHERE lt.track_id = t.id),
          t.created_at
        ) DESC,
        t.id DESC
    `).all() as Array<{ id: number; title: string; artist: string; file_path: string }>;

    if (!allTracks || allTracks.length === 0) {
      fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
      return;
    }

    const unwantedTitleRe = /(?<![\p{L}\p{N}])(?:live|лайв|концерт|concert|unplugged|acoustic|акустика|акустическ\p{L}*|под\s+гитару|cover|кавер)(?![\p{L}\p{N}])/iu;

    (async () => {
      const candidates = allTracks.filter((tr) =>
        Boolean(
          tr.title &&
          !unwantedTitleRe.test(tr.title) &&
          !unwantedTitleRe.test(tr.artist || '') &&
          tr.file_path &&
          isPathInsideMusicDir(tr.file_path) &&
          fs.existsSync(tr.file_path)
        )
      );

      const BATCH_SIZE = 6;
      let foundCount = 0;
      let fixed = 0;

      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const probes = await Promise.all(
          batch.map(async (tr) => {
            try {
              const probe = await probeAudioFile(tr.file_path);
              return { tr, probe };
            } catch (_) {
              return { tr, probe: null };
            }
          })
        );

        for (const { tr, probe } of probes) {
          if (probe?.valid && probe.embeddedTitle && unwantedTitleRe.test(probe.embeddedTitle)) {
            foundCount++;
            console.log(`[Live Mismatch Repair] Repairing #${tr.id} "${tr.artist} - ${tr.title}" (was "${probe.embeddedTitle}")`);
            try {
              const res = await redownloadTrackStudioMaster(tr.id);
              if (res.success) fixed++;
            } catch (err: any) {
              console.warn(`[Live Mismatch Repair] Failed for #${tr.id} ("${tr.artist} - ${tr.title}"):`, err.message);
            }
            await new Promise(r => setTimeout(r, 400));
          }
        }
      }

      if (foundCount > 0) {
        console.log(`[Live Mismatch Repair] Completed! Repaired ${fixed}/${foundCount} track(s).`);
      }

      try {
        fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
      } catch (_) {}
    })().catch(err => console.error('[Live Mismatch Repair] Fatal loop error:', err));
  } catch (err: any) {
    console.warn('[Live Mismatch Repair] Startup check failed:', err.message);
  }
}


