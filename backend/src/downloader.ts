import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { db } from './db';
import { refreshJellyfinLibrary } from './jellyfin';
import { SpotifyTrack, resolveSpotifyTrackDetails, fetchSpotifyPlaylist, resolveDeezerTrackInfo } from './spotify';

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
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

export function cleanupPartialFiles(targetDir: string, safeTitle: string) {
  try {
    if (!fs.existsSync(targetDir)) return;
    const files = fs.readdirSync(targetDir);
    for (const f of files) {
      if (f.startsWith(safeTitle) && (f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.temp') || f.endsWith('.mp3'))) {
        try {
          fs.unlinkSync(path.join(targetDir, f));
        } catch (_) {}
      }
    }
  } catch (_) {}
}

export interface AudioProbeResult {
  valid: boolean;
  durationSec: number;
  bitrateKbps: number;
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
        const data = JSON.parse(stdout)?.format || {};
        const durationSec = parseFloat(data.duration) || 0;
        const bitrateBps = parseInt(data.bit_rate, 10) || 0;
        const bitrateKbps = Math.round(bitrateBps / 1000);

        const expectedSec = expectedDurationMs ? expectedDurationMs / 1000 : 0;
        let isTruncated = false;
        if (expectedSec > 60) {
          if (durationSec < 55 || durationSec < expectedSec * 0.6) {
            isTruncated = true;
          }
        } else if (expectedSec > 20 && durationSec < 15) {
          isTruncated = true;
        }

        const isLowBitrate = bitrateKbps < 240;

        if (isTruncated || isLowBitrate) {
          const reasons: string[] = [];
          if (isTruncated) reasons.push(`Обрезан (${Math.round(durationSec)}с вместо ${Math.round(expectedSec)}с)`);
          if (isLowBitrate) reasons.push(`Низкий битрейт (${bitrateKbps} kbps)`);
          return resolve({
            valid: true,
            durationSec,
            bitrateKbps,
            isHighQuality: false,
            reason: reasons.join(', ')
          });
        }

        return resolve({
          valid: true,
          durationSec,
          bitrateKbps,
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
    }
  }

  isWorkerRunning = false;
  console.log('[Downloader] Background worker loop completed and idle.');
}

export async function findBestStudioAudioSource(artist: string, title: string, durationMs?: number): Promise<string> {
  const targetSec = durationMs ? Math.round(durationMs / 1000) : 0;
  const cleanArtist = (artist || '').replace(/[\\/:*?"<>|]/g, ' ').trim();
  const cleanTitle = (title || '').replace(/[\\/:*?"<>|]/g, ' ').trim();
  const searchQuery = `ytsearch10:${cleanArtist} ${cleanTitle}`;

  try {
    const raw = await new Promise<string>((resolve) => {
      const proc = spawn('yt-dlp', [
        '--dump-json',
        '--flat-playlist',
        '--default-search', 'ytsearch10',
        searchQuery
      ]);
      let stdout = '';
      proc.stdout.on('data', d => stdout += d.toString());
      proc.on('close', () => resolve(stdout));
      proc.on('error', () => resolve(''));
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
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

    // Already downloaded: link to playlist or liked_tracks
    if (item.isLikedOnly || !playlistId) {
      db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(item.userId, existing.id);
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

  // Level 1 & 2: Smart Studio Candidate Selection
  const audioSourceUrl = await findBestStudioAudioSource(track.artist, track.title, track.duration_ms);

  await new Promise<void>((resolve) => {
    let isSettled = false;
    const safeResolve = () => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timeoutTimer);
        resolve();
      }
    };

    // Launch yt-dlp with studio 320 kbps audio quality settings
    const ytDlpProcess = spawn('nice', [
      '-n', '19',
      'ionice', '-c', '3',
      'yt-dlp',
      '--no-playlist',
      '--extractor-args', 'youtube:player_client=android',
      '--force-overwrites',
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '320k',
      '--postprocessor-args', 'ExtractAudio:-b:a 320k -q:a 0 -ar 44100',
      '--embed-thumbnail',
      '--add-metadata',
      '-o', outputTemplate,
      audioSourceUrl
    ]);

    // 100-second per-track safety timeout
    const timeoutTimer = setTimeout(() => {
      if (!isSettled) {
        console.warn(`[yt-dlp timeout] Track "${track.artist} - ${track.title}" timed out after 100s. Killing process.`);
        try { ytDlpProcess.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => {
          try { ytDlpProcess.kill('SIGKILL'); } catch (_) {}
          cleanupPartialFiles(targetDir, safeTitle);
        }, 3000);
        safeResolve();
      }
    }, 100000);

    ytDlpProcess.on('close', async (code) => {
      if (isSettled) return;

      if (code === 0) {
        // Find saved file
        const finalFile = path.join(targetDir, `${safeTitle}.mp3`);

        // Verify audio file validity & duration
        const probe = await probeAudioFile(finalFile, track.duration_ms);
        if (track.duration_ms > 30000 && probe.valid && !probe.isHighQuality && probe.reason?.includes('Обрезан')) {
          console.warn(`[yt-dlp truncated audio detected] "${track.artist} - ${track.title}": probed ${probe.durationSec}s vs expected ${track.duration_ms / 1000}s. Discarding.`);
          try { fs.unlinkSync(finalFile); } catch (_) {}
          safeResolve();
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

          if (item.isLikedOnly || !playlistId) {
            db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(item.userId, trackId);
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

        safeResolve();
      } else {
        console.warn(`[yt-dlp] Process exited with code ${code} for "${track.artist} - ${track.title}"`);
        cleanupPartialFiles(targetDir, safeTitle);
        safeResolve(); // Continue with next track even if one failed
      }
    });

    ytDlpProcess.on('error', (err) => {
      if (isSettled) return;
      console.warn(`[yt-dlp spawn error]:`, err.message);
      cleanupPartialFiles(targetDir, safeTitle);
      safeResolve();
    });
  });
}

const inFlightSingleDownloads = new Map<string, Promise<{ success: boolean; track?: any; error?: string; addedToPlaylist?: boolean }>>();

export async function downloadSingleSpotifyTrackDirect(
  track: SpotifyTrack,
  userId?: number,
  playlistId?: number
): Promise<{ success: boolean; track?: any; error?: string; addedToPlaylist?: boolean }> {
  const downloadKey = (track.id || `${track.artist}:::${track.title}`).toLowerCase();
  if (inFlightSingleDownloads.has(downloadKey)) {
    const result = await inFlightSingleDownloads.get(downloadKey)!;
    if (result.success && result.track && playlistId) {
      const inPl: any = db.prepare('SELECT 1 FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').get(playlistId, result.track.id);
      if (!inPl) {
        const maxPosRow: any = db.prepare('SELECT MAX(position) as maxPos FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
        const nextPos = (maxPosRow?.maxPos !== null && maxPosRow?.maxPos !== undefined) ? maxPosRow.maxPos + 1 : 0;
        db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)').run(playlistId, result.track.id, nextPos);
      }
      return { ...result, addedToPlaylist: true };
    }
    return result;
  }

  const promise = downloadSingleSpotifyTrackDirectInternal(track, userId, playlistId);
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
  playlistId?: number
): Promise<{ success: boolean; track?: any; error?: string; addedToPlaylist?: boolean }> {
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

    // Helper to attach to playlist if playlistId is provided
    const attachToPlaylist = (trackRecord: any) => {
      if (!playlistId || !trackRecord?.id) return;
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
      return { success: true, track: existing, addedToPlaylist: !!playlistId };
    }

    // 3. Prepare target path
    const artistFolder = sanitizeFilename(track.artist || 'Unknown Artist');
    const targetDir = path.join(MUSIC_DIR, artistFolder);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const safeTitle = sanitizeFilename(track.title);
    const outputTemplate = path.join(targetDir, `${safeTitle}.%(ext)s`);

    // Level 1 & 2: Smart Studio Candidate Selection
    const audioSourceUrl = await findBestStudioAudioSource(track.artist, track.title, track.duration_ms);

    // 4. Download with yt-dlp (320 kbps high fidelity audio)
    const success = await new Promise<boolean>((resolve) => {
      let isSettled = false;
      const finish = (result: boolean) => {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timer);
          resolve(result);
        }
      };

      const ytDlpProcess = spawn('nice', [
        '-n', '19',
        'ionice', '-c', '3',
        'yt-dlp',
        '--no-playlist',
        '--extractor-args', 'youtube:player_client=android',
        '--force-overwrites',
        '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '320k',
        '--postprocessor-args', 'ExtractAudio:-b:a 320k -q:a 0 -ar 44100',
        '--embed-thumbnail',
        '--add-metadata',
        '-o', outputTemplate,
        audioSourceUrl
      ]);

      const timer = setTimeout(() => {
        try { ytDlpProcess.kill('SIGKILL'); } catch (_) {}
        cleanupPartialFiles(targetDir, safeTitle);
        finish(false);
      }, 90000);

      ytDlpProcess.on('close', (code) => {
        if (code === 0) finish(true);
        else {
          cleanupPartialFiles(targetDir, safeTitle);
          finish(false);
        }
      });

      ytDlpProcess.on('error', () => {
        cleanupPartialFiles(targetDir, safeTitle);
        finish(false);
      });
    });

    if (!success) {
      return { success: false, error: 'Не удалось скачать аудиофайл с YouTube' };
    }

    const finalFile = path.join(targetDir, `${safeTitle}.mp3`);

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
    return { success: true, track: newTrack, addedToPlaylist: !!playlistId };
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

  const allTracks = db.prepare('SELECT id, title, artist, album, duration_ms, file_path, cover_url, spotify_id FROM tracks ORDER BY id ASC').all() as any[];

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
        const tempFinalFile = path.join(targetDir, `${tempPrefix}.mp3`);
        const destinationFile = path.join(targetDir, `${safeTitle}.mp3`);

        const audioSourceUrl = await findBestStudioAudioSource(tr.artist, tr.title, tr.duration_ms);

        const ok = await new Promise<boolean>((resolve) => {
          let settled = false;
          const finish = (result: boolean) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(result);
            }
          };

          const proc = spawn('nice', [
            '-n', '19',
            'ionice', '-c', '3',
            'yt-dlp',
            '--no-playlist',
            '--extractor-args', 'youtube:player_client=android',
            '--force-overwrites',
            '--no-continue',
            '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
            '--extract-audio',
            '--audio-format', 'mp3',
            '--audio-quality', '320k',
            '--postprocessor-args', 'ExtractAudio:-b:a 320k -q:a 0 -ar 44100',
            '--embed-thumbnail',
            '--add-metadata',
            '-o', tempOutputTemplate,
            audioSourceUrl
          ]);

          const timer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch (_) {}
            cleanupPartialFiles(targetDir, tempPrefix);
            finish(false);
          }, 90000);

          proc.on('close', code => {
            if (code === 0 && fs.existsSync(tempFinalFile)) finish(true);
            else {
              cleanupPartialFiles(targetDir, tempPrefix);
              finish(false);
            }
          });
          proc.on('error', () => {
            cleanupPartialFiles(targetDir, tempPrefix);
            finish(false);
          });
        });

        if (ok) {
          const newProbe = await probeAudioFile(tempFinalFile, tr.duration_ms);

          if (tr.duration_ms > 45000 && newProbe.valid && !newProbe.isHighQuality && newProbe.reason?.includes('Обрезан')) {
            console.warn(`[Upgrade Quality] Downloaded file for "${tr.artist} - ${tr.title}" was truncated (${newProbe.durationSec}s). Keeping existing file.`);
            try { fs.unlinkSync(tempFinalFile); } catch (_) {}
            upgradeProgress.errorCount++;
          } else {
            // Safely and atomically replace destination file!
            try {
              if (fs.existsSync(destinationFile)) {
                fs.unlinkSync(destinationFile);
              }
              fs.renameSync(tempFinalFile, destinationFile);
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

