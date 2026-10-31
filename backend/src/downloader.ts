import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { db } from './db';
import { refreshJellyfinLibrary } from './jellyfin';
import { SpotifyTrack, resolveSpotifyTrackDetails, fetchSpotifyPlaylist, resolveDeezerTrackInfo } from './spotify';
import { broadcastToUser } from './sync';

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

function sanitizeFilename(name: string): string {
  if (!name) return 'track';
  return String(name).replace(/[\\/:*?"<>|]/g, '_').trim() || 'track';
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
    for (const f of files) {
      if (
        f.startsWith(safeTitle) &&
        (f.endsWith('.part') ||
          f.endsWith('.ytdl') ||
          f.endsWith('.temp') ||
          f.endsWith('.mp3') ||
          f.endsWith('.m4a') ||
          f.endsWith('.opus') ||
          f.endsWith('.webm') ||
          f.endsWith('.webp') ||
          f.endsWith('.png') ||
          f.endsWith('.jpg'))
      ) {
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

const MAX_CONCURRENT_SINGLE_DOWNLOADS = 2;
let activeSingleDownloads = 0;
const singleDownloadWaitQueue: Array<() => void> = [];

async function runWithSingleDownloadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeSingleDownloads >= MAX_CONCURRENT_SINGLE_DOWNLOADS) {
    await new Promise<void>((resolve) => singleDownloadWaitQueue.push(resolve));
  }
  activeSingleDownloads++;
  try {
    return await fn();
  } finally {
    activeSingleDownloads--;
    const next = singleDownloadWaitQueue.shift();
    if (next) next();
  }
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
    const primaryArtist = lArtist.split(/[,&/]| feat\.? | ft\.? /i)[0].trim();

    const cleanTitle = (s: string) =>
      s
        .toLowerCase()
        .replace(/[\(\[][^\)\]]*(feat|ft|with|remix|version|bonus|edit)[^\)\]]*[\)\]]/gi, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();

    const cTitle = cleanTitle(lTitle);

    const rows: any[] = db.prepare(`
      SELECT title, artist, spotify_id FROM blacklist WHERE user_id = ?
    `).all(userId);

    return rows.some((b) => {
      if (spotifyId && b.spotify_id && b.spotify_id === spotifyId) return true;
      const bTitle = (b.title || '').toLowerCase().trim();
      const bArtist = (b.artist || '').toLowerCase().trim();
      const bPrimary = bArtist.split(/[,&/]| feat\.? | ft\.? /i)[0].trim();

      // Artist-wide ban
      if (bTitle === '*' && (bArtist === lArtist || bArtist === primaryArtist || lArtist.startsWith(bArtist))) {
        return true;
      }

      // Check artist match
      const artistMatches =
        !bArtist ||
        bArtist === '*' ||
        bArtist === lArtist ||
        bArtist === primaryArtist ||
        bPrimary === primaryArtist ||
        lArtist.startsWith(bArtist);

      if (!artistMatches) return false;

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
    const rows: any[] = db.prepare(`
      SELECT title, artist, spotify_id FROM blacklist WHERE user_id = ?
    `).all(userId);
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
      const bPrimary = bArtist.split(/[,&/]| feat\.? | ft\.? /i)[0].trim();
      return {
        spotifyId: b.spotify_id || null,
        title: bTitle,
        cleanTitle: cleanTitle(bTitle),
        artist: bArtist,
        primaryArtist: bPrimary,
        isArtistOnly: bTitle === '*'
      };
    });

    return tracks.filter((t) => {
      if (!t || !t.title) return true;
      const lTitle = t.title.toLowerCase().trim();
      const lArtist = (t.artist || '').toLowerCase().trim();
      const primaryArtist = lArtist.split(/[,&/]| feat\.? | ft\.? /i)[0].trim();
      const cTitle = cleanTitle(lTitle);
      const spotifyId = t.spotify_id || (t as any).spotifyId;

      return !preparedRules.some((b) => {
        if (spotifyId && b.spotifyId && b.spotifyId === spotifyId) return true;
        if (b.isArtistOnly && (b.artist === lArtist || b.artist === primaryArtist || lArtist.startsWith(b.artist))) {
          return true;
        }

        const artistMatches =
          !b.artist ||
          b.artist === '*' ||
          b.artist === lArtist ||
          b.artist === primaryArtist ||
          b.primaryArtist === primaryArtist ||
          lArtist.startsWith(b.artist);

        if (!artistMatches) return false;

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
  const primaryArtist = lArtist.split(/[,&/]| feat\.? | ft\.? /i)[0].trim();

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
    const itemPrimary = itemArtist.split(/[,&/]| feat\.? | ft\.? /i)[0].trim();
    const artistMatches =
      !lArtist ||
      lArtist === '*' ||
      lArtist === itemArtist ||
      lArtist === itemPrimary ||
      primaryArtist === itemPrimary ||
      itemArtist.startsWith(lArtist);

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
}

export async function probeAudioFile(filePath: string, expectedDurationMs?: number): Promise<AudioProbeResult> {
  if (!filePath || !fs.existsSync(filePath)) {
    return { valid: false, durationSec: 0, bitrateKbps: 0, isHighQuality: false, reason: 'FILE_NOT_FOUND' };
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
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,sample_rate,bit_rate',
      '-show_format',
      '-of', 'json',
      filePath
    ]);

    let stdout = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.on('close', (code) => {
      if (code !== 0) {
        return resolve({ valid: false, durationSec: 0, bitrateKbps: 0, isHighQuality: false, reason: 'PROBE_FAILED' });
      }
      try {
        const parsed = JSON.parse(stdout) || {};
        const data = parsed.format || {};
        const stream = parsed.streams?.[0] || {};
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
          return resolve({
            valid: true,
            durationSec,
            bitrateKbps,
            sampleRate,
            isHighQuality: false,
            reason: reasons.join(', ')
          });
        }

        return resolve({
          valid: true,
          durationSec,
          bitrateKbps,
          sampleRate,
          isHighQuality: true
        });
      } catch (err: any) {
        resolve({ valid: false, durationSec: 0, bitrateKbps: 0, isHighQuality: false, reason: err.message });
      }
    });

    proc.on('error', (err) => {
      resolve({ valid: false, durationSec: 0, bitrateKbps: 0, isHighQuality: false, reason: err.message });
    });

    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolve({ valid: false, durationSec: 0, bitrateKbps: 0, isHighQuality: false, reason: 'PROBE_TIMEOUT' });
    }, 10000);
  });
}

