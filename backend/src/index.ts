import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import jwt from '@fastify/jwt';
import compress from '@fastify/compress';
import zlib from 'zlib';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { Agent, setGlobalDispatcher } from 'undici';
import { db } from './db';
import { checkAndNotifyUserLimit } from './notify';
import { 
  fetchSpotifyPlaylist, 
  getSpotifyCredentials, 
  extractPlaylistId, 
  resolveSpotifyEntityInput,
  searchSpotifyTracks,
  getSpotifyAuthUrl,
  handleSpotifyOAuthCallback,
  disconnectSpotify,
  fetchSpotifyLikedSongs,
  fetchSpotifyUserPlaylists,
  parseTrackListText,
  getUserSpotifyToken,
  resolveDeezerTrackInfo
} from './spotify';
import { 
  enqueuePlaylistDownload, 
  resumePendingDownloads, 
  resumePlaylistDownload, 
  downloadSingleSpotifyTrackDirect,
  reDownloadAllTracksInHighQuality,
  getUpgradeProgress,
  getQualityAuditStats,
  stopQualityUpgrade,
  queueTrackQualityUpgrade,
  cancelBlacklistedDownloads,
  cancelPlaylistDownloads,
  isTrackBlacklistedForUser,
  filterBlacklistedTracksForUser,
  redownloadTrackStudioMaster,
  invalidateUserBlacklistCache,
  getDownloadSchedulerStats
} from './downloader';
import { getRecommendations } from './recommendations';
import { getJellyfinStatus } from './jellyfin';
import { setupWebSocketSync, broadcastToUser, terminateUserSessions } from './sync';
import { getOrGenerateDailyMixes, saveDailyMixAsPlaylist } from './dailyMix';
import { startNightlyScheduler, getNightlySchedulerStatus, updateNightlySchedule } from './nightlyScheduler';
import { getOrGenerateJwtSecret } from './authSecret';

dotenv.config();

// Configure high-performance HTTP(S) Keep-Alive connection pooling across all outbound fetch calls
const globalDispatcher = new Agent({
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: 300000,
  connections: 64,
  connect: {
    timeout: 10000
  }
});
setGlobalDispatcher(globalDispatcher);

const server = Fastify({ 
  logger: false,
  trustProxy: true,
  bodyLimit: 15 * 1024 * 1024 // 15 MB limit for high-res cover uploads and bulk sync payloads
});

const PORT = Number(process.env.PORT) || 5050;

// Security: Use shared persistent secret
export { getOrGenerateJwtSecret };
const JWT_SECRET = getOrGenerateJwtSecret();
const MUSIC_DIR = process.env.MUSIC_DIR || path.join(process.cwd(), 'music');

// Security: In-memory bounded rate limiter with sliding window to block brute-force and abuse
interface RateLimitEntry {
  count: number;
  firstRequestMs: number;
  blockedUntil: number;
}
const rateLimitStore = new Map<string, RateLimitEntry>();

function sweepRateLimitStore() {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.blockedUntil <= now && (now - entry.firstRequestMs > 3600000)) {
      rateLimitStore.delete(key);
    }
  }
  // Hard cap to prevent memory exhaustion under DDoS
  if (rateLimitStore.size > 10000) {
    let toRemove = rateLimitStore.size - 5000;
    for (const key of rateLimitStore.keys()) {
      rateLimitStore.delete(key);
      if (--toRemove <= 0) break;
    }
  }
}

// Periodic cleanup every 5 minutes
const cleanupTimer = setInterval(sweepRateLimitStore, 5 * 60 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();

function isRateLimited(key: string): { blocked: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (entry && entry.blockedUntil > now) {
    return { blocked: true, retryAfterSec: Math.ceil((entry.blockedUntil - now) / 1000) };
  }
  return { blocked: false };
}

function consumeRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number = 60000,
  blockDurationMs?: number
): { blocked: boolean; retryAfterSec?: number } {
  if (rateLimitStore.size > 5000) sweepRateLimitStore();
  const now = Date.now();
  let entry = rateLimitStore.get(key);

  if (!entry) {
    rateLimitStore.set(key, { count: 1, firstRequestMs: now, blockedUntil: 0 });
    return { blocked: false };
  }

  if (entry.blockedUntil > now) {
    return { blocked: true, retryAfterSec: Math.ceil((entry.blockedUntil - now) / 1000) };
  }

  if (now - entry.firstRequestMs > windowMs) {
    entry.count = 1;
    entry.firstRequestMs = now;
    entry.blockedUntil = 0;
    return { blocked: false };
  }

  entry.count++;
  if (entry.count > maxRequests) {
    const blockTime = blockDurationMs || windowMs;
    entry.blockedUntil = now + blockTime;
    return { blocked: true, retryAfterSec: Math.ceil(blockTime / 1000) };
  }

  return { blocked: false };
}

function recordFailedAttempt(
  key: string,
  maxAttempts: number = 5,
  windowMs: number = 60000,
  blockDurationMs: number = 300000
) {
  if (rateLimitStore.size > 5000) sweepRateLimitStore();
  const now = Date.now();
  let entry = rateLimitStore.get(key);
  if (!entry || (now - entry.firstRequestMs > windowMs && entry.blockedUntil <= now)) {
    entry = { count: 1, firstRequestMs: now, blockedUntil: 0 };
  } else {
    entry.count++;
  }

  if (entry.count >= maxAttempts) {
    entry.blockedUntil = now + blockDurationMs;
  }
  rateLimitStore.set(key, entry);
}

function resetRateLimit(key: string) {
  rateLimitStore.delete(key);
}

// Backward-compatibility aliases
const checkRateLimit = isRateLimited;
const recordFailedAuth = recordFailedAttempt;
const resetAuthLimit = resetRateLimit;

// Register Plugins & Security Headers
server.addHook('onSend', async (_request, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'SAMEORIGIN');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
});

server.register(cors, { origin: true });
server.register(jwt, { 
  secret: JWT_SECRET,
  sign: {
    expiresIn: '30d'
  }
});
server.register(compress, {
  global: true,
  threshold: 1024,
  encodings: ['br', 'gzip', 'deflate'],
  brotliOptions: {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 4, // Fast dynamic compression (~1-2ms), beats gzip ratio by 15%
    },
  },
  zlibOptions: {
    level: 6,
  },
});

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
    setHeaders: (res: any, pathName: string) => {
      // Never cache HTML, Service Worker, or manifest files
      // Ensures clients immediately pick up new updates on restart/launch
      if (
        pathName.endsWith('.html') ||
        pathName.endsWith('sw.js') ||
        pathName.endsWith('registerSW.js') ||
        pathName.endsWith('.webmanifest')
      ) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      } else if (pathName.includes('/assets/')) {
        // Vite hashed bundle assets can be safely cached
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });
}

// In-memory cache for fast user validity checks without DB round-trips on every request
const userValidityCache = new Map<number, { valid: boolean; exp: number }>();
export function isUserValid(userId: number): boolean {
  const now = Date.now();
  const cached = userValidityCache.get(userId);
  if (cached && cached.exp > now) return cached.valid;
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  const valid = Boolean(row);
  userValidityCache.set(userId, { valid, exp: now + 30000 }); // 30s cache
  return valid;
}
export function invalidateUserCache(userId: number) {
  userValidityCache.delete(userId);
}

// Authentication Decorator
server.decorate('authenticate', async (request: any, reply: any) => {
  try {
    await request.jwtVerify();
    const userId = request.user?.id;
    if (!userId || !isUserValid(userId)) {
      return reply.status(401).send({ error: 'Пользователь не найден или сессия недействительна' });
    }
  } catch (err) {
    reply.status(401).send({ error: 'Требуется авторизация' });
  }
});

// Admin check helper
function isAdmin(req: any): boolean {
  if (!req.user || !req.user.id) return false;
  if (req.user.id === 1) return true;
  const adminUser = process.env.ADMIN_USER;
  if (adminUser) {
    if (String(req.user.id) === adminUser || req.user.username === adminUser) return true;
  }
  return false;
}

// Host header sanitizer to prevent Host injection vulnerabilities
function getSafeHost(req: any): string {
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).split(',')[0].trim();
  if (/^[a-zA-Z0-9.:-]+$/.test(rawHost)) {
    return rawHost;
  }
  return `localhost:${PORT}`;
}

// Strip internal server paths before returning track to client
function sanitizeTrackForClient(track: any) {
  if (!track) return track;
  const { file_path, ...safe } = track;
  return safe;
}

