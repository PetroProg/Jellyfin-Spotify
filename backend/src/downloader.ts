import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { db } from './db';
import { refreshJellyfinLibrary } from './jellyfin';
import { SpotifyTrack, resolveSpotifyTrackDetails, fetchSpotifyPlaylist } from './spotify';

const MUSIC_DIR = process.env.MUSIC_DIR || path.join(process.cwd(), 'music');

interface QueueItem {
  jobId: string;
  userId: number;
  playlistId: number;
  track: SpotifyTrack;
  position: number;
}

const queue: QueueItem[] = [];
let isWorkerRunning = false;

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

export function enqueuePlaylistDownload(
  jobId: string,
  userId: number,
  playlistId: number,
  tracks: SpotifyTrack[]
) {
  for (let i = 0; i < tracks.length; i++) {
    queue.push({
      jobId,
      userId,
      playlistId,
      track: tracks[i],
      position: i
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
    if (!playlist || !playlist.spotify_id) {
      if (existingJobId) {
        db.prepare("UPDATE download_jobs SET status = 'failed' WHERE id = ?").run(existingJobId);
      }
      return { success: false, queued: 0, message: 'Плейлист или ссылка Spotify не найдены' };
    }

    const playlistData = await fetchSpotifyPlaylist(playlist.spotify_id);
    if (!playlistData.tracks || playlistData.tracks.length === 0) {
      return { success: false, queued: 0, message: 'Не удалось получить треки из Spotify' };
    }

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

    // Get positions of tracks already linked to this playlist
    const existingRows: any[] = db.prepare('SELECT position FROM playlist_tracks WHERE playlist_id = ?').all(playlistId);
    const existingPositions = new Set(existingRows.map(r => r.position));

    let queuedCount = 0;
    playlistData.tracks.forEach((track, idx) => {
      // Check if already in DB or already in active in-memory queue
      const alreadyInQueue = queue.some(q => q.playlistId === playlistId && q.position === idx);
      if (!existingPositions.has(idx) && !alreadyInQueue) {
        queue.push({
          jobId: jobId!,
          userId: playlist.user_id,
          playlistId,
          track,
          position: idx
        });
        queuedCount++;
      }
    });

    const currentDownloaded = existingPositions.size;
    db.prepare(`
      UPDATE download_jobs
      SET downloaded_tracks = ?, total_tracks = ?
      WHERE id = ?
    `).run(currentDownloaded, playlistData.tracks.length, jobId);

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
      const countRow: any = db.prepare('SELECT COUNT(*) as cnt FROM playlist_tracks WHERE playlist_id = ?').get(item.playlistId);
      db.prepare(`
        UPDATE download_jobs
        SET status = 'completed', downloaded_tracks = ?, current_track = NULL
        WHERE id = ?
      `).run(countRow?.cnt || 0, item.jobId);

      // Trigger Jellyfin library refresh
      await refreshJellyfinLibrary();
    }
  }

  isWorkerRunning = false;
  console.log('[Downloader] Background worker loop completed and idle.');
}

async function downloadSingleTrack(item: QueueItem): Promise<void> {
  const { jobId, playlistId, track, position } = item;

  // Resolve real individual track details (cover + real album) from Spotify
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

    // Already downloaded, just link to playlist
    db.prepare(`
      INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
      VALUES (?, ?, ?)
    `).run(playlistId, existing.id, position);

    const playlistRow: any = db.prepare('SELECT name FROM playlists WHERE id = ?').get(playlistId);
    if (playlistRow && (playlistRow.name === 'Любимые треки' || playlistRow.name.toLowerCase() === 'liked songs')) {
      db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(item.userId, existing.id);
    }

    const doneRow: any = db.prepare('SELECT COUNT(*) as cnt FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
    db.prepare(`
      UPDATE download_jobs
      SET downloaded_tracks = ?, current_track = ?
      WHERE id = ?
    `).run(doneRow?.cnt || 0, `${track.artist} - ${track.title}`, jobId);
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
  const searchQuery = `ytsearch1:${track.artist} - ${track.title} audio`;

  await new Promise<void>((resolve) => {
    let isSettled = false;
    const safeResolve = () => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timeoutTimer);
        resolve();
      }
    };

    // Launch yt-dlp with low CPU/IO priority
    const ytDlpProcess = spawn('nice', [
      '-n', '19',
      'ionice', '-c', '3',
      'yt-dlp',
      '--no-playlist',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--embed-thumbnail',
      '--add-metadata',
      '-o', outputTemplate,
      searchQuery
    ]);

    // 100-second per-track safety timeout
    const timeoutTimer = setTimeout(() => {
      if (!isSettled) {
        console.warn(`[yt-dlp timeout] Track "${track.artist} - ${track.title}" timed out after 100s. Killing process.`);
        try { ytDlpProcess.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => {
          try { ytDlpProcess.kill('SIGKILL'); } catch (_) {}
        }, 3000);
        safeResolve();
      }
    }, 100000);

    ytDlpProcess.on('close', (code) => {
      if (isSettled) return;

      if (code === 0) {
        // Find saved file
        const finalFile = path.join(targetDir, `${safeTitle}.mp3`);
        const durationSec = Math.round(track.duration_ms / 1000) || 180;

        try {
          const info = db.prepare(`
            INSERT INTO tracks (title, artist, album, duration_ms, file_path, cover_url, spotify_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            track.title,
            track.artist,
            track.album,
            track.duration_ms,
            finalFile,
            track.cover_url || '',
            track.id
          );

          const trackId = info.lastInsertRowid;
          db.prepare(`
            INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
            VALUES (?, ?, ?)
          `).run(playlistId, trackId, position);

          const playlistRow: any = db.prepare('SELECT name FROM playlists WHERE id = ?').get(playlistId);
          if (playlistRow && (playlistRow.name === 'Любимые треки' || playlistRow.name.toLowerCase() === 'liked songs')) {
            db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(item.userId, trackId);
          }

          const doneRow: any = db.prepare('SELECT COUNT(*) as cnt FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
          db.prepare(`
            UPDATE download_jobs
            SET downloaded_tracks = ?
            WHERE id = ?
          `).run(doneRow?.cnt || 0, jobId);
        } catch (dbErr: any) {
          console.error('[DB Insert Error after download]', dbErr.message);
        }

        safeResolve();
      } else {
        console.warn(`[yt-dlp] Process exited with code ${code} for "${track.artist} - ${track.title}"`);
        safeResolve(); // Continue with next track even if one failed
      }
    });

    ytDlpProcess.on('error', (err) => {
      if (isSettled) return;
      console.warn(`[yt-dlp spawn error]:`, err.message);
      safeResolve();
    });
  });
}