export function cancelPlaylistDownloads(playlistIds: number[]) {
  if (!playlistIds || playlistIds.length === 0) return;
  const idSet = new Set(playlistIds);
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].playlistId !== null && idSet.has(queue[i].playlistId!)) {
      queue.splice(i, 1);
    }
  }
  for (const pid of playlistIds) {
    try {
      db.prepare('DELETE FROM download_jobs WHERE playlist_id = ?').run(pid);
    } catch (_) {}
  }
}

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
      if (!activeJob) {
        db.prepare(`
          INSERT INTO download_jobs (id, user_id, playlist_id, playlist_name, total_tracks, downloaded_tracks, status)
          VALUES (?, ?, ?, ?, ?, 0, 'downloading')
        `).run(jobId, playlist.user_id, playlistId, playlist.name, playlistData.tracks.length);
      } else {
        db.prepare(`
          UPDATE download_jobs
          SET status = 'downloading', total_tracks = ?
          WHERE id = ?
        `).run(playlistData.tracks.length, jobId);
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
      db.prepare(`
        UPDATE download_jobs
        SET status = 'completed', downloaded_tracks = ?, current_track = NULL
        WHERE id = ?
      `).run(count, item.jobId);

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

export async function findBestStudioAudioSource(artist: string, title: string, durationMs?: number): Promise<string> {
  const targetSec = durationMs ? Math.round(durationMs / 1000) : 0;
  // Security: strip leading dashes/flags to prevent argument injection
  const cleanArtist = (artist || '').replace(/^[- \t]+/, '').replace(/[\\/:*?"<>|]/g, ' ').trim();
  const cleanTitle = (title || '').replace(/^[- \t]+/, '').replace(/[\\/:*?"<>|]/g, ' ').trim();
  const searchQuery = `ytsearch10:${cleanArtist} ${cleanTitle}`;

  try {
    const raw = await new Promise<string>((resolve) => {
      const proc = spawn('yt-dlp', [
        '--js-runtimes', 'node',
        '--dump-json',
        '--flat-playlist',
        '--default-search', 'ytsearch10',
        '--',
        searchQuery
      ], { detached: true });
      let stdout = '';
      proc.stdout.on('data', d => stdout += d.toString());
      proc.stderr.on('data', () => {});
      proc.on('close', () => resolve(stdout));
      proc.on('error', () => resolve(''));
      setTimeout(() => {
        killProcessGroup(proc, 'SIGKILL');
        resolve(stdout);
      }, 15000);
    });

    const candidates: any[] = [];
    for (const line of raw.trim().split('\n')) {
      if (!line) continue;
      try {
        const item = JSON.parse(line);
        const dur = Number(item.duration) || 0;
        const diff = targetSec > 0 ? Math.abs(dur - targetSec) : 0;
        let score = 0;

        if (targetSec > 0) {
          if (diff <= 2) score += 50;
          else if (diff <= 5) score += 35;
          else if (diff <= 10) score += 20;
          else if (diff <= 25) score += 5;
          else score -= 40;
        }

        const tl = (item.title || '').toLowerCase();
        const cl = (item.channel || item.uploader || '').toLowerCase();
        const artistLower = cleanArtist.toLowerCase();

        // 1. Prioritize YouTube Music / Label Studio Master Topic channels
        if (cl.includes('topic')) score += 70;
        // 2. Prioritize Official Artist channel
        if (cl.includes(artistLower)) score += 60;

        if (tl.includes('official audio')) score += 45;
        else if (tl.includes('official visualizer') || tl.includes('visualizer')) score += 40;
        else if (tl.includes('audio')) score += 30;
        else if (tl.includes('lyrics')) score += 15;

        // Severe penalties for music videos with sound effects / dialogue
        if (tl.includes('official video') || tl.includes('music video') || tl.includes('official music video') || tl.includes('clip')) {
          score -= 40;
        }
        if (tl.includes('live') && !cleanTitle.toLowerCase().includes('live')) score -= 70;
        if (tl.includes('cover') && !cleanTitle.toLowerCase().includes('cover')) score -= 80;
        if (tl.includes('remix') && !cleanTitle.toLowerCase().includes('remix')) score -= 60;

        // Penalize fan / unofficial video rips from trailers, series, games
        if (!cl.includes(artistLower) && !cl.includes('topic')) {
          if (['trailer', 'teaser', 'gameplay', 'netflix', 'series', 'ost', 'soundtrack', 'movie', 'scene', 'edit'].some(w => tl.includes(w))) {
            score -= 60;
          }
        }

        candidates.push({ id: item.id, score, dur, diff, title: item.title });
      } catch (_) {}
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      if (best.id) {
        console.log(`[Studio Audio Match] "${cleanArtist} - ${cleanTitle}": selected ${best.id} ("${best.title}", diff=${best.diff}s, score=${best.score})`);
        return `https://www.youtube.com/watch?v=${best.id}`;
      }
    }
  } catch (err: any) {
    console.warn('[Studio Audio Search Fallback]:', err.message);
  }

  return `ytsearch1:${cleanArtist} - ${cleanTitle} audio`;
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

    const ytDlpArgs = [
      '--js-runtimes', 'node',
      '--no-playlist',
      '--force-overwrites',
      '--no-continue',
      '-f', 'bestaudio[acodec=opus]/bestaudio/best',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '320k',
      '--postprocessor-args', 'ExtractAudio:-af volume=-1.8dB -ar 48000 -compression_level 7',
      '--embed-thumbnail',
      '--add-metadata',
      '-o', outputTemplate,
      '--',
      sourceUrl
    ];

    const cmd = lowCpuPriority ? 'nice' : 'yt-dlp';
    const args = lowCpuPriority ? ['-n', '19', 'ionice', '-c', '3', 'yt-dlp', ...ytDlpArgs] : ytDlpArgs;

    const proc = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore'
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
        cleanupPartialFiles(targetDir, safeTitle);
        finish(false, false);
      }
    });

    proc.on('error', () => {
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
  lowCpuPriority: boolean
): Promise<boolean> {
  const primaryUrl = await findBestStudioAudioSource(artist, title, durationMs);
  const firstAttempt = await executeYtDlpMp3Download(
    primaryUrl,
    outputTemplate,
    targetDir,
    safeTitle,
    timeoutMs,
    lowCpuPriority
  );
  if (firstAttempt.ok) return true;

  // If primary video ID was unavailable/age-restricted (and didn't time out), retry once via search fallback
  const cleanArtist = (artist || '').replace(/^[- \t]+/, '').replace(/[\\/:*?"<>|]/g, ' ').trim();
  const cleanTitle = (title || '').replace(/^[- \t]+/, '').replace(/[\\/:*?"<>|]/g, ' ').trim();
  const fallbackQuery = `ytsearch1:${cleanArtist} - ${cleanTitle} audio`;

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

async function downloadSingleTrack(item: QueueItem): Promise<void> {
  const { jobId, playlistId, track, position } = item;

  // Resolve real individual track details (cover + real album) from Spotify / Deezer
  const details = await resolveSpotifyTrackDetails(track.id);
  if (details.cover_url && (!track.cover_url || track.cover_url.includes('mosaic.scdn.co'))) {
    track.cover_url = details.cover_url;
  }
  if (details.album) {
    track.album = details.album;
  }
  if (details.artist && (!track.artist || track.artist === 'Unknown Artist')) {
    track.artist = details.artist;
  }

  if (!track.cover_url || !track.album) {
    try {
      const dz = await resolveDeezerTrackInfo(track.artist, track.title);
      if (dz.cover_url && (!track.cover_url || track.cover_url.includes('mosaic.scdn.co'))) {
        track.cover_url = dz.cover_url;
      }
      if (dz.album && !track.album) {
        track.album = dz.album;
      }
      if (dz.duration && (!track.duration_ms || track.duration_ms <= 0)) {
        track.duration_ms = dz.duration * 1000;
      }
    } catch (_) {}
  }

  // Check if track already exists locally in DB
  const existing = db.prepare(`
    SELECT * FROM tracks WHERE spotify_id = ? OR (LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?))
  `).get(track.id, track.title, track.artist) as any;

  if (existing) {
    // If existing track had missing or playlist fallback album/cover, update it
    if (details.album && (!existing.album || existing.album === 'Любимые треки' || existing.album === '-')) {
      db.prepare('UPDATE tracks SET album = ? WHERE id = ?').run(details.album, existing.id);
    }
    if (details.cover_url && (!existing.cover_url || existing.cover_url.includes('mosaic.scdn.co'))) {
      db.prepare('UPDATE tracks SET cover_url = ? WHERE id = ?').run(details.cover_url, existing.id);
    }

    // Check blacklist before linking to playlist or liked_tracks
    if (isTrackBlacklistedForUser(item.userId, details.title || track.title, details.artist || track.artist, track.id)) {
      console.log(`[Downloader] Skipping blacklisted existing track "${track.artist} - ${track.title}" for user ${item.userId}`);
      return;
    }

    // Already downloaded: link to playlist or liked_tracks
    if (item.isLikedOnly || !playlistId) {
      db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(item.userId, existing.id);
      broadcastToUser(item.userId, { type: 'LIKES_UPDATED', trackId: existing.id, liked: true });
    } else {
      db.prepare(`
        INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
        VALUES (?, ?, ?)
      `).run(playlistId, existing.id, position);
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

  // Update status in DB
  db.prepare(`
    UPDATE download_jobs
    SET current_track = ?, status = 'downloading'
    WHERE id = ?
  `).run(`${track.artist} - ${track.title}`, jobId);

  // Prepare destination dir
  const artistFolder = sanitizeFilename(track.artist || 'Unknown Artist');
  const targetDir = path.join(MUSIC_DIR, artistFolder);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const safeTitle = sanitizeFilename(track.title);
  const outputTemplate = path.join(targetDir, `${safeTitle}.%(ext)s`);

  const downloadedOk = await downloadAudioWithFallback(
    track.artist,
    track.title,
    track.duration_ms,
    outputTemplate,
    targetDir,
    safeTitle,
    120000,
    true
  );

  if (!downloadedOk) {
    console.warn(`[yt-dlp] Failed to download "${track.artist} - ${track.title}"`);
    return;
  }

  // Find saved file (.mp3 preferred studio 320k, or format fallback)
  const finalFile = resolveAudioFilePath(targetDir, safeTitle) || path.join(targetDir, `${safeTitle}.mp3`);

  // Verify audio file validity & duration
  const probe = await probeAudioFile(finalFile, track.duration_ms);
  if (track.duration_ms > 30000 && probe.valid && !probe.isHighQuality && probe.reason?.includes('Обрезан')) {
    console.warn(`[yt-dlp truncated audio detected] "${track.artist} - ${track.title}": probed ${probe.durationSec}s vs expected ${track.duration_ms / 1000}s. Discarding.`);
    try { fs.unlinkSync(finalFile); } catch (_) {}
    return;
  }

  try {
    const doubleCheck: any = db.prepare(`
      SELECT * FROM tracks 
      WHERE (spotify_id IS NOT NULL AND spotify_id = ?) 
         OR (LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?))
      LIMIT 1
    `).get(track.id, track.title, track.artist);

    let trackId = doubleCheck?.id;
    const actualDurationMs = (probe.valid && probe.durationSec > 0)
      ? Math.round(probe.durationSec * 1000)
      : (track.duration_ms || 180000);

    if (!trackId) {
      const info = db.prepare(`
        INSERT INTO tracks (title, artist, album, duration_ms, file_path, cover_url, spotify_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        track.title,
        track.artist,
        track.album,
        actualDurationMs,
        finalFile,
        track.cover_url || '',
        track.id
      );
      trackId = info.lastInsertRowid;
    } else if (probe.valid && probe.durationSec > 0) {
      db.prepare('UPDATE tracks SET duration_ms = ? WHERE id = ?').run(actualDurationMs, trackId);
    }

    if (isTrackBlacklistedForUser(item.userId, details.title || track.title, details.artist || track.artist, track.id)) {
      console.log(`[Downloader] Track "${track.artist} - ${track.title}" was blacklisted during download. Skipping playlist link.`);
    } else if (item.isLikedOnly || !playlistId) {
      db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(item.userId, trackId);
      broadcastToUser(item.userId, { type: 'LIKES_UPDATED', trackId, liked: true });
    } else {
      db.prepare(`
        INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
        VALUES (?, ?, ?)
      `).run(playlistId, trackId, position);
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
  }
}

const inFlightSingleDownloads = new Map<string, Promise<{ success: boolean; track?: any; error?: string; addedToPlaylist?: boolean; liked?: boolean }>>();

export async function downloadSingleSpotifyTrackDirect(
  track: SpotifyTrack,
  userId?: number,
  playlistId?: number,
  isLikedOnly?: boolean
): Promise<{ success: boolean; track?: any; error?: string; addedToPlaylist?: boolean; liked?: boolean }> {
  const downloadKey = (track.id || `${track.artist}:::${track.title}`).toLowerCase();
  if (inFlightSingleDownloads.has(downloadKey)) {
    const result = await inFlightSingleDownloads.get(downloadKey)!;
    if (result.success && result.track) {
      if (userId && isTrackBlacklistedForUser(userId, result.track.title, result.track.artist, result.track.spotify_id || track.id)) {
        return { ...result, addedToPlaylist: false, liked: false };
      }
      if (isLikedOnly || playlistId === -1) {
        if (userId) {
          db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(userId, result.track.id);
        }
        return { ...result, liked: true };
      }
      if (playlistId) {
        const inPl: any = db.prepare('SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').get(playlistId, result.track.id);
        if (!inPl) {
          const maxPosRow: any = db.prepare('SELECT MAX(position) as maxPos FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
          const nextPos = (maxPosRow?.maxPos !== null && maxPosRow?.maxPos !== undefined) ? maxPosRow.maxPos + 1 : 0;
          db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)').run(playlistId, result.track.id, nextPos);
        }
        return { ...result, addedToPlaylist: true };
      }
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

async function downloadSingleSpotifyTrackDirectInternal(
  track: SpotifyTrack,
  userId?: number,
  playlistId?: number,
  isLikedOnly?: boolean
): Promise<{ success: boolean; track?: any; error?: string; addedToPlaylist?: boolean; liked?: boolean }> {
  try {
    // 1. Resolve full details if needed
    if (track.id) {
      const details = await resolveSpotifyTrackDetails(track.id);
      if (details.cover_url && (!track.cover_url || track.cover_url.includes('mosaic.scdn.co'))) {
        track.cover_url = details.cover_url;
      }
      if (details.album) {
        track.album = details.album;
      }
      if (details.artist && (!track.artist || track.artist === 'Unknown Artist')) {
        track.artist = details.artist;
      }
    }

    if (!track.cover_url || !track.album) {
      try {
        const dz = await resolveDeezerTrackInfo(track.artist, track.title);
        if (dz.cover_url && (!track.cover_url || track.cover_url.includes('mosaic.scdn.co'))) {
          track.cover_url = dz.cover_url;
        }
        if (dz.album && !track.album) {
          track.album = dz.album;
        }
        if (dz.duration && (!track.duration_ms || track.duration_ms <= 0)) {
          track.duration_ms = dz.duration * 1000;
        }
      } catch (_) {}
    }

    // Helper to attach to playlist or liked tracks
    const attachToPlaylist = (trackRecord: any) => {
      if (!trackRecord?.id) return;
      if (userId && isTrackBlacklistedForUser(userId, trackRecord.title || track.title, trackRecord.artist || track.artist, trackRecord.spotify_id || track.id)) {
        console.log(`[Downloader] Skipping attach: track "${track.artist} - ${track.title}" is blacklisted for user ${userId}`);
        return;
      }
      if (isLikedOnly || playlistId === -1) {
        if (userId) {
          db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(userId, trackRecord.id);
          broadcastToUser(userId, { type: 'LIKES_UPDATED', trackId: trackRecord.id, liked: true });
        }
        return;
      }
      if (!playlistId) return;
      const inPl: any = db.prepare('SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').get(playlistId, trackRecord.id);
      if (!inPl) {
        const maxPosRow: any = db.prepare('SELECT MAX(position) as maxPos FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
        const nextPos = (maxPosRow?.maxPos !== null && maxPosRow?.maxPos !== undefined) ? maxPosRow.maxPos + 1 : 0;
        db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)').run(playlistId, trackRecord.id, nextPos);
      }
      const playlistRow: any = db.prepare('SELECT name FROM playlists WHERE id = ?').get(playlistId);
      if (playlistRow && (playlistRow.name === 'Любимые треки' || playlistRow.name.toLowerCase() === 'liked songs')) {
        if (userId) {
          db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(userId, trackRecord.id);
          broadcastToUser(userId, { type: 'LIKES_UPDATED', trackId: trackRecord.id, liked: true });
        }
      }
    };

    // 2. Check if already exists in DB
    const existing: any = db.prepare(`
      SELECT * FROM tracks 
      WHERE (spotify_id IS NOT NULL AND spotify_id = ?) 
         OR (LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?))
      LIMIT 1
    `).get(track.id, track.title, track.artist);

    if (existing) {
      attachToPlaylist(existing);
      return {
        success: true,
        track: existing,
        addedToPlaylist: !!playlistId && playlistId !== -1,
        liked: Boolean(isLikedOnly || playlistId === -1)
      };
    }

    // 3. Prepare target path
    const artistFolder = sanitizeFilename(track.artist || 'Unknown Artist');
    const targetDir = path.join(MUSIC_DIR, artistFolder);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const safeTitle = sanitizeFilename(track.title);
    const outputTemplate = path.join(targetDir, `${safeTitle}.%(ext)s`);

    // 4. Acquire concurrency slot (max 2 concurrent downloads on 2-core CPU) and download
    const success = await runWithSingleDownloadSlot(async () => {
      // Re-check if downloaded while waiting in queue
      const mp3Candidate = path.join(targetDir, `${safeTitle}.mp3`);
      if (fs.existsSync(mp3Candidate)) {
        const preProbe = await probeAudioFile(mp3Candidate, track.duration_ms);
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
        false
      );
    });

    if (!success) {
      return { success: false, error: 'Не удалось скачать аудиофайл с YouTube' };
    }

    const finalFile = resolveAudioFilePath(targetDir, safeTitle) || path.join(targetDir, `${safeTitle}.mp3`);

    // Verify audio file
    const probe = await probeAudioFile(finalFile, track.duration_ms);
    if (track.duration_ms > 30000 && probe.valid && !probe.isHighQuality && probe.reason?.includes('Обрезан')) {
      console.warn(`[yt-dlp single direct] Truncated audio detected for "${track.artist} - ${track.title}". Discarding.`);
      try { fs.unlinkSync(finalFile); } catch (_) {}
      return { success: false, error: `Скачанный файл оказался неполным (${Math.round(probe.durationSec)}с)` };
    }

    // Safety re-check before insert
    const doubleCheck: any = db.prepare(`
      SELECT * FROM tracks 
      WHERE (spotify_id IS NOT NULL AND spotify_id = ?) 
         OR (LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?))
      LIMIT 1
    `).get(track.id, track.title, track.artist);

    let newTrack: any = doubleCheck;
    const actualDurationMs = (probe.valid && probe.durationSec > 0)
      ? Math.round(probe.durationSec * 1000)
      : (track.duration_ms || 180000);

    if (!newTrack) {
      const info = db.prepare(`
        INSERT INTO tracks (title, artist, album, duration_ms, file_path, cover_url, spotify_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        track.title,
        track.artist,
        track.album || '',
        actualDurationMs,
        finalFile,
        track.cover_url || '',
        track.id
      );
      newTrack = db.prepare('SELECT * FROM tracks WHERE id = ?').get(info.lastInsertRowid);
    } else if (probe.valid && probe.durationSec > 0) {
      db.prepare('UPDATE tracks SET duration_ms = ? WHERE id = ?').run(actualDurationMs, newTrack.id);
      newTrack.duration_ms = actualDurationMs;
    }

    attachToPlaylist(newTrack);
    await refreshJellyfinLibrary();
    return {
      success: true,
      track: newTrack,
      addedToPlaylist: !!playlistId && playlistId !== -1,
      liked: Boolean(isLikedOnly || playlistId === -1)
    };
  } catch (err: any) {
    console.error('[Download Single Track Error]', err);
    return { success: false, error: err.message };
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

export function getUpgradeProgress(): UpgradeProgress {
  return { ...upgradeProgress };
}

export async function reDownloadAllTracksInHighQuality(): Promise<{ started: boolean; message: string }> {
  if (upgradeProgress.isRunning) {
    return { started: false, message: 'Процесс обновления уже выполняется' };
  }

  const allTracks = db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, t.duration_ms, t.file_path, t.cover_url, t.spotify_id
    FROM tracks t
    ORDER BY
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

  // Background worker loop
  (async () => {
    console.log(`[Upgrade Quality] Starting smart selective high-fidelity upgrade of ${allTracks.length} tracks...`);
    for (let i = 0; i < allTracks.length; i++) {
      const tr = allTracks[i];
      upgradeProgress.current = i + 1;
      upgradeProgress.currentTrack = `${tr.artist} - ${tr.title}`;

      try {
        // Step 1: Probe existing file to see if already high quality (320 kbps & full duration)
        const probe = await probeAudioFile(tr.file_path, tr.duration_ms);

        if (probe.isHighQuality) {
          // Already 320 kbps (or >= 250 kbps) and full duration!
          upgradeProgress.skippedCount++;
          upgradeProgress.successCount++;
          console.log(`[Upgrade Quality] [${i + 1}/${allTracks.length}] Skipping "${tr.artist} - ${tr.title}" (already ${probe.bitrateKbps} kbps, full duration ${Math.round(probe.durationSec)}s)`);
          await new Promise(r => setTimeout(r, 20));
          continue;
        }

        console.log(`[Upgrade Quality] [${i + 1}/${allTracks.length}] Upgrading "${tr.artist} - ${tr.title}" (Reason: ${probe.reason || 'Missing or low bitrate'})...`);

        const artistFolder = sanitizeFilename(tr.artist || 'Unknown Artist');
        const targetDir = path.join(MUSIC_DIR, artistFolder);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        const safeTitle = sanitizeFilename(tr.title);
        const tempPrefix = `${safeTitle}.upg.${Date.now()}`;
        const tempOutputTemplate = path.join(targetDir, `${tempPrefix}.%(ext)s`);

        const ok = await downloadAudioWithFallback(
          tr.artist,
          tr.title,
          tr.duration_ms,
          tempOutputTemplate,
          targetDir,
          tempPrefix,
          120000,
          true
        );

        if (ok) {
          const tempFound = resolveAudioFilePath(targetDir, tempPrefix);
          if (!tempFound) {
            upgradeProgress.errorCount++;
            continue;
          }
          const newProbe = await probeAudioFile(tempFound, tr.duration_ms);

          if (tr.duration_ms > 45000 && newProbe.valid && !newProbe.isHighQuality && newProbe.reason?.includes('Обрезан')) {
            console.warn(`[Upgrade Quality] Downloaded file for "${tr.artist} - ${tr.title}" was truncated (${newProbe.durationSec}s). Keeping existing file.`);
            try { fs.unlinkSync(tempFound); } catch (_) {}
            upgradeProgress.errorCount++;
          } else {
            // Safely and atomically replace destination file!
            const newExt = path.extname(tempFound);
            const destinationFile = path.join(targetDir, `${safeTitle}${newExt}`);
            try {
              if (tr.file_path && fs.existsSync(tr.file_path) && tr.file_path !== destinationFile) {
                fs.unlinkSync(tr.file_path);
              } else if (fs.existsSync(destinationFile)) {
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
            db.prepare('UPDATE tracks SET file_path = ?, duration_ms = ? WHERE id = ?').run(destinationFile, updatedDur, tr.id);
            upgradeProgress.upgradedCount++;
            upgradeProgress.successCount++;
          }
        } else {
          upgradeProgress.errorCount++;
        }
      } catch (err: any) {
        console.warn(`[Upgrade Quality Error] on track "${tr.artist} - ${tr.title}":`, err.message);
        upgradeProgress.errorCount++;
      }

      // Small cooldown to prevent CPU throttling
      await new Promise(r => setTimeout(r, 600));
    }

    upgradeProgress.isRunning = false;
    upgradeProgress.currentTrack = '';
    console.log(`[Upgrade Quality Completed] Upgraded: ${upgradeProgress.upgradedCount}, Already High Quality: ${upgradeProgress.skippedCount}, Errors: ${upgradeProgress.errorCount}`);
    await refreshJellyfinLibrary();
  })().catch(err => {
    upgradeProgress.isRunning = false;
    console.error('[Upgrade Quality Fatal]', err);
  });

  return { started: true, message: `Запущена выборочная проверка и перезагрузка треков низкого качества (320 kbps)` };
}