// ----------------- AUTH ROUTES -----------------
server.post('/api/auth/register', async (req: any, reply: any) => {
  const clientIp = req.ip || req.raw?.socket?.remoteAddress || 'unknown';
  const limitCheck = consumeRateLimit(`reg:::${clientIp}`, 10, 60000);
  if (limitCheck.blocked) {
    return reply.status(429).send({ error: `Слишком много запросов. Подождите ${limitCheck.retryAfterSec || 60} сек.` });
  }

  const body = req.body || {};
  const { username, password, confirm_password, display_name, email } = body;
  if (!username || !password) {
    return reply.status(400).send({ error: 'Логин и пароль обязательны' });
  }

  if (confirm_password && password !== confirm_password) {
    return reply.status(400).send({ error: 'Пароли не совпадают' });
  }

  const cleanUser = String(username).trim();
  if (cleanUser.length < 2 || cleanUser.length > 64) {
    return reply.status(400).send({ error: 'Логин должен содержать от 2 до 64 символов' });
  }
  if (!/^[a-zA-Z0-9_.@-]+$/.test(cleanUser)) {
    return reply.status(400).send({ error: 'Логин содержит недопустимые символы (разрешены буквы, цифры, _, ., @, -)' });
  }

  const cleanPass = String(password);
  if (cleanPass.length < 4 || cleanPass.length > 128) {
    return reply.status(400).send({ error: 'Пароль должен содержать от 4 до 128 символов' });
  }

  const resolvedEmail = email ? String(email).trim().slice(0, 120) : (cleanUser.includes('@') ? cleanUser.slice(0, 120) : null);
  const cleanDisplayName = display_name ? String(display_name).trim().slice(0, 100) : cleanUser;

  const existing = db.prepare(`
    SELECT id FROM users 
    WHERE username = ? 
       OR (email IS NOT NULL AND email = ?)
       OR (email IS NOT NULL AND email = ?)
  `).get(cleanUser, cleanUser, resolvedEmail || '');

  if (existing) {
    return reply.status(400).send({ error: 'Пользователь с таким логином или email уже существует' });
  }

  // Non-blocking async bcrypt hash (protects Node.js Event Loop from audio stutter)
  const passwordHash = await bcrypt.hash(cleanPass, 10);
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, email)
    VALUES (?, ?, ?, ?)
  `).run(cleanUser, passwordHash, cleanDisplayName, resolvedEmail);

  const userId = Number(info.lastInsertRowid);
  const countRow: any = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
  const totalUsers = countRow?.cnt || 1;

  // Check and notify if users >= 5
  checkAndNotifyUserLimit(totalUsers).catch(() => {});

  const token = server.jwt.sign({ id: userId, username: cleanUser }, { expiresIn: '30d' });
  return {
    token,
    user: { id: userId, username: cleanUser, display_name: cleanDisplayName, email: resolvedEmail }
  };
});

server.post('/api/auth/login', async (req: any, reply: any) => {
  const clientIp = req.ip || req.raw?.socket?.remoteAddress || 'unknown';
  const ipCheck = consumeRateLimit(`login_ip:::${clientIp}`, 20, 60000);
  if (ipCheck.blocked) {
    return reply.status(429).send({
      error: `Слишком много попыток входа с вашего IP. Попробуйте снова через ${ipCheck.retryAfterSec || 60} сек.`
    });
  }

  const body = req.body || {};
  const { username, password } = body;
  const cleanIdentifier = String(username || '').trim().slice(0, 120);
  if (!cleanIdentifier || typeof password !== 'string' || password.length > 128) {
    return reply.status(400).send({ error: 'Неверный логин или пароль' });
  }

  const userRateKey = `login_user:::${cleanIdentifier.toLowerCase()}`;
  const userCheck = isRateLimited(userRateKey);
  if (userCheck.blocked) {
    return reply.status(429).send({
      error: `Слишком много неудачных попыток входа для этого аккаунта. Попробуйте снова через ${userCheck.retryAfterSec || 300} сек.`
    });
  }

  const user: any = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(cleanIdentifier, cleanIdentifier);

  const isMatch = user && (await bcrypt.compare(password, user.password_hash));
  if (!isMatch) {
    recordFailedAttempt(userRateKey, 5, 60000, 300000);
    return reply.status(401).send({ error: 'Неверный логин или пароль' });
  }

  resetRateLimit(userRateKey);

  const token = server.jwt.sign({ id: user.id, username: user.username }, { expiresIn: '30d' });
  const settings = getUserSettings(user.id);
  return {
    token,
    user: { id: user.id, username: user.username, display_name: user.display_name, email: user.email, settings }
  };
});

function getUserSettings(userId: number): Record<string, string> {
  try {
    const rows: any[] = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(userId);
    const settings: Record<string, string> = {};
    for (const r of rows) settings[r.key] = r.value;
    return settings;
  } catch (_) {
    return {};
  }
}

server.get('/api/auth/me', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const user: any = db.prepare('SELECT id, username, display_name, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return { user: null };
  const settings = getUserSettings(req.user.id);
  return { user: { ...user, settings } };
});

server.get('/api/user/settings', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const settings = getUserSettings(req.user.id);
  return { settings };
});

server.put('/api/user/settings', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const userId = req.user.id;
  const body = req.body || {};
  const upsert = db.prepare(`
    INSERT INTO user_settings (user_id, key, value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);

  const saveItem = (k: string, v: any) => {
    if (typeof k === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(k)) {
      let valStr = typeof v === 'string' ? v : JSON.stringify(v);
      if (valStr.length > 4096) {
        valStr = valStr.slice(0, 4096);
      }
      upsert.run(userId, k, valStr);
    }
  };

  const saveManyTx = db.transaction((entries: [string, any][]) => {
    // Restrict to max 50 keys in a single update
    for (const [k, v] of entries.slice(0, 50)) {
      saveItem(k, v);
    }
  });

  if (body.key !== undefined && body.value !== undefined) {
    saveItem(body.key, body.value);
  } else if (body.settings && typeof body.settings === 'object') {
    saveManyTx(Object.entries(body.settings));
  } else if (typeof body === 'object') {
    saveManyTx(Object.entries(body));
  }

  const settings = getUserSettings(userId);
  try {
    broadcastToUser(userId, { type: 'SETTINGS_UPDATED', settings });
  } catch (_) {}

  return { success: true, settings };
});

const handleProfileUpdate = async (req: any, reply: any) => {
  const body = req.body || {};
  const displayName = body.display_name || body.displayName;
  if (!displayName || !String(displayName).trim()) {
    return reply.status(400).send({ error: 'Имя не может быть пустым' });
  }
  const clean = String(displayName).trim().slice(0, 100);
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(clean, req.user.id);
  return { success: true, display_name: clean };
};

server.put('/api/auth/profile', { preHandler: [(server as any).authenticate] }, handleProfileUpdate);
server.put('/api/user/profile', { preHandler: [(server as any).authenticate] }, handleProfileUpdate);

const handlePasswordUpdate = async (req: any, reply: any) => {
  const rateKey = `pwd_action:${req.user.id}`;
  const limitCheck = isRateLimited(rateKey);
  if (limitCheck.blocked) {
    return reply.status(429).send({
      error: `Слишком много неудачных попыток. Попробуйте снова через ${limitCheck.retryAfterSec || 60} сек.`
    });
  }

  const body = req.body || {};
  const currentPassword = body.current_password || body.currentPassword;
  const newPassword = body.new_password || body.newPassword;

  if (typeof currentPassword !== 'string' || currentPassword.length > 128) {
    return reply.status(400).send({ error: 'Текущий пароль указан неверно' });
  }
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 4 || newPassword.length > 128) {
    return reply.status(400).send({ error: 'Новый пароль должен содержать от 4 до 128 символов' });
  }

  const user: any = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
    recordFailedAttempt(rateKey, 5);
    return reply.status(400).send({ error: 'Текущий пароль указан неверно' });
  }

  resetRateLimit(rateKey);
  const newHash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);
  return { success: true, message: 'Пароль успешно обновлен' };
};

server.put('/api/auth/password', { preHandler: [(server as any).authenticate] }, handlePasswordUpdate);
server.put('/api/user/password', { preHandler: [(server as any).authenticate] }, handlePasswordUpdate);

const handleAccountDelete = async (req: any, reply: any) => {
  const rateKey = `pwd_action:${req.user.id}`;
  const limitCheck = isRateLimited(rateKey);
  if (limitCheck.blocked) {
    return reply.status(429).send({
      error: `Слишком много неудачных попыток. Попробуйте снова через ${limitCheck.retryAfterSec || 60} сек.`
    });
  }

  const body = req.body || {};
  const password = body.password;
  if (typeof password !== 'string' || password.length > 128) {
    return reply.status(400).send({ error: 'Неверный пароль. Удаление отменено.' });
  }

  const user: any = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    recordFailedAttempt(rateKey, 5);
    return reply.status(400).send({ error: 'Неверный пароль. Удаление отменено.' });
  }

  resetRateLimit(rateKey);
  invalidateUserCache(req.user.id);
  terminateUserSessions(req.user.id);
  db.prepare('DELETE FROM download_jobs WHERE user_id = ?').run(req.user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  return { success: true, message: 'Аккаунт успешно удален' };
};

server.delete('/api/auth/account', { preHandler: [(server as any).authenticate] }, handleAccountDelete);
server.delete('/api/user/account', { preHandler: [(server as any).authenticate] }, handleAccountDelete);

// ----------------- BACKUP & RESTORE -----------------
server.get('/api/user/library/backup', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const userId = req.user.id;
  const user: any = db.prepare('SELECT username, display_name, timezone FROM users WHERE id = ?').get(userId);

  const likedTracks: any[] = db.prepare(`
    SELECT t.title, t.artist, t.album, t.duration_ms, t.spotify_id, t.cover_url
    FROM liked_tracks lt
    JOIN tracks t ON lt.track_id = t.id
    WHERE lt.user_id = ?
    ORDER BY lt.created_at ASC
  `).all(userId);

  const customPlaylists: any[] = db.prepare(`
    SELECT id, name, description, cover_url, spotify_id, is_daily_mix, daily_mix_date
    FROM playlists
    WHERE user_id = ?
    ORDER BY id ASC
  `).all(userId);

  // Single JOIN query for all user playlist tracks to eliminate N+1 queries
  const allPlaylistTracks: any[] = db.prepare(`
    SELECT pt.playlist_id, t.title, t.artist, t.album, t.duration_ms, t.spotify_id, t.cover_url, pt.position
    FROM playlist_tracks pt
    JOIN tracks t ON pt.track_id = t.id
    JOIN playlists p ON pt.playlist_id = p.id
    WHERE p.user_id = ?
    ORDER BY pt.playlist_id, pt.position ASC
  `).all(userId);

  const tracksByPlaylistId = new Map<number, any[]>();
  for (const tr of allPlaylistTracks) {
    let list = tracksByPlaylistId.get(tr.playlist_id);
    if (!list) {
      list = [];
      tracksByPlaylistId.set(tr.playlist_id, list);
    }
    list.push({
      title: tr.title,
      artist: tr.artist,
      album: tr.album,
      duration_ms: tr.duration_ms,
      spotify_id: tr.spotify_id,
      cover_url: tr.cover_url,
      position: tr.position
    });
  }

  const playlistsWithTracks = customPlaylists.map((pl) => ({
    name: pl.name,
    description: pl.description,
    cover_url: pl.cover_url,
    spotify_id: pl.spotify_id,
    is_daily_mix: pl.is_daily_mix,
    daily_mix_date: pl.daily_mix_date,
    tracks: tracksByPlaylistId.get(pl.id) || [],
  }));

  const blacklist: any[] = db.prepare(`
    SELECT title, artist, spotify_id FROM blacklist WHERE user_id = ?
  `).all(userId);

  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    user: {
      username: user?.username,
      display_name: user?.display_name,
      timezone: user?.timezone,
    },
    likedTracks,
    playlists: playlistsWithTracks,
    blacklist,
  };
});

