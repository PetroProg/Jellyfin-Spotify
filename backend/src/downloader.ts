import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { db } from './db';
import { refreshJellyfinLibrary } from './jellyfin';
import { SpotifyTrack } from './spotify';

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

async function runWorkerLoop() {
  if (isWorkerRunning) return;
  isWorkerRunning = true;

  console.log('[Downloader] Background worker loop started.');

  while (queue.length > 0) {
    const item = queue.shift()!;
    try {
      await downloadSingleTrack(item);
    } catch (err: any) {
      console.error(`[Downloader] Error downloading ${item.track.artist} - ${item.track.title}:`, err.message);
    }

    // Check if job finished
    const remainingForJob = queue.filter(q => q.jobId === item.jobId).length;
    if (remainingForJob === 0) {
      db.prepare(`
        UPDATE download_jobs
        SET status = 'completed', current_track = NULL
        WHERE id = ?
      `).run(item.jobId);

      // Trigger library refresh
      await refreshJellyfinLibrary();
    }
  }

  isWorkerRunning = false;
  console.log('[Downloader] Background worker loop idle.');
}

async function downloadSingleTrack(item: QueueItem): Promise<void> {
  const { jobId, playlistId, track, position } = item;

  // Check if track already exists locally in DB
  const existing = db.prepare(`
    SELECT * FROM tracks WHERE spotify_id = ? OR (LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?))
  `).get(track.id, track.title, track.artist) as any;

  if (existing) {
    // Already downloaded, just link to playlist
    db.prepare(`
      INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
      VALUES (?, ?, ?)
    `).run(playlistId, existing.id, position);

    db.prepare(`
      UPDATE download_jobs
      SET downloaded_tracks = downloaded_tracks + 1, current_track = ?
      WHERE id = ?
    `).run(`${track.artist} - ${track.title}`, jobId);
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

  await new Promise<void>((resolve, reject) => {
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

    ytDlpProcess.on('close', (code) => {
      if (code === 0) {
        // Find saved file
        const finalFile = path.join(targetDir, `${safeTitle}.mp3`);
        const durationSec = Math.round(track.duration_ms / 1000) || 180;

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

        db.prepare(`
          UPDATE download_jobs
          SET downloaded_tracks = downloaded_tracks + 1
          WHERE id = ?
        `).run(jobId);

        resolve();
      } else {
        console.warn(`[yt-dlp] Process exited with code ${code} for ${track.title}`);
        resolve(); // Continue with next track even if one failed
      }
    });

    ytDlpProcess.on('error', (err) => {
      console.warn(`[yt-dlp spawn error]:`, err.message);
      resolve();
    });
  });
}
