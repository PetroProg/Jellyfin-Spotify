import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db');

// Ensure parent dir exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(dbPath);

// Initialize tables
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT,
    jellyfin_user_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    cover_url TEXT,
    spotify_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT,
    duration_ms INTEGER DEFAULT 0,
    file_path TEXT NOT NULL,
    cover_url TEXT,
    spotify_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    position INTEGER DEFAULT 0,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    spotify_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS liked_tracks (
    user_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, track_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS download_jobs (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    playlist_id INTEGER,
    playlist_name TEXT NOT NULL,
    total_tracks INTEGER DEFAULT 0,
    downloaded_tracks INTEGER DEFAULT 0,
    current_track TEXT,
    status TEXT DEFAULT 'pending',
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Safe migrations
try {
  db.exec('ALTER TABLE users ADD COLUMN email TEXT;');
} catch (_) {}
try {
  db.exec('ALTER TABLE users ADD COLUMN spotify_access_token TEXT;');
} catch (_) {}
try {
  db.exec('ALTER TABLE users ADD COLUMN spotify_refresh_token TEXT;');
} catch (_) {}
try {
  db.exec('ALTER TABLE users ADD COLUMN spotify_token_expires INTEGER;');
} catch (_) {}
try {
  db.exec('ALTER TABLE users ADD COLUMN spotify_user_id TEXT;');
} catch (_) {}
try {
  db.exec('ALTER TABLE users ADD COLUMN spotify_display_name TEXT;');
} catch (_) {}

// Automatic deduplication of tracks: merge any duplicate (title + artist) tracks in playlist_tracks and liked_tracks
try {
  const duplicates = db.prepare(`
    SELECT LOWER(title) as l_title, LOWER(artist) as l_artist, MIN(id) as keep_id, GROUP_CONCAT(id) as all_ids
    FROM tracks
    GROUP BY LOWER(title), LOWER(artist)
    HAVING COUNT(*) > 1
  `).all() as any[];

  for (const dup of duplicates) {
    const keepId = dup.keep_id;
    const allIds = String(dup.all_ids).split(',').map(Number);
    const removeIds = allIds.filter((id: number) => id !== keepId);

    for (const removeId of removeIds) {
      db.prepare(`
        UPDATE OR IGNORE playlist_tracks
        SET track_id = ?
        WHERE track_id = ?
      `).run(keepId, removeId);

      db.prepare('DELETE FROM playlist_tracks WHERE track_id = ?').run(removeId);

      db.prepare(`
        UPDATE OR IGNORE liked_tracks
        SET track_id = ?
        WHERE track_id = ?
      `).run(keepId, removeId);

      db.prepare('DELETE FROM liked_tracks WHERE track_id = ?').run(removeId);

      db.prepare('DELETE FROM tracks WHERE id = ?').run(removeId);
    }
  }
} catch (e: any) {
  console.warn('[DB Deduplication routine]:', e.message);
}