server.post('/api/user/library/restore', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const userId = req.user.id;
  const payload = req.body;
  if (!payload || typeof payload !== 'object' || (!Array.isArray(payload.playlists) && !Array.isArray(payload.likedTracks) && !Array.isArray(payload.blacklist))) {
    return reply.status(400).send({ error: 'Неверный формат файла резервной копии' });
  }

  let restoredLikes = 0;
  let restoredPlaylists = 0;
  let restoredTracks = 0;
  let restoredBlacklist = 0;

  // Prepare reusable statements outside loops
  const findTrackStmt = db.prepare(`
    SELECT id FROM tracks 
    WHERE (spotify_id IS NOT NULL AND spotify_id = ?) 
       OR (LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?))
    LIMIT 1
  `);
  const insertLikeStmt = db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)');
  const insertPlStmt = db.prepare(`
    INSERT INTO playlists (user_id, name, description, cover_url, spotify_id, is_daily_mix, daily_mix_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPlTrackStmt = db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)');
  const insertBlStmt = db.prepare('INSERT OR IGNORE INTO blacklist (user_id, title, artist, spotify_id) VALUES (?, ?, ?, ?)');

  // Execute all restores inside an atomic transaction
  const restoreTx = db.transaction(() => {
    // 1. Restore Liked Tracks (cap at 2000)
    if (Array.isArray(payload.likedTracks)) {
      for (const t of payload.likedTracks.slice(0, 2000)) {
        if (!t || !t.title || !t.artist) continue;
        const spId = t.spotify_id ? String(t.spotify_id).slice(0, 64) : '';
        const title = String(t.title).slice(0, 200);
        const artist = String(t.artist).slice(0, 200);
        const trackRow: any = findTrackStmt.get(spId, title, artist);
        if (trackRow) {
          insertLikeStmt.run(userId, trackRow.id);
          restoredLikes++;
        }
      }
    }

    // 2. Restore Playlists (cap at 50 playlists, 1000 tracks per playlist)
    if (Array.isArray(payload.playlists)) {
      for (const pl of payload.playlists.slice(0, 50)) {
        if (!pl || !pl.name) continue;
        const name = String(pl.name).trim().slice(0, 100);
        if (!name) continue;
        const description = pl.description ? String(pl.description).trim().slice(0, 500) : '';

        let safeCoverUrl: string | null = null;
        if (typeof pl.cover_url === 'string') {
          const c = pl.cover_url.trim();
          if (c.startsWith('https://') || c.startsWith('http://') || c.startsWith('/api/')) {
            safeCoverUrl = c.slice(0, 2048);
          }
        }

        const spotifyId = pl.spotify_id ? String(pl.spotify_id).slice(0, 64) : null;
        const info = insertPlStmt.run(
          userId,
          name,
          description,
          safeCoverUrl,
          spotifyId,
          pl.is_daily_mix ? 1 : 0,
          pl.daily_mix_date ? String(pl.daily_mix_date).slice(0, 32) : null
        );
        const newPlaylistId = Number(info.lastInsertRowid);
        restoredPlaylists++;

        if (Array.isArray(pl.tracks)) {
          let pos = 0;
          for (const t of pl.tracks.slice(0, 1000)) {
            if (!t || !t.title || !t.artist) continue;
            const spId = t.spotify_id ? String(t.spotify_id).slice(0, 64) : '';
            const title = String(t.title).slice(0, 200);
            const artist = String(t.artist).slice(0, 200);
            const trackRow: any = findTrackStmt.get(spId, title, artist);
            if (trackRow) {
              insertPlTrackStmt.run(newPlaylistId, trackRow.id, pos++);
              restoredTracks++;
            }
          }
        }
      }
    }

    // 3. Restore Blacklist (cap at 500)
    if (Array.isArray(payload.blacklist)) {
      for (const b of payload.blacklist.slice(0, 500)) {
        if (b && b.title && b.artist) {
          const title = String(b.title).trim().slice(0, 200);
          const artist = String(b.artist).trim().slice(0, 200);
          const spId = b.spotify_id ? String(b.spotify_id).trim().slice(0, 64) : null;
          insertBlStmt.run(userId, title, artist, spId);
          restoredBlacklist++;
        }
      }
    }
  });

  restoreTx();

  return {
    success: true,
    message: `Успешно восстановлено: ${restoredLikes} лайков, ${restoredPlaylists} плейлистов (${restoredTracks} треков)`,
    stats: { restoredLikes, restoredPlaylists, restoredTracks, restoredBlacklist }
  };
});

// ----------------- AUDIO STREAMING (High-Performance WAN Stream & Caching) -----------------
// Dedicated lightweight HEAD route: instant 0ms validation for PWA ETag / Content-Length
server.head('/api/stream/:trackId', { config: { compress: false } }, async (req: any, reply: any) => {
  const trackId = Number(req.params.trackId);
  if (!trackId || !Number.isInteger(trackId) || trackId <= 0) {
    return reply.status(400).send({ error: 'Некорректный ID трека' });
  }
  const track: any = db.prepare('SELECT file_path FROM tracks WHERE id = ?').get(trackId);
  if (!track || !track.file_path) {
    return reply.status(404).send();
  }

  const filePath = track.file_path;
  const resolvedPath = path.resolve(filePath);
  const resolvedMusicDir = path.resolve(MUSIC_DIR);
  if (!resolvedPath.startsWith(resolvedMusicDir + path.sep) && resolvedPath !== resolvedMusicDir) {
    return reply.status(403).send();
  }

  try {
    const stat = await fs.promises.stat(filePath);
    const total = stat.size;
    const ext = path.extname(filePath).toLowerCase();
    let contentType = 'audio/mpeg';
    if (ext === '.m4a' || ext === '.aac') contentType = 'audio/mp4';
    else if (ext === '.ogg' || ext === '.opus') contentType = 'audio/ogg';
    else if (ext === '.flac') contentType = 'audio/flac';

    const etag = `W/"track-${trackId}-${stat.mtimeMs}-${total}"`;
    const lastModified = stat.mtime.toUTCString();

    const clientEtag = (req.headers['if-none-match'] || '').replace(/^W\//, '').replace(/^"|"$/g, '').trim();
    const cleanEtag = `track-${trackId}-${stat.mtimeMs}-${total}`;

    if (clientEtag && (clientEtag === cleanEtag || clientEtag === '*')) {
      return reply.status(304).send();
    }

    reply.status(200).headers({
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': total,
      'ETag': etag,
      'Last-Modified': lastModified,
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
      'Connection': 'keep-alive',
      'Timing-Allow-Origin': '*',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range, Content-Range, Accept-Ranges, Cache-Control',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag, Cache-Control',
    });
    return reply.send();
  } catch (_) {
    return reply.status(404).send();
  }
});

server.get('/api/stream/:trackId', { config: { compress: false } }, async (req: any, reply: any) => {
  // Optimize TCP socket for real-time low-latency audio transmission over WAN
  if (req.raw.socket) {
    try {
      req.raw.socket.setNoDelay(true); // Disable Nagle's algorithm for instant chunk transmission
      req.raw.socket.setKeepAlive(true, 30000);
    } catch (_) {}
  }

  const trackId = Number(req.params.trackId);
  if (!trackId || !Number.isInteger(trackId) || trackId <= 0) {
    return reply.status(400).send({ error: 'Некорректный ID трека' });
  }
  const track: any = db.prepare('SELECT file_path FROM tracks WHERE id = ?').get(trackId);
  if (!track || !track.file_path) {
    return reply.status(404).send({ error: 'Аудиофайл не найден' });
  }

  const filePath = track.file_path;
  const resolvedPath = path.resolve(filePath);
  const resolvedMusicDir = path.resolve(MUSIC_DIR);
  if (!resolvedPath.startsWith(resolvedMusicDir + path.sep) && resolvedPath !== resolvedMusicDir) {
    return reply.status(403).send({ error: 'Доступ запрещен: путь к файлу недопустим' });
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (_) {
    return reply.status(404).send({ error: 'Аудиофайл не найден' });
  }
  const total = stat.size;
  const range = req.headers.range;

  const ext = path.extname(filePath).toLowerCase();
  let contentType = 'audio/mpeg';
  if (ext === '.m4a' || ext === '.aac') contentType = 'audio/mp4';
  else if (ext === '.ogg' || ext === '.opus') contentType = 'audio/ogg';
  else if (ext === '.flac') contentType = 'audio/flac';

  const etag = `W/"track-${trackId}-${stat.mtimeMs}-${total}"`;
  const lastModified = stat.mtime.toUTCString();

  const clientEtag = (req.headers['if-none-match'] || '').replace(/^W\//, '').replace(/^"|"$/g, '').trim();
  const cleanEtag = `track-${trackId}-${stat.mtimeMs}-${total}`;

  // ETag conditional check (instant 304 response)
  if (clientEtag && (clientEtag === cleanEtag || clientEtag === '*')) {
    return reply.status(304).send();
  }

  const baseHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
    'ETag': etag,
    'Last-Modified': lastModified,
    'Connection': 'keep-alive',
    'Timing-Allow-Origin': '*',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range, Content-Range, Accept-Ranges, Cache-Control',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag, Cache-Control',
  };

  // 1 MB high-water mark for high-throughput burst delivery over WAN (eliminates buffer starvation on high-ping networks)
  const HIGH_WATER_MARK = 1024 * 1024;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const partialstart = parts[0];
    const partialend = parts[1];
    let start = parseInt(partialstart, 10);
    if (isNaN(start) || start < 0) start = 0;

    let end = partialend ? parseInt(partialend, 10) : total - 1;
    if (isNaN(end) || end >= total) end = total - 1;
    if (start > end) {
      reply.status(416);
      reply.headers({ 'Content-Range': `bytes */${total}` });
      return reply.send();
    }

    const chunksize = (end - start) + 1;
    const fileStream = fs.createReadStream(filePath, { start, end, highWaterMark: HIGH_WATER_MARK });

    // Cleanly destroy stream on client disconnect to avoid orphan read streams
    req.raw.on('close', () => {
      fileStream.destroy();
    });

    reply.status(206);
    reply.headers({
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': chunksize,
    });
    return reply.send(fileStream);
  } else {
    const fileStream = fs.createReadStream(filePath, { highWaterMark: HIGH_WATER_MARK });

    req.raw.on('close', () => {
      fileStream.destroy();
    });

    reply.status(200);
    reply.headers({
      ...baseHeaders,
      'Content-Length': total,
    });
    return reply.send(fileStream);
  }
});

// ----------------- DAILY MIXES -----------------
function validateClientTimezone(rawTz: any): string | undefined {
  if (typeof rawTz !== 'string') return undefined;
  const trimmed = rawTz.trim();
  if (!trimmed || trimmed.length > 50) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return trimmed;
  } catch (_) {
    return undefined;
  }
}

server.get('/api/daily-mixes', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  try {
    const clientTz = validateClientTimezone(req.headers['x-timezone']);
    if (clientTz) {
      try {
        db.prepare('UPDATE users SET timezone = ? WHERE id = ? AND (timezone IS NULL OR timezone != ?)').run(clientTz, req.user.id, clientTz);
      } catch (_) {}
    }
    const mixes = await getOrGenerateDailyMixes(req.user.id, false, clientTz);
    return { mixes };
  } catch (err: any) {
    console.error('[Daily Mixes Error]:', err);
    return reply.status(500).send({ error: err.message || 'Ошибка генерации Плейлистов дня' });
  }
});

server.get('/api/daily-mixes/schedule', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  return getNightlySchedulerStatus(req.user.id);
});

server.put('/api/daily-mixes/schedule', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const body = req.body || {};
  return updateNightlySchedule(req.user.id, body);
});

server.post('/api/daily-mixes/refresh', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const limitCheck = consumeRateLimit('dm_refresh:' + req.user.id, 3, 60000);
  if (limitCheck.blocked) {
    return reply.status(429).send({ error: `Слишком много запросов на обновление миксов. Подождите ${limitCheck.retryAfterSec || 60} сек.` });
  }
  try {
    const clientTz = validateClientTimezone(req.headers['x-timezone']);
    const mixes = await getOrGenerateDailyMixes(req.user.id, true, clientTz);
    return { mixes };
  } catch (err: any) {
    console.error('[Daily Mixes Refresh Error]:', err);
    return reply.status(500).send({ error: err.message || 'Ошибка обновления Плейлистов дня' });
  }
});

server.post('/api/daily-mixes/:id/save', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  try {
    const result = saveDailyMixAsPlaylist(req.user.id, Number(req.params.id));
    return result;
  } catch (err: any) {
    return reply.status(400).send({ error: err.message || 'Ошибка сохранения плейлиста' });
  }
});

function getUserBlacklistVersion(userId: number): string {
  try {
    const row: any = db.prepare('SELECT COUNT(*) as c, MAX(created_at) as m FROM blacklist WHERE user_id = ?').get(userId);
    return `${row?.c || 0}_${row?.m || ''}`;
  } catch (_) {
    return '0_';
  }
}

// ----------------- PLAYLISTS -----------------
server.get('/api/playlists', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const blVer = getUserBlacklistVersion(req.user.id);
  const rawPlaylists: any[] = db.prepare(`
    SELECT p.*, COUNT(pt.track_id) as track_count, COALESCE(MAX(pt.position), 0) as max_pos, COALESCE(MAX(pt.added_at), '') as max_added
    FROM playlists p
    LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
    WHERE p.user_id = ? 
      AND COALESCE(p.is_daily_mix, 0) = 0
      AND LOWER(p.name) NOT LIKE '%daily mix%'
      AND LOWER(p.name) NOT LIKE '%микс дня%'
      AND LOWER(p.name) NOT LIKE '%ежедневный микс%'
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `).all(req.user.id);

  const playlists = rawPlaylists.map(p => ({
    ...p,
    version: `v_${p.id}_${p.track_count || 0}_${p.max_pos || 0}_${p.max_added || ''}_${p.name}_${p.cover_url || ''}_${blVer}`
  }));

  return { playlists };
});

server.post('/api/playlists', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const body = req.body || {};
  const { name, description } = body;
  if (!name || typeof name !== 'string' || !name.trim()) return reply.status(400).send({ error: 'Название обязательно' });

  const cleanName = name.trim().slice(0, 100);
  const cleanDesc = description ? String(description).trim().slice(0, 500) : '';
  const existing = db.prepare('SELECT id FROM playlists WHERE user_id = ? AND COALESCE(is_daily_mix, 0) = 0 AND LOWER(name) = LOWER(?)').get(req.user.id, cleanName);
  if (existing) {
    return reply.status(400).send({ error: 'Плейлист с таким названием уже существует' });
  }

  const info = db.prepare(`
    INSERT INTO playlists (user_id, name, description)
    VALUES (?, ?, ?)
  `).run(req.user.id, cleanName, cleanDesc);

  return { id: info.lastInsertRowid, name: cleanName, description: cleanDesc };
});

server.get('/api/playlists/:id', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const playlistId = Number(req.params.id);
  const playlist: any = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, req.user.id);
  if (!playlist) return reply.status(404).send({ error: 'Плейлист не найден' });

  const stats: any = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(MAX(position), 0) as maxPos, COALESCE(MAX(added_at), '') as maxAdded
    FROM playlist_tracks WHERE playlist_id = ?
  `).get(playlistId);

  const currentCount = Number(stats?.count) || 0;
  const currentMaxPos = Number(stats?.maxPos) || 0;
  const currentMaxAdded = String(stats?.maxAdded || '');
  const blVer = getUserBlacklistVersion(req.user.id);
  const currentVersion = `v_${playlistId}_${currentCount}_${currentMaxPos}_${currentMaxAdded}_${playlist.name}_${playlist.cover_url || ''}_${blVer}`;

  const clientVersion = req.query.version;
  const knownCount = req.query.knownCount !== undefined ? Number(req.query.knownCount) : -1;
  const knownMaxPos = req.query.knownMaxPos !== undefined ? Number(req.query.knownMaxPos) : -1;

  const activeJob: any = db.prepare(`
    SELECT * FROM download_jobs
    WHERE playlist_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(playlistId);

  // If client already has latest version: 0ms instant response without querying tracks table
  if (clientVersion && clientVersion === currentVersion) {
    return { upToDate: true, version: currentVersion, playlist, activeJob: activeJob || null };
  }

  // Delta append check: if tracks were strictly appended after knownMaxPos
  if (knownCount > 0 && knownMaxPos >= 0 && currentCount > knownCount && currentMaxPos > knownMaxPos) {
    const minPosRow: any = db.prepare(`
      SELECT MIN(position) as minPos, COUNT(*) as appendedCount
      FROM playlist_tracks WHERE playlist_id = ? AND position > ?
    `).get(playlistId, knownMaxPos);

    if (minPosRow && minPosRow.appendedCount === (currentCount - knownCount)) {
      const rawAdded: any[] = db.prepare(`
        SELECT t.id, t.title, t.artist, t.album, t.duration_ms, t.cover_url, pt.added_at, pt.position
        FROM playlist_tracks pt
        JOIN tracks t ON pt.track_id = t.id
        WHERE pt.playlist_id = ? AND pt.position > ?
        ORDER BY pt.position ASC
      `).all(playlistId, knownMaxPos) as any[];

      const validAddedTracks = filterBlacklistedTracksForUser(req.user.id, rawAdded);
      return {
        delta: true,
        version: currentVersion,
        playlist,
        addedTracks: validAddedTracks,
        activeJob: activeJob || null
      };
    }
  }

  // Full fetch: single batch query for tracks + 1 query for blacklist filtering
  const rawTracks: any[] = db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, t.duration_ms, t.cover_url, pt.added_at, pt.position
    FROM playlist_tracks pt
    JOIN tracks t ON pt.track_id = t.id
    WHERE pt.playlist_id = ?
    ORDER BY pt.position ASC
  `).all(playlistId) as any[];

  const validTracks = filterBlacklistedTracksForUser(req.user.id, rawTracks);

  return {
    version: currentVersion,
    playlist,
    tracks: validTracks,
    activeJob: activeJob || null
  };
});

