import { db } from './db';
import { getSpotifyCredentials } from './spotify';

export interface RecommendationTrack {
  id: string | number;
  title: string;
  artist: string;
  album: string;
  cover_url: string;
  duration_ms: number;
  is_local: boolean;
  file_path?: string;
}

export async function getRecommendations(
  userId: number,
  seedArtists: string[],
  seedTrackTitle?: string
): Promise<RecommendationTrack[]> {
  // 1. Get user blacklist
  const blacklisted = db.prepare(`
    SELECT LOWER(title) as title, LOWER(artist) as artist
    FROM blacklist
    WHERE user_id = ?
  `).all(userId) as { title: string; artist: string }[];

  const isBlacklisted = (title: string, artist: string) => {
    return blacklisted.some(b => 
      b.title === title.toLowerCase() || 
      (b.artist === artist.toLowerCase() && b.title === '*')
    );
  };

  // 2. Query local tracks by similar artists or genres first
  const artistPlaceholders = seedArtists.map(() => '?').join(',');
  let localRecommendations: any[] = [];
  
  if (seedArtists.length > 0) {
    localRecommendations = db.prepare(`
      SELECT id, title, artist, album, duration_ms, file_path, cover_url
      FROM tracks
      WHERE artist IN (${artistPlaceholders})
      ORDER BY RANDOM()
      LIMIT 10
    `).all(...seedArtists);
  }

  // Fallback to random local tracks if none matched by artist
  if (localRecommendations.length < 5) {
    const moreLocal = db.prepare(`
      SELECT id, title, artist, album, duration_ms, file_path, cover_url
      FROM tracks
      ORDER BY RANDOM()
      LIMIT 15
    `).all();
    localRecommendations = [...localRecommendations, ...moreLocal];
  }

  // Filter out blacklisted local tracks
  const filteredLocal: RecommendationTrack[] = localRecommendations
    .filter(t => !isBlacklisted(t.title, t.artist))
    .slice(0, 10)
    .map(t => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album || '',
      cover_url: t.cover_url || '',
      duration_ms: t.duration_ms || 180000,
      is_local: true,
      file_path: t.file_path
    }));

  return filteredLocal;
}
