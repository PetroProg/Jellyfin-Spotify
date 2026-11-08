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

// Performance & concurrency pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 10000');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000'); // 64 MB page cache in RAM (vs default ~2 MB)
db.pragma('mmap_size = 268435456'); // 256 MB Memory-Mapped I/O for direct kernel zero-copy page reads
db.pragma('temp_store = MEMORY'); // Keep temporary tables and index sorts in RAM

// Initialize tables
db.exec(`
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
    UNIQUE(playlist_id, track_id),
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

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS artist_metadata (
    artist_name TEXT PRIMARY KEY,
    spotify_id TEXT,
    deezer_id INTEGER,
    genres TEXT,
    category TEXT,
    related_artists TEXT,
    cover_url TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS daily_mix_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    track_key TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT,
    duration_ms INTEGER DEFAULT 0,
    cover_url TEXT,
    spotify_id TEXT,
    category TEXT,
    recommended_date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Safe migrations
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_mix_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      track_key TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      duration_ms INTEGER DEFAULT 0,
      cover_url TEXT,
      spotify_id TEXT,
      category TEXT,
      recommended_date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
} catch (_) {}
try {
  db.exec('ALTER TABLE daily_mix_history ADD COLUMN album TEXT;');
} catch (_) {}
try {
  db.exec('ALTER TABLE daily_mix_history ADD COLUMN duration_ms INTEGER DEFAULT 0;');
} catch (_) {}
try {
  db.exec('ALTER TABLE daily_mix_history ADD COLUMN cover_url TEXT;');
} catch (_) {}
try {
  db.exec('ALTER TABLE daily_mix_history ADD COLUMN spotify_id TEXT;');
} catch (_) {}
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dm_history_user_key ON daily_mix_history(user_id, track_key);
    CREATE INDEX IF NOT EXISTS idx_dm_history_user_date ON daily_mix_history(user_id, recommended_date);
    CREATE INDEX IF NOT EXISTS idx_dm_history_spotify ON daily_mix_history(spotify_id);
    CREATE INDEX IF NOT EXISTS idx_dm_history_user_cat ON daily_mix_history(user_id, category, recommended_date);
  `);
} catch (_) {}
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
try {
  db.exec("ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'Europe/Kyiv';");
} catch (_) {}
try {
  db.exec('ALTER TABLE users ADD COLUMN nightly_mix_enabled INTEGER DEFAULT 1;');
} catch (_) {}
try {
  db.exec('ALTER TABLE users ADD COLUMN nightly_mix_hour INTEGER DEFAULT 3;');
} catch (_) {}
try {
  db.exec('ALTER TABLE playlists ADD COLUMN is_daily_mix INTEGER DEFAULT 0;');
} catch (_) {}
try {
  db.exec('ALTER TABLE playlists ADD COLUMN daily_mix_category TEXT;');
} catch (_) {}
try {
  db.exec('ALTER TABLE playlists ADD COLUMN daily_mix_number INTEGER;');
} catch (_) {}
try {
  db.exec('ALTER TABLE playlists ADD COLUMN daily_mix_date TEXT;');
} catch (_) {}
try {
  db.exec('ALTER TABLE playlists ADD COLUMN daily_mix_seed_artists TEXT;');
} catch (_) {}
try {
  db.exec('ALTER TABLE playlists ADD COLUMN daily_mix_tracks_json TEXT;');
} catch (_) {}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
} catch (_) {}

// Automatic deduplication of tracks: merge any duplicate (title + artist) tracks in playlist_tracks and liked_tracks
try {
  const duplicates = db.prepare(`
    SELECT LOWER(title) as l_title, LOWER(artist) as l_artist, MIN(id) as keep_id, GROUP_CONCAT(id) as all_ids
    FROM tracks
    GROUP BY LOWER(title), LOWER(artist)
    HAVING COUNT(*) > 1
  `).all() as any[];

  if (duplicates && duplicates.length > 0) {
    const deduplicateTx = db.transaction(() => {
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
    });
    deduplicateTx();
  }
} catch (e: any) {
  console.warn('[DB Deduplication routine]:', e.message);
}

// Deduplicate playlist_tracks and create unique index
try {
  db.exec(`
    DELETE FROM playlist_tracks
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM playlist_tracks
      GROUP BY playlist_id, track_id
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_tracks_unique ON playlist_tracks(playlist_id, track_id);
  `);
} catch (e: any) {
  console.warn('[DB Migration Warning]:', e.message);
}

// Audio bitrate tracking column
try {
  db.exec('ALTER TABLE tracks ADD COLUMN bitrate INTEGER DEFAULT NULL;');
} catch (_) {}

// High-performance query & search indexes
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tracks_spotify_id ON tracks(spotify_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_lower_title_artist ON tracks(LOWER(title), LOWER(artist));
    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
    CREATE INDEX IF NOT EXISTS idx_tracks_lower_artist ON tracks(LOWER(artist));
    CREATE INDEX IF NOT EXISTS idx_tracks_file_path ON tracks(file_path);
    CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track_id ON playlist_tracks(track_id);
    CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_pos ON playlist_tracks(playlist_id, position);
    CREATE INDEX IF NOT EXISTS idx_liked_tracks_user_created ON liked_tracks(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_liked_tracks_track_id ON liked_tracks(track_id);
    CREATE INDEX IF NOT EXISTS idx_playlists_user_daily ON playlists(user_id, is_daily_mix);
    CREATE INDEX IF NOT EXISTS idx_playlists_user_daily_date ON playlists(user_id, is_daily_mix, daily_mix_date);
    CREATE INDEX IF NOT EXISTS idx_blacklist_user_id ON blacklist(user_id);
    CREATE INDEX IF NOT EXISTS idx_blacklist_user_spotify ON blacklist(user_id, spotify_id);
    CREATE INDEX IF NOT EXISTS idx_download_jobs_user_status ON download_jobs(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_download_jobs_playlist_id ON download_jobs(playlist_id);
    CREATE INDEX IF NOT EXISTS idx_daily_mix_history_user_cat_date ON daily_mix_history(user_id, category, recommended_date);
    CREATE INDEX IF NOT EXISTS idx_daily_mix_history_track_key ON daily_mix_history(track_key);
    CREATE INDEX IF NOT EXISTS idx_daily_mix_history_created ON daily_mix_history(created_at);
  `);
} catch (e: any) {
  console.warn('[DB Index Migration Warning]:', e.message);
}