server.put('/api/playlists/:id', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const playlistId = Number(req.params.id);
  const playlist: any = db.prepare('SELECT id, name, description FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, req.user.id);
  if (!playlist) return reply.status(404).send({ error: 'Плейлист не найден' });

  const body = req.body || {};
  const name = body.name ? String(body.name).trim().slice(0, 100) : null;
  const description = body.description !== undefined ? String(body.description).trim().slice(0, 500) : undefined;

  if (!name) {
    return reply.status(400).send({ error: 'Название плейлиста не может быть пустым' });
  }

  if (name.toLowerCase() === 'любимые треки' || name.toLowerCase() === 'liked songs') {
    return reply.status(400).send({ error: 'Имя «Любимые треки» зарезервировано для системного раздела' });
  }

  if (description !== undefined) {
    db.prepare('UPDATE playlists SET name = ?, description = ? WHERE id = ?').run(name, description, playlistId);
  } else {
    db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(name, playlistId);
  }

  db.prepare('UPDATE download_jobs SET playlist_name = ? WHERE playlist_id = ?').run(name, playlistId);

  const updated: any = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId);
  return { success: true, playlist: updated };
});

server.put('/api/playlists/:id/cover', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const playlistId = Number(req.params.id);
  const playlist = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, req.user.id);
  if (!playlist) return reply.status(404).send({ error: 'Плейлист не найден' });

  const body = req.body || {};
  const { image_base64, cover_url } = body;
  let finalUrl = '';

  if (image_base64) {
    if (typeof image_base64 !== 'string') {
      return reply.status(400).send({ error: 'Неверный формат изображения' });
    }
    const base64Data = image_base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Security: Max 5 MB limit
    if (buffer.length > 5 * 1024 * 1024) {
      return reply.status(400).send({ error: 'Размер изображения превышает 5 МБ' });
    }

    // Security: Magic bytes verification (JPEG, PNG, WebP, GIF)
    const isJpeg = buffer.length > 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
    const isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
    const isWebp = buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    const isGif = buffer.length > 3 && buffer.subarray(0, 3).toString('ascii') === 'GIF';

    if (!isJpeg && !isPng && !isWebp && !isGif) {
      return reply.status(400).send({ error: 'Недопустимый формат файла. Допускаются только JPEG, PNG или WebP' });
    }

    const coversDir = path.join(process.cwd(), 'data', 'covers');
    if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });

    const filePath = path.join(coversDir, `playlist_${playlistId}.jpg`);
    await fs.promises.writeFile(filePath, buffer);
    finalUrl = `/api/playlists/${playlistId}/cover?t=${Date.now()}`;
  } else if (cover_url) {
    if (typeof cover_url !== 'string' || (!cover_url.startsWith('https://') && !cover_url.startsWith('http://') && !cover_url.startsWith('/api/'))) {
      return reply.status(400).send({ error: 'Недопустимый URL обложки. Разрешены только HTTP(S) ссылки или внутренние пути' });
    }
    finalUrl = cover_url.slice(0, 2048);
  }

  if (!finalUrl) {
    return reply.status(400).send({ error: 'Изображение не предоставлено' });
  }

  db.prepare('UPDATE playlists SET cover_url = ? WHERE id = ?').run(finalUrl, playlistId);
  return { success: true, cover_url: finalUrl };
});

