import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import jwt from '@fastify/jwt';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { db } from './db';
import { checkAndNotifyUserLimit } from './notify';
import { 
  fetchSpotifyPlaylist, 
  getSpotifyCredentials, 
  extractPlaylistId, 
  searchSpotifyTracks,
  getSpotifyAuthUrl,
  handleSpotifyOAuthCallback,
  disconnectSpotify,
  fetchSpotifyLikedSongs,
  parseTrackListText,
  getUserSpotifyToken
} from './spotify';
import { 
  enqueuePlaylistDownload, 
  resumePendingDownloads, 
  resumePlaylistDownload, 
  downloadSingleSpotifyTrackDirect,
  reDownloadAllTracksInHighQuality,
  getUpgradeProgress 
} from './downloader';
import { getRecommendations } from './recommendations';
import { getJellyfinStatus } from './jellyfin';

dotenv.config();

const server = Fastify({ logger: false });

const PORT = Number(process.env.PORT) || 5050;
const JWT_SECRET = process.env.JWT_SECRET || 'catppuccin-jellyfin-spotify-secret-key';
const MUSIC_DIR = process.env.MUSIC_DIR || path.join(process.cwd(), 'music');

// Register Plugins
server.register(cors, { origin: true });
server.register(jwt, { secret: JWT_SECRET });

// Handle empty JSON bodies gracefully without throwing 400
server.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    const json = (body && typeof body === 'string' && body.trim().length > 0) ? JSON.parse(body) : {};
    done(null, json);
  } catch (err: any) {
    err.statusCode = 400;
    done(err, undefined);
  }
});

// Public frontend static files
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  server.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
  });
}

// Authentication Decorator
server.decorate('authenticate', async (request: any, reply: any) => {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.status(401).send({ error: 'Требуется авторизация' });
  }
});

