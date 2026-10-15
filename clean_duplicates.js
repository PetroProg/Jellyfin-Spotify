const { db } = require('./dist/db');

// 1. Delete duplicate entries in playlist_tracks keeping minimum id
const res1 = db.prepare(`
  DELETE FROM playlist_tracks
  WHERE id NOT IN (
    SELECT MIN(id)
    FROM playlist_tracks
    GROUP BY playlist_id, track_id
  )
`).run();
console.log('Removed duplicate playlist_tracks rows:', res1.changes);

// 2. Create unique index on playlist_tracks(playlist_id, track_id)
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_playlist_tracks_unique ON playlist_tracks(playlist_id, track_id);');
console.log('Created UNIQUE index idx_playlist_tracks_unique');

// 3. Remove duplicate 'Любимые треки' from playlists table
const res3 = db.prepare(`
  DELETE FROM playlists
  WHERE name = 'Любимые треки' OR LOWER(name) = 'liked songs'
`).run();
console.log('Removed fake playlist from playlists table:', res3.changes);

// 4. Verify liked_tracks count
const likedCount = db.prepare('SELECT COUNT(*) as cnt FROM liked_tracks').get();
console.log('Total verified liked_tracks:', likedCount.cnt);

// 5. Verify remaining playlists
console.log('Remaining playlists:', db.prepare('SELECT id, name FROM playlists').all());