server.get('/api/playlists/:id/cover', { config: { compress: false } }, async (req: any, reply: any) => {
  const playlistId = Number(req.params.id);
  const coversDir = path.join(process.cwd(), 'data', 'covers');
  const filePath = path.join(coversDir, `playlist_${playlistId}.jpg`);
  try {
    const stat = await fs.promises.stat(filePath);
    const etag = `W/"cover-${playlistId}-${stat.mtimeMs}"`;
    const clientEtag = (req.headers['if-none-match'] || '').replace(/^W\//, '').replace(/^"|"$/g, '').trim();
    const cleanEtag = `cover-${playlistId}-${stat.mtimeMs}`;
    if (clientEtag && (clientEtag === cleanEtag || clientEtag === '*')) {
      return reply.status(304).send();
    }
    reply.type('image/jpeg').headers({
      'Cache-Control': 'public, max-age=86400',
      'ETag': etag,
      'Last-Modified': stat.mtime.toUTCString(),
      'Content-Length': stat.size
    });
    return reply.send(fs.createReadStream(filePath));
  } catch (_) {
    reply.status(404).send('Cover not found');
  }
});

server.delete('/api/playlists/:id', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const playlistId = Number(req.params.id);
  const playlist: any = db.prepare('SELECT id, cover_url FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, req.user.id);
  if (!playlist) {
    return reply.status(404).send({ error: 'Плейлист не найден или нет доступа' });
  }

  cancelPlaylistDownloads([playlistId]);

  db.transaction(() => {
    db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId);
    db.prepare('DELETE FROM download_jobs WHERE playlist_id = ?').run(playlistId);
    db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(playlistId, req.user.id);
  })();

  const coversDir = path.join(process.cwd(), 'data', 'covers');
  const filePath = path.join(coversDir, `playlist_${playlistId}.jpg`);
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
  return { success: true };
});

server.delete('/api/playlists/:id/tracks/:trackId', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const playlistId = Number(req.params.id);
  const trackId = Number(req.params.trackId);

  const playlist: any = db.prepare('SELECT id, daily_mix_tracks_json FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, req.user.id);
  if (!playlist) {
    return reply.status(404).send({ error: 'Плейлист не найден или нет доступа' });
  }

  db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').run(playlistId, trackId);

  // If this playlist is a Daily Mix, also remove the track from daily_mix_tracks_json
  if (playlist.daily_mix_tracks_json) {
    try {
      const trackRow: any = db.prepare('SELECT title, artist, spotify_id FROM tracks WHERE id = ?').get(trackId);
      if (trackRow) {
        const dmTracks: any[] = JSON.parse(playlist.daily_mix_tracks_json);
        const lTitle = (trackRow.title || '').toLowerCase().trim();
        const lArtist = (trackRow.artist || '').toLowerCase().trim();
        const filtered = dmTracks.filter((t: any) => {
          if (trackRow.spotify_id && t.id === trackRow.spotify_id) return false;
          return !(t.title?.toLowerCase().trim() === lTitle && t.artist?.toLowerCase().trim() === lArtist);
        });
        if (filtered.length !== dmTracks.length) {
          db.prepare('UPDATE playlists SET daily_mix_tracks_json = ? WHERE id = ?').run(
            JSON.stringify(filtered),
            playlist.id
          );
        }
      }
    } catch (_) {}
  }

  return { success: true };
});

server.post('/api/playlists/:id/tracks', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const playlistId = Number(req.params.id);
  const body = req.body || {};
  const trackId = Number(body.trackId);
  if (!trackId) return reply.status(400).send({ error: 'trackId обязателен' });

  const playlist: any = db.prepare('SELECT id, is_daily_mix, name FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, req.user.id);
  if (!playlist) return reply.status(404).send({ error: 'Плейлист не найден' });
  if (playlist.is_daily_mix || playlist.name?.toLowerCase().startsWith('daily mix')) {
    return reply.status(400).send({ error: 'Нельзя добавлять треки в ежедневный микс' });
  }

  const maxPosRow: any = db.prepare('SELECT MAX(position) as maxPos FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
  const nextPos = (maxPosRow?.maxPos !== null && maxPosRow?.maxPos !== undefined) ? maxPosRow.maxPos + 1 : 0;

  db.prepare(`
    INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
    VALUES (?, ?, ?)
  `).run(playlistId, trackId, nextPos);

  return { success: true };
});

server.get('/api/tracks/:id', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const trackId = Number(req.params.id);
  const track: any = db.prepare('SELECT id, title, artist, album, duration_ms, cover_url, spotify_id FROM tracks WHERE id = ?').get(trackId);
  if (!track) return reply.status(404).send({ error: 'Трек не найден' });
  return { track };
});

server.get('/api/tracks/:id/playlists', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const trackId = Number(req.params.id);
  const playlists = db.prepare(`
    SELECT p.id, p.name, p.cover_url, COUNT(pt_all.track_id) as track_count,
           CASE WHEN EXISTS (SELECT 1 FROM playlist_tracks pt WHERE pt.playlist_id = p.id AND pt.track_id = ?) THEN 1 ELSE 0 END as has_track
    FROM playlists p
    LEFT JOIN playlist_tracks pt_all ON p.id = pt_all.playlist_id
    WHERE p.user_id = ?
      AND COALESCE(p.is_daily_mix, 0) = 0
      AND LOWER(p.name) NOT LIKE '%daily mix%'
      AND LOWER(p.name) NOT LIKE '%микс дня%'
      AND LOWER(p.name) NOT LIKE '%ежедневный микс%'
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `).all(trackId, req.user.id);

  return { playlists };
});

server.post('/api/tracks/:id/redownload', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const trackId = Number(req.params.id);
  if (!trackId || !Number.isInteger(trackId) || trackId <= 0) {
    return reply.status(400).send({ error: 'Некорректный ID трека' });
  }
  const limitCheck = consumeRateLimit('redownload:' + req.user.id, 5, 60000);
  if (limitCheck.blocked) {
    return reply.status(429).send({ error: `Слишком много запросов на повторное скачивание. Подождите ${limitCheck.retryAfterSec || 60} сек.` });
  }
  const result = await redownloadTrackStudioMaster(trackId);
  if (!result.success) {
    return reply.status(500).send(result);
  }
  return result;
});

// ----------------- SPOTIFY IMPORT -----------------
server.post('/api/spotify/import', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const limitCheck = consumeRateLimit('sp_import:' + req.user.id, 6, 60000);
  if (limitCheck.blocked) {
    return reply.status(429).send({ error: `Слишком много запросов на импорт. Подождите ${limitCheck.retryAfterSec || 60} сек.` });
  }

  const body = req.body || {};
  const { url } = body;
  if (!url || typeof url !== 'string') return reply.status(400).send({ error: 'Укажите ссылку на плейлист, альбом или трек Spotify' });

  try {
    const playlistData = await fetchSpotifyPlaylist(url, req.user.id);
    if (!playlistData.tracks || playlistData.tracks.length === 0) {
      return reply.status(400).send({ error: 'Не удалось извлечь треки по указанной ссылке Spotify' });
    }

    const resolvedEntity = await resolveSpotifyEntityInput(url);
    const cleanSpotifyId = resolvedEntity?.id || extractPlaylistId(url);

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
      if (playlistData.cover_url && (!existingPlaylist.cover_url || existingPlaylist.cover_url.includes('mosaic.scdn.co'))) {
        db.prepare('UPDATE playlists SET cover_url = ? WHERE id = ?').run(playlistData.cover_url, playlistId);
      }

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

server.post('/api/playlists/:id/resume', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const playlistId = Number(req.params.id);
  const playlist = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, req.user.id);
  if (!playlist) {
    return reply.status(404).send({ error: 'Плейлист не найден или нет доступа' });
  }
  const result = await resumePlaylistDownload(playlistId);
  return result;
});

// ----------------- SPOTIFY OAUTH & ADVANCED IMPORT -----------------
server.get('/api/spotify/status', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const creds = getSpotifyCredentials();
  const userRow: any = db.prepare('SELECT spotify_access_token, spotify_display_name, spotify_user_id FROM users WHERE id = ?').get(req.user.id);
  const host = getSafeHost(req);
  const proto = req.headers['x-forwarded-proto'] || (req.raw.socket.encrypted ? 'https' : 'http');
  const redirectUri = `${proto}://${host}/api/spotify/callback`;

  const hasCredentials = Boolean(creds.clientId && creds.clientSecret);
  const isConnected = Boolean(userRow?.spotify_access_token);
  const userIsAdmin = isAdmin(req);

  return {
    hasCredentials,
    isConnected,
    clientId: userIsAdmin ? (creds.clientId || '') : (creds.clientId ? `${creds.clientId.slice(0, 6)}...` : ''),
    redirectUri,
    spotifyDisplayName: userRow?.spotify_display_name || userRow?.spotify_user_id || null,
    updatedAt: new Date().toISOString()
  };
});