// ----------------- AUTH ROUTES -----------------
server.post('/api/auth/register', async (req: any, reply: any) => {
  const body = req.body || {};
  const { username, password, confirm_password, display_name, email } = body;
  if (!username || !password) {
    return reply.status(400).send({ error: 'Логин и пароль обязательны' });
  }

  if (confirm_password && password !== confirm_password) {
    return reply.status(400).send({ error: 'Пароли не совпадают' });
  }

  const cleanUser = String(username).trim();
  const resolvedEmail = email ? String(email).trim() : (cleanUser.includes('@') ? cleanUser : null);

  const existing = db.prepare(`
    SELECT id FROM users 
    WHERE username = ? 
       OR (email IS NOT NULL AND email = ?)
       OR (email IS NOT NULL AND email = ?)
  `).get(cleanUser, cleanUser, resolvedEmail || '');

  if (existing) {
    return reply.status(400).send({ error: 'Пользователь с таким логином или email уже существует' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, email)
    VALUES (?, ?, ?, ?)
  `).run(cleanUser, passwordHash, display_name || cleanUser, resolvedEmail);

  const userId = Number(info.lastInsertRowid);
  const countRow: any = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
  const totalUsers = countRow?.cnt || 1;

  // Check and notify if users >= 5
  checkAndNotifyUserLimit(totalUsers).catch(() => {});

  const token = server.jwt.sign({ id: userId, username: cleanUser });
  return {
    token,
    user: { id: userId, username: cleanUser, display_name: display_name || cleanUser, email: resolvedEmail }
  };
});

server.post('/api/auth/login', async (req: any, reply: any) => {
  const body = req.body || {};
  const { username, password } = body;
  const cleanIdentifier = String(username || '').trim();
  const user: any = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(cleanIdentifier, cleanIdentifier);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return reply.status(401).send({ error: 'Неверный логин или пароль' });
  }

  const token = server.jwt.sign({ id: user.id, username: user.username });
  return {
    token,
    user: { id: user.id, username: user.username, display_name: user.display_name, email: user.email }
  };
});

server.get('/api/auth/me', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const user: any = db.prepare('SELECT id, username, display_name, created_at FROM users WHERE id = ?').get(req.user.id);
  return { user };
});

server.put('/api/auth/profile', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const body = req.body || {};
  const { display_name } = body;
  if (!display_name) {
    return reply.status(400).send({ error: 'Имя не может быть пустым' });
  }
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name, req.user.id);
  return { success: true, display_name };
});

server.put('/api/auth/password', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const body = req.body || {};
  const { current_password, new_password } = body;
  const user: any = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
    return reply.status(400).send({ error: 'Текущий пароль указан неверно' });
  }
  if (!new_password || new_password.length < 4) {
    return reply.status(400).send({ error: 'Новый пароль слишком короткий' });
  }

  const newHash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);
  return { success: true, message: 'Пароль успешно обновлен' };
});

server.delete('/api/auth/account', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const body = req.body || {};
  const { password } = body;
  const user: any = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return reply.status(400).send({ error: 'Неверный пароль. Удаление отменено.' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  return { success: true, message: 'Аккаунт успешно удален' };
});

// ----------------- AUDIO STREAMING (Range requests, Direct Stream) -----------------
server.get('/api/stream/:trackId', async (req: any, reply: any) => {
  const trackId = req.params.trackId;
  const track: any = db.prepare('SELECT file_path FROM tracks WHERE id = ?').get(trackId);
  if (!track || !fs.existsSync(track.file_path)) {
    return reply.status(404).send({ error: 'Аудиофайл не найден' });
  }

  const filePath = track.file_path;
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;

  const ext = path.extname(filePath).toLowerCase();
  let contentType = 'audio/mpeg';
  if (ext === '.m4a' || ext === '.aac') contentType = 'audio/mp4';
  else if (ext === '.ogg' || ext === '.opus') contentType = 'audio/ogg';
  else if (ext === '.flac') contentType = 'audio/flac';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const partialstart = parts[0];
    const partialend = parts[1];
    const start = parseInt(partialstart, 10);
    const end = partialend ? parseInt(partialend, 10) : total - 1;
    const chunksize = (end - start) + 1;
    const fileStream = fs.createReadStream(filePath, { start, end });

    reply.raw.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    return reply.send(fileStream);
  } else {
    reply.raw.writeHead(200, {
      'Content-Length': total,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*'
    });
    return reply.send(fs.createReadStream(filePath));
  }
});

// ----------------- PLAYLISTS -----------------
server.get('/api/playlists', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const playlists = db.prepare(`
    SELECT p.*, COUNT(pt.track_id) as track_count
    FROM playlists p
    LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
    WHERE p.user_id = ?
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `).all(req.user.id);
  return { playlists };
});

server.post('/api/playlists', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const body = req.body || {};
  const { name, description } = body;
  if (!name || !name.trim()) return reply.status(400).send({ error: 'Название обязательно' });

  const cleanName = name.trim();
  const existing = db.prepare('SELECT id FROM playlists WHERE user_id = ? AND LOWER(name) = LOWER(?)').get(req.user.id, cleanName);
  if (existing) {
    return reply.status(400).send({ error: 'Плейлист с таким названием уже существует' });
  }

  const info = db.prepare(`
    INSERT INTO playlists (user_id, name, description)
    VALUES (?, ?, ?)
  `).run(req.user.id, cleanName, description || '');

  return { id: info.lastInsertRowid, name: cleanName, description };
});

server.get('/api/playlists/:id', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const playlistId = req.params.id;
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, req.user.id);
  if (!playlist) return reply.status(404).send({ error: 'Плейлист не найден' });

  const tracks = db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, t.duration_ms, t.cover_url, pt.added_at, pt.position
    FROM playlist_tracks pt
    JOIN tracks t ON pt.track_id = t.id
    WHERE pt.playlist_id = ?
    ORDER BY pt.position ASC
  `).all(playlistId);

  const activeJob: any = db.prepare(`
    SELECT * FROM download_jobs
    WHERE playlist_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(playlistId);

  return { playlist, tracks, activeJob: activeJob || null };
});

server.put('/api/playlists/:id/cover', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const playlistId = Number(req.params.id);
  const playlist = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, req.user.id);
  if (!playlist) return reply.status(404).send({ error: 'Плейлист не найден' });

  const body = req.body || {};
  const { image_base64, cover_url } = body;
  let finalUrl = cover_url;

  if (image_base64) {
    const coversDir = path.join(process.cwd(), 'data', 'covers');
    if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

    const base64Data = image_base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const filePath = path.join(coversDir, `playlist_${playlistId}.jpg`);
    fs.writeFileSync(filePath, buffer);
    finalUrl = `/api/playlists/${playlistId}/cover?t=${Date.now()}`;
  }

  if (!finalUrl) {
    return reply.status(400).send({ error: 'Изображение не предоставлено' });
  }

  db.prepare('UPDATE playlists SET cover_url = ? WHERE id = ?').run(finalUrl, playlistId);
  return { success: true, cover_url: finalUrl };
});

server.get('/api/playlists/:id/cover', async (req: any, reply: any) => {
  const playlistId = Number(req.params.id);
  const coversDir = path.join(process.cwd(), 'data', 'covers');
  const filePath = path.join(coversDir, `playlist_${playlistId}.jpg`);
  if (fs.existsSync(filePath)) {
    reply.type('image/jpeg').header('Cache-Control', 'public, max-age=86400').send(fs.readFileSync(filePath));
  } else {
    reply.status(404).send('Cover not found');
  }
});

server.delete('/api/playlists/:id', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const playlistId = req.params.id;
  db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId);
  db.prepare('DELETE FROM download_jobs WHERE playlist_id = ?').run(playlistId);
  db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(playlistId, req.user.id);
  return { success: true };
});

server.delete('/api/playlists/:id/tracks/:trackId', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').run(req.params.id, req.params.trackId);
  return { success: true };
});

server.post('/api/playlists/:id/tracks', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const playlistId = Number(req.params.id);
  const body = req.body || {};
  const trackId = Number(body.trackId);
  if (!trackId) return reply.status(400).send({ error: 'trackId обязателен' });

  const playlist = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, req.user.id);
  if (!playlist) return reply.status(404).send({ error: 'Плейлист не найден' });

  const maxPosRow: any = db.prepare('SELECT MAX(position) as maxPos FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
  const nextPos = (maxPosRow?.maxPos !== null && maxPosRow?.maxPos !== undefined) ? maxPosRow.maxPos + 1 : 0;

  db.prepare(`
    INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
    VALUES (?, ?, ?)
  `).run(playlistId, trackId, nextPos);

  return { success: true };
});

server.get('/api/tracks/:id/playlists', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const trackId = Number(req.params.id);
  const playlists = db.prepare(`
    SELECT p.id, p.name, p.cover_url, COUNT(pt_all.track_id) as track_count,
           CASE WHEN EXISTS (SELECT 1 FROM playlist_tracks pt WHERE pt.playlist_id = p.id AND pt.track_id = ?) THEN 1 ELSE 0 END as has_track
    FROM playlists p
    LEFT JOIN playlist_tracks pt_all ON p.id = pt_all.playlist_id
    WHERE p.user_id = ?
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `).all(trackId, req.user.id);

  return { playlists };
});

// ----------------- SPOTIFY IMPORT -----------------
server.post('/api/spotify/import', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const body = req.body || {};
  const { url } = body;
  if (!url) return reply.status(400).send({ error: 'Укажите ссылку на плейлист Spotify' });

  try {
    const playlistData = await fetchSpotifyPlaylist(url, req.user.id);
    if (!playlistData.tracks || playlistData.tracks.length === 0) {
      return reply.status(400).send({ error: 'Не удалось извлечь треки из плейлиста' });
    }

    const cleanSpotifyId = extractPlaylistId(url);

    // Check if user already has this playlist imported (by Spotify ID or matching title)
    let existingPlaylist: any = null;
    if (cleanSpotifyId) {
      existingPlaylist = db.prepare(`
        SELECT * FROM playlists 
        WHERE user_id = ? AND spotify_id LIKE ?
        ORDER BY id ASC LIMIT 1
      `).get(req.user.id, `%${cleanSpotifyId}%`);
    }

    if (!existingPlaylist && playlistData.name) {
      existingPlaylist = db.prepare(`
        SELECT * FROM playlists 
        WHERE user_id = ? AND LOWER(name) = LOWER(?)
        ORDER BY id ASC LIMIT 1
      `).get(req.user.id, playlistData.name);
    }

    if (existingPlaylist) {
      const playlistId = existingPlaylist.id;

      // Existing tracks linked to this playlist
      const existingRows: any[] = db.prepare(`
        SELECT t.id, t.spotify_id, LOWER(t.title) as title, LOWER(t.artist) as artist
        FROM playlist_tracks pt
        JOIN tracks t ON pt.track_id = t.id
        WHERE pt.playlist_id = ?
      `).all(playlistId);

      // Determine which tracks from Spotify are not yet added to this playlist
      const missingTracks = playlistData.tracks.filter((st) => {
        return !existingRows.some((er) => {
          if (st.id && er.spotify_id && er.spotify_id === st.id) return true;
          return er.title === st.title.toLowerCase().trim() && er.artist === st.artist.toLowerCase().trim();
        });
      });

      if (missingTracks.length === 0) {
        return {
          success: true,
          playlistId,
          playlistName: existingPlaylist.name,
          alreadyUpToDate: true,
          totalTracks: existingRows.length,
          newTracks: 0,
          message: 'Все треки из этого плейлиста уже загружены!'
        };
      }

      // Enqueue only the missing tracks
      const jobId = Math.random().toString(36).substring(2, 10);
      const totalCount = existingRows.length + missingTracks.length;

      db.prepare(`
        INSERT INTO download_jobs (id, user_id, playlist_id, playlist_name, total_tracks, downloaded_tracks, status)
        VALUES (?, ?, ?, ?, ?, ?, 'downloading')
      `).run(jobId, req.user.id, playlistId, existingPlaylist.name, totalCount, existingRows.length);

      enqueuePlaylistDownload(jobId, req.user.id, playlistId, missingTracks);

      return {
        success: true,
        jobId,
        playlistId,
        playlistName: existingPlaylist.name,
        isUpdate: true,
        newTracks: missingTracks.length,
        totalTracks: totalCount,
        message: `Найдено новых треков: ${missingTracks.length}. Загрузка начата.`
      };
    }

    // Create new playlist in DB
    const pInfo = db.prepare(`
      INSERT INTO playlists (user_id, name, description, cover_url, spotify_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      playlistData.name,
      playlistData.description || 'Импортировано из Spotify',
      playlistData.cover_url || '',
      url
    );

    const playlistId = Number(pInfo.lastInsertRowid);
    const jobId = Math.random().toString(36).substring(2, 10);

    // Create download job
    db.prepare(`
      INSERT INTO download_jobs (id, user_id, playlist_id, playlist_name, total_tracks, downloaded_tracks, status)
      VALUES (?, ?, ?, ?, ?, 0, 'downloading')
    `).run(jobId, req.user.id, playlistId, playlistData.name, playlistData.tracks.length);

    // Enqueue background throttled download
    enqueuePlaylistDownload(jobId, req.user.id, playlistId, playlistData.tracks);

    return {
      success: true,
      jobId,
      playlistId,
      playlistName: playlistData.name,
      totalTracks: playlistData.tracks.length
    };
  } catch (err: any) {
    return reply.status(500).send({ error: err.message || 'Ошибка парсинга Spotify' });
  }
});

server.get('/api/spotify/jobs', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const jobs = db.prepare(`
    SELECT * FROM download_jobs
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(req.user.id);
  return { jobs };
});

server.delete('/api/spotify/jobs/:id', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  db.prepare('DELETE FROM download_jobs WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  return { success: true };
});

server.delete('/api/spotify/jobs', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  db.prepare("DELETE FROM download_jobs WHERE user_id = ? AND status IN ('completed', 'failed')").run(req.user.id);
  return { success: true };
});

server.post('/api/playlists/:id/resume', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const playlistId = Number(req.params.id);
  const result = await resumePlaylistDownload(playlistId);
  return result;
});

// ----------------- SPOTIFY OAUTH & ADVANCED IMPORT -----------------
server.get('/api/spotify/auth-url', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  try {
    const userRow: any = db.prepare('SELECT spotify_access_token, spotify_display_name, spotify_user_id FROM users WHERE id = ?').get(req.user.id);
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    const proto = req.headers['x-forwarded-proto'] || (req.raw.socket.encrypted ? 'https' : 'http');
    const redirectUri = `${proto}://${host}/api/spotify/callback`;
    const origin = `${proto}://${host}`;

    const creds = getSpotifyCredentials();
    if (!creds.clientId || !creds.clientSecret) {
      return {
        configured: false,
        isConnected: false,
        error: 'Spotify Client ID / Secret не настроены в Настройках'
      };
    }

    const authUrl = getSpotifyAuthUrl(req.user.id, redirectUri, origin);
    return {
      configured: true,
      authUrl,
      redirectUri,
      isConnected: Boolean(userRow?.spotify_access_token),
      spotifyDisplayName: userRow?.spotify_display_name || userRow?.spotify_user_id || ''
    };
  } catch (err: any) {
    return reply.status(500).send({ error: err.message });
  }
});

