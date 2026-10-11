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
import { fetchSpotifyPlaylist, getSpotifyCredentials } from './spotify';
import { enqueuePlaylistDownload } from './downloader';
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

// Public frontend static files
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  server.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
  });
}

// Authentication Decorator
server.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.status(401).send({ error: 'Требуется авторизация' });
  }
});

// Helper auth interface
interface AuthUser {
  id: number;
  username: string;
}

// ----------------- AUTH ROUTES -----------------
server.post('/api/auth/register', async (req: FastifyRequest<{ Body: any }>, reply) => {
  const { username, password, display_name } = req.body;
  if (!username || !password) {
    return reply.status(400).send({ error: 'Логин и пароль обязательны' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return reply.status(400).send({ error: 'Пользователь с таким именем уже существует' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, display_name)
    VALUES (?, ?, ?)
  `).run(username, passwordHash, display_name || username);

  const userId = Number(info.lastInsertRowid);
  const countRow: any = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
  const totalUsers = countRow?.cnt || 1;

  // Check and notify if users >= 5
  checkAndNotifyUserLimit(totalUsers).catch(() => {});

  const token = server.jwt.sign({ id: userId, username });
  return {
    token,
    user: { id: userId, username, display_name: display_name || username }
  };
});

server.post('/api/auth/login', async (req: FastifyRequest<{ Body: any }>, reply) => {
  const { username, password } = req.body;
  const user: any = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return reply.status(401).send({ error: 'Неверный логин или пароль' });
  }

  const token = server.jwt.sign({ id: user.id, username: user.username });
  return {
    token,
    user: { id: user.id, username: user.username, display_name: user.display_name }
  };
});

server.get('/api/auth/me', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const user: any = db.prepare('SELECT id, username, display_name, created_at FROM users WHERE id = ?').get(req.user.id);
  return { user };
});

server.put('/api/auth/profile', { preHandler: [(server as any).authenticate] }, async (req: any, reply) => {
  const { display_name } = req.body;
  if (!display_name) {
    return reply.status(400).send({ error: 'Имя не может быть пустым' });
  }
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name, req.user.id);
  return { success: true, display_name };
});

server.put('/api/auth/password', { preHandler: [(server as any).authenticate] }, async (req: any, reply) => {
  const { current_password, new_password } = req.body;
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

server.delete('/api/auth/account', { preHandler: [(server as any).authenticate] }, async (req: any, reply) => {
  const { password } = req.body;
  const user: any = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return reply.status(400).send({ error: 'Неверный пароль. Удаление отменено.' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  return { success: true, message: 'Аккаунт успешно удален' };
});

// ----------------- AUDIO STREAMING (Range requests, Direct Stream) -----------------
server.get('/api/stream/:trackId', async (req: FastifyRequest<{ Params: { trackId: string } }>, reply) => {
  const trackId = req.params.trackId;
  const track: any = db.prepare('SELECT file_path FROM tracks WHERE id = ?').get(trackId);
  if (!track || !fs.existsSync(track.file_path)) {
    return reply.status(404).send({ error: 'Аудиофайл не найден' });
  }

  const filePath = track.file_path;
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;

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
      'Content-Type': 'audio/mpeg'
    });
    return reply.send(fileStream);
  } else {
    reply.raw.writeHead(200, {
      'Content-Length': total,
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes'
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

server.post('/api/playlists', { preHandler: [(server as any).authenticate] }, async (req: any, reply) => {
  const { name, description } = req.body;
  if (!name) return reply.status(400).send({ error: 'Название обязательно' });

  const info = db.prepare(`
    INSERT INTO playlists (user_id, name, description)
    VALUES (?, ?, ?)
  `).run(req.user.id, name, description || '');

  return { id: info.lastInsertRowid, name, description };
});

server.get('/api/playlists/:id', { preHandler: [(server as any).authenticate] }, async (req: any, reply) => {
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

  return { playlist, tracks };
});

server.delete('/api/playlists/:id', { preHandler: [(server as any).authenticate] }, async (req: any, reply) => {
  db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  return { success: true };
});

server.delete('/api/playlists/:id/tracks/:trackId', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').run(req.params.id, req.params.trackId);
  return { success: true };
});

// ----------------- SPOTIFY IMPORT -----------------
server.post('/api/spotify/import', { preHandler: [(server as any).authenticate] }, async (req: any, reply) => {
  const { url } = req.body;
  if (!url) return reply.status(400).send({ error: 'Укажите ссылку на плейлист Spotify' });

  try {
    const playlistData = await fetchSpotifyPlaylist(url);
    if (!playlistData.tracks || playlistData.tracks.length === 0) {
      return reply.status(400).send({ error: 'Не удалось извлечь треки из плейлиста' });
    }

    // Create playlist in DB
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
    LIMIT 5
  `).all(req.user.id);
  return { jobs };
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
  if (exists) {
    db.prepare('DELETE FROM liked_tracks WHERE user_id = ? AND track_id = ?').run(req.user.id, trackId);
    return { liked: false };
  } else {
    db.prepare('INSERT INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(req.user.id, trackId);
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

server.post('/api/blacklist', { preHandler: [(server as any).authenticate] }, async (req: any, reply) => {
  const { title, artist, spotify_id } = req.body;
  if (!title || !artist) return reply.status(400).send({ error: 'Название и артист обязательны' });

  db.prepare(`
    INSERT INTO blacklist (user_id, title, artist, spotify_id)
    VALUES (?, ?, ?, ?)
  `).run(req.user.id, title, artist, spotify_id || '');

  return { success: true };
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
  const { clientId, clientSecret } = req.body;
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
server.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`[Jellyfin-Spotify] Server running at ${address}`);
});