server.post('/api/spotify/credentials', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  if (!isAdmin(req)) {
    return reply.status(403).send({ error: 'Доступ разрешен только администратору' });
  }

  const body = req.body || {};
  const clientId = (body.clientId || body.spotify_client_id || '').trim();
  const clientSecret = (body.clientSecret || body.spotify_client_secret || '').trim();

  if (!clientId || !clientSecret) {
    return reply.status(400).send({ error: 'Client ID и Client Secret обязательны' });
  }

  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('spotify_client_id', ?) ON CONFLICT(key) DO UPDATE SET value = ?`).run(clientId, clientId);
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('spotify_client_secret', ?) ON CONFLICT(key) DO UPDATE SET value = ?`).run(clientSecret, clientSecret);

  return { success: true, message: 'Ключи Spotify успешно сохранены' };
});

server.get('/api/spotify/auth-url', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  try {
    const userRow: any = db.prepare('SELECT spotify_access_token, spotify_display_name, spotify_user_id FROM users WHERE id = ?').get(req.user.id);
    const host = getSafeHost(req);
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
      url: authUrl,
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
  const acceptsJson = Boolean(req.headers.accept?.includes('application/json'));

  console.log('[Spotify Callback]', {
    url: req.raw.url,
    hasCode: Boolean(code),
    hasState: Boolean(state),
    error: error || null,
    acceptsJson
  });

  if (error || !code || !state) {
    console.warn('[Spotify Callback Missing Code/State]', { error, hasCode: Boolean(code), hasState: Boolean(state) });
    if (acceptsJson) {
      return reply.status(400).send({ error: error || 'Отсутствует код авторизации' });
    }
    return reply.redirect('/?spotify_error=' + encodeURIComponent(error || 'Отсутствует код авторизации'));
  }

  try {
    const result = await handleSpotifyOAuthCallback(code, state);
    console.log('[Spotify Callback Success]', { userId: (result as any)?.userId });
    if (acceptsJson) {
      return { success: true };
    }
    return reply.redirect('/?spotify_connected=1');
  } catch (err: any) {
    console.error('[Spotify OAuth Callback Error]', err.message);
    if (acceptsJson) {
      return reply.status(500).send({ error: err.message });
    }
    return reply.redirect('/?spotify_error=' + encodeURIComponent(err.message));
  }
});

server.post('/api/spotify/disconnect', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  disconnectSpotify(req.user.id);
  return { success: true };
});

server.post('/api/spotify/import-liked', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const limitCheck = consumeRateLimit('sp_import_liked:' + req.user.id, 3, 60000);
  if (limitCheck.blocked) {
    return reply.status(429).send({ error: `Слишком много запросов на импорт любимых треков. Подождите ${limitCheck.retryAfterSec || 60} сек.` });
  }

  try {
    const playlistData = await fetchSpotifyLikedSongs(req.user.id);
    if (!playlistData.tracks || playlistData.tracks.length === 0) {
      return reply.status(400).send({ error: 'В вашем разделе «Любимые треки» Spotify нет песен' });
    }

    // Helper for robust title matching (removes remaster/feat noise)
    const cleanTitle = (str: string) => {
      return (str || '')
        .toLowerCase()
        .replace(/\s*\(feat\..*?\)/gi, '')
        .replace(/\s*\[feat\..*?\]/gi, '')
        .replace(/\s*\(remaster.*?\)/gi, '')
        .replace(/\s*\[remaster.*?\]/gi, '')
        .replace(/\s*-\s*remaster.*?$/gi, '')
        .trim();
    };

    // 1. Get tracks already in user's liked_tracks on this site
    // (Existing liked tracks on the site are NEVER deleted or modified)
    const existingLiked: any[] = db.prepare(`
      SELECT t.id, t.spotify_id, LOWER(t.title) as title, LOWER(t.artist) as artist
      FROM liked_tracks lt
      JOIN tracks t ON lt.track_id = t.id
      WHERE lt.user_id = ?
    `).all(req.user.id);

    // 2. Identify missing tracks that need to be added to liked_tracks
    const missingFromLiked = playlistData.tracks.filter((st) => {
      const stCleanT = cleanTitle(st.title);
      const stCleanA = (st.artist || '').toLowerCase().trim();
      return !existingLiked.some((er) => {
        if (st.id && er.spotify_id && er.spotify_id === st.id) return true;
        const erCleanT = cleanTitle(er.title);
        const erCleanA = (er.artist || '').toLowerCase().trim();
        return (
          er.title === st.title.toLowerCase().trim() &&
          er.artist === st.artist.toLowerCase().trim()
        ) || (
          erCleanT === stCleanT &&
          erCleanA === stCleanA
        );
      });
    });

    // 3. For any missing tracks that already exist in tracks table (on disk), link them immediately
    let immediatelyLinked = 0;
    const needDownload: typeof playlistData.tracks = [];

    const findOnDiskStmt = db.prepare(`
      SELECT id, spotify_id FROM tracks 
      WHERE (spotify_id IS NOT NULL AND spotify_id = ?) 
         OR (LOWER(title) = ? AND LOWER(artist) = ?)
      LIMIT 1
    `);

    const tracksToLink: { id: number; spotifyId?: string; hasSpotifyId: boolean }[] = [];

    for (const st of missingFromLiked) {
      const onDisk: any = findOnDiskStmt.get(st.id, st.title.toLowerCase().trim(), st.artist.toLowerCase().trim());
      if (onDisk) {
        tracksToLink.push({ id: onDisk.id, spotifyId: st.id, hasSpotifyId: Boolean(onDisk.spotify_id) });
        immediatelyLinked++;
      } else {
        needDownload.push(st);
      }
    }

    if (tracksToLink.length > 0) {
      const insertLikeStmt = db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)');
      const updateSpotifyIdStmt = db.prepare('UPDATE tracks SET spotify_id = ? WHERE id = ?');
      const linkBatchTx = db.transaction((items: typeof tracksToLink) => {
        for (const item of items) {
          insertLikeStmt.run(req.user.id, item.id);
          if (item.spotifyId && !item.hasSpotifyId) {
            try {
              updateSpotifyIdStmt.run(item.spotifyId, item.id);
            } catch (_) {}
          }
        }
      });
      linkBatchTx(tracksToLink);
    }

    const totalCountRow: any = db.prepare('SELECT COUNT(*) as cnt FROM liked_tracks WHERE user_id = ?').get(req.user.id);

    if (immediatelyLinked > 0) {
      broadcastToUser(req.user.id, { type: 'LIKES_UPDATED' });
    }

    if (needDownload.length === 0) {
      return {
        success: true,
        alreadyUpToDate: true,
        totalTracks: totalCountRow?.cnt || 0,
        newTracks: immediatelyLinked,
        message: immediatelyLinked > 0
          ? `Догружено новых треков: ${immediatelyLinked}. Все треки с сайта сохранены!`
          : 'Все треки из Spotify уже есть в вашем разделе «Любимые треки». Никакие треки с сайта не удалялись.'
      };
    }

    const jobId = Math.random().toString(36).substring(2, 10);
    const totalCount = (totalCountRow?.cnt || 0) + needDownload.length;

    db.prepare(`
      INSERT INTO download_jobs (id, user_id, playlist_id, playlist_name, total_tracks, downloaded_tracks, status)
      VALUES (?, ?, NULL, 'Любимые треки', ?, ?, 'downloading')
    `).run(jobId, req.user.id, totalCount, totalCountRow?.cnt || 0);

    enqueuePlaylistDownload(jobId, req.user.id, null, needDownload, 0, true);

    return {
      success: true,
      jobId,
      newTracks: needDownload.length,
      totalTracks: totalCount,
      message: `Найдено новых треков для догрузки: ${needDownload.length}. Треки с сайта не удаляются и остаются в сохранности.`
    };
  } catch (err: any) {
    return reply.status(500).send({ error: err.message || 'Ошибка импорта любимых треков' });
  }
});