server.get('/api/spotify/callback', async (req: any, reply: any) => {
  const code = req.query.code;
  const state = req.query.state;
  const error = req.query.error;

  console.log('[Spotify Callback]', {
    url: req.raw.url,
    query: req.query,
    hasCode: Boolean(code),
    hasState: Boolean(state),
    error: error || null
  });

  if (error || !code || !state) {
    console.warn('[Spotify Callback Missing Code/State]', { error, hasCode: Boolean(code), hasState: Boolean(state) });
    return reply.redirect('/settings?spotify_error=' + encodeURIComponent(error || 'Отсутствует код авторизации'));
  }

  try {
    const result = await handleSpotifyOAuthCallback(code, state);
    console.log('[Spotify Callback Success]', { userId: (result as any)?.userId });
    return reply.redirect('/settings?spotify_connected=1');
  } catch (err: any) {
    console.error('[Spotify OAuth Callback Error]', err.message);
    return reply.redirect('/settings?spotify_error=' + encodeURIComponent(err.message));
  }
});

server.post('/api/spotify/disconnect', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  disconnectSpotify(req.user.id);
  return { success: true };
});

server.post('/api/spotify/import-liked', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  try {
    const playlistData = await fetchSpotifyLikedSongs(req.user.id);
    if (!playlistData.tracks || playlistData.tracks.length === 0) {
      return reply.status(400).send({ error: 'В вашем разделе «Любимые треки» Spotify нет песен' });
    }

    // Find or create 'Любимые треки' playlist
    let existingPlaylist: any = db.prepare(`
      SELECT * FROM playlists WHERE user_id = ? AND (name = 'Любимые треки' OR LOWER(name) = 'liked songs')
      LIMIT 1
    `).get(req.user.id);

    let playlistId: number;
    if (!existingPlaylist) {
      const pInfo = db.prepare(`
        INSERT INTO playlists (user_id, name, description, cover_url)
        VALUES (?, 'Любимые треки', 'Синхронизировано из Spotify Liked Songs', ?)
      `).run(req.user.id, playlistData.cover_url || '');
      playlistId = Number(pInfo.lastInsertRowid);
    } else {
      playlistId = existingPlaylist.id;
    }

    // Existing tracks
    const existingRows: any[] = db.prepare(`
      SELECT t.id, t.spotify_id, LOWER(t.title) as title, LOWER(t.artist) as artist
      FROM playlist_tracks pt
      JOIN tracks t ON pt.track_id = t.id
      WHERE pt.playlist_id = ?
    `).all(playlistId);

    const missingTracks = playlistData.tracks.filter((st) => {
      return !existingRows.some((er) => {
        if (st.id && er.spotify_id && er.spotify_id === st.id) return true;
        return er.title === st.title.toLowerCase().trim() && er.artist === st.artist.toLowerCase().trim();
      });
    });

    if (missingTracks.length === 0) {
      return {
        success: true,
        playlistId,
        playlistName: 'Любимые треки',
        alreadyUpToDate: true,
        totalTracks: existingRows.length,
        newTracks: 0,
        message: 'Все любимые треки уже синхронизированы!'
      };
    }

    const jobId = Math.random().toString(36).substring(2, 10);
    const totalCount = existingRows.length + missingTracks.length;

    db.prepare(`
      INSERT INTO download_jobs (id, user_id, playlist_id, playlist_name, total_tracks, downloaded_tracks, status)
      VALUES (?, ?, ?, 'Любимые треки', ?, ?, 'downloading')
    `).run(jobId, req.user.id, playlistId, totalCount, existingRows.length);

    enqueuePlaylistDownload(jobId, req.user.id, playlistId, missingTracks);

    return {
      success: true,
      jobId,
      playlistId,
      playlistName: 'Любимые треки',
      newTracks: missingTracks.length,
      totalTracks: totalCount,
      message: `Найдено новых любимых треков: ${missingTracks.length}. Загрузка начата.`
    };
  } catch (err: any) {
    return reply.status(500).send({ error: err.message || 'Ошибка импорта любимых треков' });
  }
});