server.post('/api/spotify/import-user-playlists', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const limitCheck = consumeRateLimit('sp_import_user_pl:' + req.user.id, 3, 60000);
  if (limitCheck.blocked) {
    return reply.status(429).send({ error: `Слишком много запросов на импорт плейлистов. Подождите ${limitCheck.retryAfterSec || 60} сек.` });
  }

  try {
    const spotifyPlaylists = await fetchSpotifyUserPlaylists(req.user.id);
    if (!spotifyPlaylists || spotifyPlaylists.length === 0) {
      return { success: true, message: 'В вашем аккаунте Spotify не найдено плейлистов', totalPlaylists: 0, queuedPlaylists: 0 };
    }

    const playlistsToQueue: { id: number; name: string }[] = [];
    const findPlStmt = db.prepare('SELECT id FROM playlists WHERE user_id = ? AND spotify_id = ?');
    const insertPlStmt = db.prepare(`
      INSERT INTO playlists (user_id, name, description, cover_url, spotify_id)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const sp of spotifyPlaylists) {
      let existing: any = findPlStmt.get(req.user.id, sp.id);
      let playlistId: number;

      if (!existing) {
        const info = insertPlStmt.run(req.user.id, sp.name, sp.description || 'Импортировано из Spotify', sp.cover_url || null, sp.id);
        playlistId = Number(info.lastInsertRowid);
      } else {
        playlistId = existing.id;
      }
      playlistsToQueue.push({ id: playlistId, name: sp.name });
    }

    // Queue sequentially in background with polite delay to avoid Spotify API 429 rate limit
    (async () => {
      for (const item of playlistsToQueue) {
        try {
          await resumePlaylistDownload(item.id);
          // Wait 600ms between playlist expansions to respect Spotify API rate limit
          await new Promise((r) => setTimeout(r, 600));
        } catch (err: any) {
          console.warn(`[Sync Playlist Background] Failed to queue ${item.name}:`, err.message);
        }
      }
    })().catch((err) => console.error('[Sync Playlists Fatal]', err));

    return {
      success: true,
      message: `Начата синхронизация ${playlistsToQueue.length} плейлистов из Spotify`,
      totalPlaylists: spotifyPlaylists.length,
      queuedPlaylists: playlistsToQueue.length
    };
  } catch (err: any) {
    return reply.status(500).send({ error: err.message || 'Ошибка импорта плейлистов' });
  }
});

server.post('/api/spotify/import-list', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const limitCheck = consumeRateLimit('sp_import_list:' + req.user.id, 5, 60000);
  if (limitCheck.blocked) {
    return reply.status(429).send({ error: `Слишком много запросов на импорт списка. Подождите ${limitCheck.retryAfterSec || 60} сек.` });
  }

  const body = req.body || {};
  const { text, playlistName, playlistId: requestedPlaylistId } = body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return reply.status(400).send({ error: 'Вставьте список треков или ссылок' });
  }

  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length > 500) {
    return reply.status(400).send({ error: 'Превышен лимит строк для разового импорта (максимум 500 треков)' });
  }

  try {
    const tracks = await parseTrackListText(text, req.user.id);
    if (!tracks || tracks.length === 0) {
      return reply.status(400).send({ error: 'Не удалось распознать ни одного трека из текста' });
    }

    let targetPlaylistId = requestedPlaylistId ? Number(requestedPlaylistId) : null;
    const sharedAlbumName =
      tracks.length >= 2 &&
      tracks[0]?.album &&
      tracks.every((t) => t.album === tracks[0].album)
        ? tracks[0].album
        : '';
    let finalPlaylistName = playlistName ? playlistName.trim() : (sharedAlbumName || 'Импортированный список');

    if (targetPlaylistId) {
      const pl: any = db.prepare('SELECT id, name, cover_url FROM playlists WHERE id = ? AND user_id = ?').get(targetPlaylistId, req.user.id);
      if (pl) {
        finalPlaylistName = pl.name;
        if (!pl.cover_url && tracks[0]?.cover_url) {
          db.prepare('UPDATE playlists SET cover_url = ? WHERE id = ?').run(tracks[0].cover_url, targetPlaylistId);
        }
      } else {
        targetPlaylistId = null;
      }
    }

    if (!targetPlaylistId) {
      const existing: any = db.prepare('SELECT id, cover_url FROM playlists WHERE user_id = ? AND LOWER(name) = LOWER(?)').get(req.user.id, finalPlaylistName);
      if (existing) {
        targetPlaylistId = existing.id;
        if (!existing.cover_url && tracks[0]?.cover_url) {
          db.prepare('UPDATE playlists SET cover_url = ? WHERE id = ?').run(tracks[0].cover_url, targetPlaylistId);
        }
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
function batchMatchLocalTracks(tracks: any[]): Map<string, any> {
  const result = new Map<string, any>();
  if (!tracks || tracks.length === 0) return result;

  const validIds = tracks.map((t) => t.id).filter(Boolean);
  if (validIds.length > 0) {
    const placeholders = validIds.map(() => '?').join(',');
    const matched: any[] = db.prepare(`SELECT * FROM tracks WHERE spotify_id IN (${placeholders})`).all(...validIds);
    for (const m of matched) {
      if (m.spotify_id) {
        result.set(`id:${m.spotify_id}`, m);
      }
    }
  }

  const findByTitleArtistStmt = db.prepare(`
    SELECT * FROM tracks 
    WHERE LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?) 
    LIMIT 1
  `);

  for (const t of tracks) {
    if (t.id && result.has(`id:${t.id}`)) continue;
    const match = findByTitleArtistStmt.get(t.title, t.artist);
    if (match) {
      const key = t.id ? `id:${t.id}` : `ta:${(t.artist || '').toLowerCase().trim()}:::${(t.title || '').toLowerCase().trim()}`;
      result.set(key, match);
    }
  }

  return result;
}

server.get('/api/search', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const query = (req.query.q || '').trim().slice(0, 200);
  if (!query) {
    return { localTracks: [], spotifyTracks: [] };
  }

  // Check if the search query is a direct Spotify URL/URI (track, album, playlist, artist, or short link)
  const parsedEntity = await resolveSpotifyEntityInput(query);
  if (parsedEntity) {
    let spotifyRaw: any[] = [];
    try {
      const collection = await fetchSpotifyPlaylist(query, req.user?.id);
      spotifyRaw = (collection.tracks || []).slice(0, 50);
    } catch (err: any) {
      console.warn('[Search Spotify URL Error]', err.message);
    }

    const localMatchMap = batchMatchLocalTracks(spotifyRaw);
    const localTracks: any[] = [];
    const spotifyTracks = spotifyRaw.map((st) => {
      const key = (st.id && localMatchMap.has(`id:${st.id}`))
        ? `id:${st.id}`
        : `ta:${(st.artist || '').toLowerCase().trim()}:::${(st.title || '').toLowerCase().trim()}`;
      const matchedLocal: any = localMatchMap.get(key) || null;

      if (matchedLocal && !localTracks.some((lt) => lt.id === matchedLocal.id)) {
        localTracks.push(sanitizeTrackForClient(matchedLocal));
      }

      return {
        ...st,
        is_downloaded: !!matchedLocal,
        local_track_id: matchedLocal?.id || null,
        local_track: sanitizeTrackForClient(matchedLocal) || null
      };
    });

    return { localTracks, spotifyTracks };
  }

  // 1. Search Local Database (up to 5 tracks, deduplicated by title & artist)
  const localTracks = db.prepare(`
    SELECT id, title, artist, album, duration_ms, cover_url, spotify_id FROM tracks
    WHERE LOWER(title) LIKE LOWER(?) OR LOWER(artist) LIKE LOWER(?) OR LOWER(album) LIKE LOWER(?)
    GROUP BY LOWER(title), LOWER(artist)
    ORDER BY
      CASE WHEN LOWER(title) = LOWER(?) THEN 1
           WHEN LOWER(title) LIKE LOWER(?) THEN 2
           ELSE 3 END
    LIMIT 5
  `).all(`%${query}%`, `%${query}%`, `%${query}%`, query, `${query}%`);

  // 2. Search External Music APIs (Spotify OAuth / Deezer / iTunes, up to 8 tracks)
  let spotifyRaw: any[] = [];
  try {
    spotifyRaw = await searchSpotifyTracks(query, 8, req.user?.id);
  } catch (err: any) {
    console.warn('[Search External Error]', err.message);
  }

  // Batch match external tracks against local DB
  const localMatchMap = batchMatchLocalTracks(spotifyRaw);
  const spotifyTracks = spotifyRaw.map((st) => {
    const key = (st.id && localMatchMap.has(`id:${st.id}`))
      ? `id:${st.id}`
      : `ta:${(st.artist || '').toLowerCase().trim()}:::${(st.title || '').toLowerCase().trim()}`;
    const matchedLocal: any = localMatchMap.get(key) || null;

    return {
      ...st,
      is_downloaded: !!matchedLocal,
      local_track_id: matchedLocal?.id || null,
      local_track: sanitizeTrackForClient(matchedLocal) || null
    };
  });

  return { localTracks, spotifyTracks };
});

server.post('/api/tracks/download-single', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const body = req.body || {};
  const { track, playlistId, isLikedOnly } = body;
  if (!track || !track.title || !track.artist) {
    return reply.status(400).send({ error: 'Трек не указан или отсутствуют данные' });
  }

  // Sanitize and cap length to prevent DoS
  track.title = String(track.title).slice(0, 250);
  track.artist = String(track.artist).slice(0, 250);
  if (track.album) track.album = String(track.album).slice(0, 250);

  const result = await downloadSingleSpotifyTrackDirect(
    track,
    req.user.id,
    playlistId !== undefined && playlistId !== null ? Number(playlistId) : undefined,
    Boolean(isLikedOnly)
  );
  if (!result.success) {
    return reply.status(500).send({ error: result.error || 'Ошибка скачивания трека' });
  }
  return {
    ...result,
    track: result.track ? sanitizeTrackForClient(result.track) : undefined
  };
});

server.post('/api/tracks/play-instant', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  const body = req.body || {};
  const { track } = body;
  if (!track || !track.title || !track.artist) {
    return reply.status(400).send({ error: 'Трек не указан или отсутствуют данные' });
  }

  // Sanitize and cap length to prevent DoS
  track.title = String(track.title).slice(0, 250);
  track.artist = String(track.artist).slice(0, 250);
  if (track.album) track.album = String(track.album).slice(0, 250);

  // 1. Check if track already exists locally in DB
  const existing: any = db.prepare(`
    SELECT * FROM tracks 
    WHERE (spotify_id IS NOT NULL AND spotify_id = ?) 
       OR (LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?))
    LIMIT 1
  `).get(track.id, track.title, track.artist);

  if (existing && existing.file_path && fs.existsSync(existing.file_path)) {
    // Opportunistically queue quality upgrade in background if legacy .m4a or low bitrate
    queueTrackQualityUpgrade(existing);
    return {
      isExisting: true,
      isPreview: false,
      track: sanitizeTrackForClient(existing),
      streamUrl: `/api/stream/${existing.id}`
    };
  }

  // 2. Start background download asynchronously with deduplication
  const bgPromise = downloadSingleSpotifyTrackDirect(track, req.user.id);
  bgPromise.then((res) => {
    if (res.success && res.track) {
      broadcastToUser(req.user.id, {
        type: 'INSTANT_TRACK_DOWNLOADED',
        spotifyId: track.id,
        track: sanitizeTrackForClient(res.track)
      });
    }
  }).catch((err) => {
    console.warn('[Play Instant Background Download Error]', err.message);
  });

  // 3. Concurrently get Deezer 30s preview URL (typically resolves in 400-800ms)
  let previewUrl: string | null = null;
  let coverUrl = track.cover_url;
  let albumName = track.album;
  let durationMs = track.duration_ms;

  try {
    const dz = await resolveDeezerTrackInfo(track.artist, track.title);
    if (dz.preview) {
      previewUrl = dz.preview;
    }
    if (dz.cover_url && (!coverUrl || coverUrl.includes('mosaic.scdn.co'))) {
      coverUrl = dz.cover_url;
    }
    if (dz.album && !albumName) {
      albumName = dz.album;
    }
    if (dz.duration && (!durationMs || durationMs <= 0)) {
      durationMs = dz.duration * 1000;
    }
  } catch (_) {}

  // 4. If Deezer preview is available, return immediately (<300ms)!
  if (previewUrl) {
    return {
      isExisting: false,
      isPreview: true,
      streamUrl: previewUrl,
      track: {
        id: -Date.now(),
        title: track.title,
        artist: track.artist,
        album: albumName || '',
        duration_ms: durationMs || 180000,
        cover_url: coverUrl || '',
        spotify_id: track.id,
        isPreview: true
      }
    };
  }

  // 5. Fallback if no Deezer preview: check if background download completes within 1.5s
  const quickResult = await Promise.race([
    bgPromise,
    new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 1500))
  ]);

  if ('success' in quickResult && quickResult.success && quickResult.track) {
    return {
      isExisting: true,
      isPreview: false,
      track: sanitizeTrackForClient(quickResult.track),
      streamUrl: `/api/stream/${quickResult.track.id}`
    };
  }

  // 6. Otherwise NEVER block the HTTP connection! Return pending download status immediately
  return {
    isExisting: false,
    isPreview: false,
    isPendingDownload: true,
    track: {
      id: -Date.now(),
      title: track.title,
      artist: track.artist,
      album: albumName || '',
      duration_ms: durationMs || 180000,
      cover_url: coverUrl || '',
      spotify_id: track.id,
      isPreview: false
    }
  };
});

server.get('/api/tracks/quality-stats', { preHandler: [(server as any).authenticate] }, async () => {
  return getQualityAuditStats();
});

server.post('/api/tracks/upgrade-quality', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  if (!isAdmin(req)) {
    return reply.status(403).send({ error: 'Доступ разрешен только администратору' });
  }
  return await reDownloadAllTracksInHighQuality();
});

server.get('/api/tracks/upgrade-quality/status', { preHandler: [(server as any).authenticate] }, async () => {
  return getUpgradeProgress();
});

server.post('/api/tracks/upgrade-quality/stop', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  if (!isAdmin(req)) {
    return reply.status(403).send({ error: 'Доступ разрешен только администратору' });
  }
  return { stopped: stopQualityUpgrade() };
});

server.get('/api/downloads/scheduler/status', { preHandler: [(server as any).authenticate] }, async () => {
  return getDownloadSchedulerStats();
});

// ----------------- LIKES -----------------
server.get('/api/likes', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const blVer = getUserBlacklistVersion(req.user.id);
  const stats: any = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(MAX(created_at), '') as maxAdded, COALESCE(TOTAL(track_id), 0) as idSum
    FROM liked_tracks WHERE user_id = ?
  `).get(req.user.id);

  const currentCount = Number(stats?.count) || 0;
  const currentMaxAdded = String(stats?.maxAdded || '');
  const idSum = Math.round(Number(stats?.idSum) || 0);
  const currentVersion = `v_likes_${req.user.id}_${currentCount}_${idSum}_${currentMaxAdded}_${blVer}`;

  if (req.query.version && req.query.version === currentVersion) {
    return { upToDate: true, version: currentVersion };
  }

  const rawTracks: any[] = db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, t.duration_ms, t.cover_url, lt.created_at as added_at
    FROM liked_tracks lt
    JOIN tracks t ON lt.track_id = t.id
    WHERE lt.user_id = ?
    ORDER BY lt.created_at DESC
  `).all(req.user.id) as any[];

  const validTracks = filterBlacklistedTracksForUser(req.user.id, rawTracks);
  return { version: currentVersion, tracks: validTracks };
});

server.post('/api/likes/:trackId', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const trackId = Number(req.params.trackId);
  if (!trackId || isNaN(trackId) || trackId <= 0) {
    return { liked: false };
  }
  const body = req.body || {};
  const explicitLiked = typeof body.liked === 'boolean' ? body.liked : null;
  const exists = !!db.prepare('SELECT 1 FROM liked_tracks WHERE user_id = ? AND track_id = ?').get(req.user.id, trackId);

  let newLikedState: boolean;
  if (explicitLiked !== null) {
    newLikedState = explicitLiked;
  } else {
    newLikedState = !exists;
  }

  if (newLikedState) {
    db.prepare('INSERT OR IGNORE INTO liked_tracks (user_id, track_id) VALUES (?, ?)').run(req.user.id, trackId);
  } else {
    db.prepare('DELETE FROM liked_tracks WHERE user_id = ? AND track_id = ?').run(req.user.id, trackId);
  }

  const trackRow = newLikedState
    ? db.prepare('SELECT id, title, artist, album, duration_ms, cover_url FROM tracks WHERE id = ?').get(trackId)
    : null;

  broadcastToUser(req.user.id, {
    type: 'LIKES_UPDATED',
    trackId,
    liked: newLikedState,
    track: trackRow || null,
  });

  return { liked: newLikedState };
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
  let { title, artist, spotify_id, track_id } = body;
  if (!title || !artist) return reply.status(400).send({ error: 'Название и артист обязательны' });
  title = String(title).trim().slice(0, 200);
  artist = String(artist).trim().slice(0, 200);
  spotify_id = spotify_id ? String(spotify_id).trim().slice(0, 64) : '';

  // 1. Add to blacklist if not already added
  const existing = db.prepare(
    'SELECT id FROM blacklist WHERE user_id = ? AND LOWER(title) = LOWER(?) AND LOWER(artist) = LOWER(?)'
  ).get(req.user.id, title, artist);
  if (!existing) {
    db.prepare(`
      INSERT INTO blacklist (user_id, title, artist, spotify_id)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, title, artist, spotify_id || '');
    invalidateUserBlacklistCache(req.user.id);
  }

  // 2. Immediately cancel in-flight / queued downloads for this track/artist in downloader
  cancelBlacklistedDownloads(req.user.id, title, artist, spotify_id);

  // 3. Remove this track from ALL playlists owned by this user
  const targetTrackIds: number[] = [];
  if (track_id) {
    targetTrackIds.push(Number(track_id));
  }
  const matchingTracks: any[] = db.prepare(`
    SELECT id FROM tracks 
    WHERE (LOWER(title) = LOWER(?) AND (LOWER(artist) = LOWER(?) OR ? = '*'))
       OR (? != '' AND spotify_id = ?)
  `).all(title, artist, title, spotify_id || '', spotify_id || '');

  for (const mt of matchingTracks) {
    if (!targetTrackIds.includes(mt.id)) {
      targetTrackIds.push(mt.id);
    }
  }

  if (targetTrackIds.length > 0) {
    const placeholders = targetTrackIds.map(() => '?').join(',');
    db.prepare(`
      DELETE FROM playlist_tracks 
      WHERE track_id IN (${placeholders}) 
        AND playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)
    `).run(...targetTrackIds, req.user.id);

    db.prepare(`
      DELETE FROM liked_tracks 
      WHERE user_id = ? AND track_id IN (${placeholders})
    `).run(req.user.id, ...targetTrackIds);
  }

  // 4. Clean up daily_mix_tracks_json for all Daily Mixes of this user
  const userDailyMixes: any[] = db.prepare(`
    SELECT id, daily_mix_tracks_json FROM playlists 
    WHERE user_id = ? AND (is_daily_mix = 1 OR name LIKE 'Daily Mix%' OR name LIKE 'Микс дня%')
  `).all(req.user.id);

  const lTitle = title.toLowerCase().trim();
  const lArtist = artist.toLowerCase().trim();
  const primaryArtist = lArtist.split(/[,&/]| feat\.? | ft\.? /i)[0].trim();

  for (const dm of userDailyMixes) {
    if (!dm.daily_mix_tracks_json) continue;
    try {
      const dmTracks: any[] = JSON.parse(dm.daily_mix_tracks_json);
      const filtered = dmTracks.filter((t: any) => {
        if (spotify_id && t.id === spotify_id) return false;
        const tTitle = (t.title || '').toLowerCase().trim();
        const tArtist = (t.artist || '').toLowerCase().trim();
        const matchArtist = tArtist === lArtist || tArtist === primaryArtist || tArtist.startsWith(lArtist);
        const matchTitle = tTitle === lTitle || lTitle === '*';
        return !(matchArtist && matchTitle);
      });
      if (filtered.length !== dmTracks.length) {
        db.prepare('UPDATE playlists SET daily_mix_tracks_json = ? WHERE id = ?').run(
          JSON.stringify(filtered),
          dm.id
        );
      }
    } catch (_) {}
  }

  invalidateUserBlacklistCache(req.user.id);
  return { success: true, removedCount: targetTrackIds.length };
});