server.post('/api/spotify/import-list', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const body = req.body || {};
  const { text, playlistName, playlistId: requestedPlaylistId } = body;
  if (!text || !text.trim()) {
    return reply.status(400).send({ error: 'Вставьте список треков или ссылок' });
  }

  try {
    const tracks = await parseTrackListText(text, req.user.id);
    if (!tracks || tracks.length === 0) {
      return reply.status(400).send({ error: 'Не удалось распознать ни одного трека из текста' });
    }

    let targetPlaylistId = requestedPlaylistId ? Number(requestedPlaylistId) : null;
    let finalPlaylistName = playlistName ? playlistName.trim() : 'Импортированный список';

    if (targetPlaylistId) {
      const pl: any = db.prepare('SELECT id, name FROM playlists WHERE id = ? AND user_id = ?').get(targetPlaylistId, req.user.id);
      if (pl) {
        finalPlaylistName = pl.name;
      } else {
        targetPlaylistId = null;
      }
    }

    if (!targetPlaylistId) {
      const existing: any = db.prepare('SELECT id FROM playlists WHERE user_id = ? AND LOWER(name) = LOWER(?)').get(req.user.id, finalPlaylistName);
      if (existing) {
        targetPlaylistId = existing.id;
      } else {
        const pInfo = db.prepare(`
          INSERT INTO playlists (user_id, name, description, cover_url)
          VALUES (?, ?, 'Импортировано из списка треков', ?)
        `).run(req.user.id, finalPlaylistName, tracks[0]?.cover_url || '');
        targetPlaylistId = Number(pInfo.lastInsertRowid);
      }
    }

    const existingRows: any[] = db.prepare(`
      SELECT t.id, t.spotify_id, LOWER(t.title) as title, LOWER(t.artist) as artist
      FROM playlist_tracks pt
      JOIN tracks t ON pt.track_id = t.id
      WHERE pt.playlist_id = ?
    `).all(targetPlaylistId);

    const missingTracks = tracks.filter((st) => {
      return !existingRows.some((er) => {
        if (st.id && er.spotify_id && er.spotify_id === st.id) return true;
        return er.title === st.title.toLowerCase().trim() && er.artist === st.artist.toLowerCase().trim();
      });
    });

    if (missingTracks.length === 0) {
      return {
        success: true,
        playlistId: targetPlaylistId,
        playlistName: finalPlaylistName,
        alreadyUpToDate: true,
        totalTracks: existingRows.length,
        newTracks: 0,
        message: 'Все треки из списка уже загружены в этот плейлист!'
      };
    }

    const jobId = Math.random().toString(36).substring(2, 10);
    const totalCount = existingRows.length + missingTracks.length;

    db.prepare(`
      INSERT INTO download_jobs (id, user_id, playlist_id, playlist_name, total_tracks, downloaded_tracks, status)
      VALUES (?, ?, ?, ?, ?, ?, 'downloading')
    `).run(jobId, req.user.id, targetPlaylistId, finalPlaylistName, totalCount, existingRows.length);

    enqueuePlaylistDownload(jobId, req.user.id, targetPlaylistId, missingTracks);

    return {
      success: true,
      jobId,
      playlistId: targetPlaylistId,
      playlistName: finalPlaylistName,
      newTracks: missingTracks.length,
      totalTracks: totalCount,
      message: `Распознано треков: ${missingTracks.length}. Загрузка начата.`
    };
  } catch (err: any) {
    return reply.status(500).send({ error: err.message || 'Ошибка импорта списка треков' });
  }
});