server.delete('/api/blacklist/:id', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  db.prepare('DELETE FROM blacklist WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  invalidateUserBlacklistCache(req.user.id);
  return { success: true };
});

// ----------------- RECOMMENDATIONS & SMART SHUFFLE -----------------
server.get('/api/recommendations', { preHandler: [(server as any).authenticate] }, async (req: any) => {
  const artistsQuery = req.query.artists
    ? String(req.query.artists)
        .split(',')
        .slice(0, 15)
        .map((a) => a.trim().slice(0, 100))
        .filter(Boolean)
    : [];
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

server.post('/api/settings', { preHandler: [(server as any).authenticate] }, async (req: any, reply: any) => {
  if (!isAdmin(req)) {
    return reply.status(403).send({ error: 'Доступ разрешен только администратору' });
  }

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

// SPA Fallback for React PWA routing with in-memory RAM caching
let cachedIndexHtml: Buffer | null = null;
let cachedIndexMtime = 0;

server.setNotFoundHandler(async (req, reply) => {
  if (req.raw.url && req.raw.url.startsWith('/api')) {
    return reply.status(404).send({ error: 'Endpoint not found' });
  }
  const indexPath = path.join(publicDir, 'index.html');
  try {
    const stat = await fs.promises.stat(indexPath);
    if (!cachedIndexHtml || cachedIndexMtime !== stat.mtimeMs) {
      cachedIndexHtml = await fs.promises.readFile(indexPath);
      cachedIndexMtime = stat.mtimeMs;
    }
    reply
      .header('Cache-Control', 'no-cache, no-store, must-revalidate')
      .header('Pragma', 'no-cache')
      .header('Expires', '0')
      .type('text/html')
      .send(cachedIndexHtml);
  } catch (_) {
    reply.status(404).send('Not Found');
  }
});

// Initialize Real-time Multi-device WebSocket Synchronization
setupWebSocketSync(server);

// Start Server
server.listen({ port: PORT, host: '0.0.0.0' }, async (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`[Jellyfin-Spotify] Server running at ${address}`);
  // Automatically resume any downloads that were interrupted
  await resumePendingDownloads();
  // Start automated nightly mix background generator & pre-downloader
  startNightlyScheduler();
});