// ----------------- SEARCH (LOCAL MEDIATHEQUE & SPOTIFY) -----------------
server.get('/api/search', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const query = (req.query.q || '').trim();
  if (!query) {
    return { localTracks: [], spotifyTracks: [] };
  }

  // 1. Search Local Database (up to 5 tracks, deduplicated by title & artist)
  const localTracks = db.prepare(`
    SELECT * FROM tracks
    WHERE LOWER(title) LIKE LOWER(?) OR LOWER(artist) LIKE LOWER(?) OR LOWER(album) LIKE LOWER(?)
    GROUP BY LOWER(title), LOWER(artist)
    ORDER BY
      CASE WHEN LOWER(title) = LOWER(?) THEN 1
           WHEN LOWER(title) LIKE LOWER(?) THEN 2
           ELSE 3 END
    LIMIT 5
  `).all(`%${query}%`, `%${query}%`, `%${query}%`, query, `${query}%`);

  // 2. Search Spotify API (up to 5 tracks)
  let spotifyRaw: any[] = [];
  try {
    spotifyRaw = await searchSpotifyTracks(query, 5);
  } catch (err: any) {
    console.warn('[Search Spotify Error]', err.message);
  }

  // Map each Spotify track and check if already downloaded
  const spotifyTracks = spotifyRaw.map((st) => {
    const matchedLocal: any = db.prepare(`
      SELECT * FROM tracks
      WHERE (spotify_id IS NOT NULL AND spotify_id = ?)
         OR (LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?))
      LIMIT 1
    `).get(st.id, st.title, st.artist);

    return {
      ...st,
      is_downloaded: !!matchedLocal,
      local_track_id: matchedLocal?.id || null,
      local_track: matchedLocal || null
    };
  });

  return { localTracks, spotifyTracks };
});

server.post('/api/tracks/download-single', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const body = req.body || {};
  const { track, playlistId } = body;
  if (!track || !track.title || !track.artist) {
    return reply.status(400).send({ error: 'Трек не указан или отсутствуют данные' });
  }

  const result = await downloadSingleSpotifyTrackDirect(track, req.user.id, playlistId ? Number(playlistId) : undefined);
  if (!result.success) {
    return reply.status(500).send({ error: result.error || 'Ошибка скачивания трека' });
  }
  return result;
});

server.post('/api/tracks/upgrade-quality', { preHandler: [(server as any).authenticate] }, async () => {
  return await reDownloadAllTracksInHighQuality();
});

server.get('/api/tracks/upgrade-quality/status', { preHandler: [(server as any).authenticate] }, async () => {
  return getUpgradeProgress();
});

// ----------------- LIKES -----------------
server.get('/api/likes', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const tracks = db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, t.duration_ms, t.cover_url, lt.created_at as added_at
    FROM liked_tracks lt
    JOIN tracks t ON lt.track_id = t.id
    WHERE lt.user_id = ?
    ORDER BY lt.created_at DESC
  `).all(req.user.id);
  return { tracks };
});

server.post('/api/likes/:trackId', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const trackId = Number(req.params.trackId);
  const exists = db.prepare('SELECT 1 FROM liked_tracks WHERE user_id = ? AND track_id = ?').get(req.user.id, trackId);

  // Check if user has an imported playlist named 'Любимые треки'
  const favPlaylist: any = db.prepare(`
    SELECT id FROM playlists WHERE user_id = ? AND (name = 'Любимые треки' OR LOWER(name) = 'liked songs')
  `).get(req.user.id);

  if (exists) {
    db.prepare('DELETE FROM liked_tracks WHERE user_id = ? AND track_id = ?').run(req.user.id, trackId);
    if (favPlaylist) {
      db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').run(favPlaylist.id, trackId);
    }
    return { liked: false };
  } else {
    db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(req.user.id, trackId);
    if (favPlaylist) {
      const maxPosRow: any = db.prepare('SELECT MAX(position) as maxPos FROM playlist_tracks WHERE playlist_id = ?').get(favPlaylist.id);
      const nextPos = (maxPosRow?.maxPos !== null && maxPosRow?.maxPos !== undefined) ? maxPosRow.maxPos + 1 : 0;
      db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)').run(favPlaylist.id, trackId, nextPos);
    }
    return { liked: true };
  }
});

// ----------------- BLACKLIST (SETTINGS) -----------------
server.get('/api/blacklist', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const list = db.prepare(`
    SELECT * FROM blacklist WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.user.id);
  return { blacklist: list };
});

server.post('/api/blacklist', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const body = req.body || {};
  const { title, artist, spotify_id, track_id } = body;
  if (!title || !artist) return reply.status(400).send({ error: 'Название и артист обязательны' });

  // 1. Add to blacklist if not already added
  const existing = db.prepare(
    'SELECT id FROM blacklist WHERE user_id = ? AND LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?)'
  ).get(req.user.id, title, artist);
  if (!existing) {
    db.prepare(`
      INSERT INTO blacklist (user_id, title, artist, spotify_id)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, title, artist, spotify_id || '');
  }

  // 2. Remove this track from ALL playlists owned by this user
  const targetTrackIds: number[] = [];
  if (track_id) {
    targetTrackIds.push(Number(track_id));
  }
  const matchingTracks: any[] = db.prepare(
    'SELECT id FROM tracks WHERE LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?)'
  ).all(title, artist);
  for (const mt of matchingTracks) {
    if (!targetTrackIds.includes(mt.id)) {
      targetTrackIds.push(mt.id);
    }
  }

  for (const tid of targetTrackIds) {
    db.prepare(`
      DELETE FROM playlist_tracks 
      WHERE track_id = ? 
        AND playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)
    `).run(tid, req.user.id);

    db.prepare('DELETE FROM liked_tracks WHERE user_id = ? AND track_id = ?').run(req.user.id, tid);
  }

  return { success: true, removedCount: targetTrackIds.length };
});

server.delete('/api/blacklist/:id', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  db.prepare('DELETE FROM blacklist WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  return { success: true };
});

// ----------------- RECOMMENDATIONS & SMART SHUFFLE -----------------
server.get('/api/recommendations', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const artistsQuery = req.query.artists ? String(req.query.artists).split(',') : [];
  const recs = await getRecommendations(req.user.id, artistsQuery);
  return { recommendations: recs };
});

// ----------------- SETTINGS & SYSTEM STATUS -----------------
server.get('/api/settings', { preHandler: [(server as any).authenticate] }, async () => {
  const creds = getSpotifyCredentials();
  const jfStatus = await getJellyfinStatus();
  const countRow: any = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
  const tracksRow: any = db.prepare('SELECT COUNT(*) as cnt FROM tracks').get();

  return {
    hasSpotifyCredentials: Boolean(creds.clientId && creds.clientSecret),
    spotifyClientId: creds.clientId ? `${creds.clientId.slice(0, 6)}...` : '',
    jellyfin: jfStatus,
    stats: {
      users: countRow?.cnt || 0,
      tracks: tracksRow?.cnt || 0
    }
  };
});

server.post('/api/settings', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const body = req.body || {};
  const { clientId, clientSecret } = body;
  if (clientId) {
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('spotify_client_id', ?) ON CONFLICT(key) DO UPDATE SET value = ?`).run(clientId, clientId);
  }
  if (clientSecret) {
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('spotify_client_secret', ?) ON CONFLICT(key) DO UPDATE SET value = ?`).run(clientSecret, clientSecret);
  }
  return { success: true };
});

// SPA Fallback for React PWA routing
server.setNotFoundHandler((req, reply) => {
  if (req.raw.url && req.raw.url.startsWith('/api')) {
    return reply.status(404).send({ error: 'Endpoint not found' });
  }
  const indexPath = path.join(publicDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    reply.type('text/html').send(fs.readFileSync(indexPath));
  } else {
    reply.status(404).send('Not Found');
  }
});

// Start Server
server.listen({ port: PORT, host: '0.0.0.0' }, async (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`[Jellyfin-Spotify] Server running at ${address}`);
  // Automatically resume any downloads that were interrupted
  await resumePendingDownloads();
});
