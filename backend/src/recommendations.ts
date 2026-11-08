import { db } from './db';
import { isTrackBlacklistedForUser } from './downloader';
import { searchExternalTracks } from './spotify';

export interface RecommendationTrack {
  id: string | number;
  title: string;
  artist: string;
  album: string;
  cover_url: string;
  duration_ms: number;
  is_local: boolean;
  file_path?: string;
  spotify_id?: string;
}

interface RecCacheEntry {
  results: RecommendationTrack[];
  cachedAt: number;
}

const recCache = new Map<string, RecCacheEntry>();
const REC_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL
const MAX_REC_CACHE_SIZE = 300;

function pruneRecCache() {
  if (recCache.size > MAX_REC_CACHE_SIZE) {
    const now = Date.now();
    for (const [k, v] of recCache.entries()) {
      if (now - v.cachedAt > REC_CACHE_TTL_MS) {
        recCache.delete(k);
      }
    }
  }
}

// Fisher-Yates fast in-memory array shuffle
function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export async function getRecommendations(
  userId: number,
  seedArtists: string[],
  seedTrackTitle?: string
): Promise<RecommendationTrack[]> {
  const cleanArtists = (seedArtists || [])
    .map(a => (a || '').trim())
    .filter(Boolean);

  const cacheKey = `${userId}:::${cleanArtists.join(',').toLowerCase()}:::${(seedTrackTitle || '').toLowerCase()}`;
  const now = Date.now();
  const cached = recCache.get(cacheKey);
  if (cached && (now - cached.cachedAt) < REC_CACHE_TTL_MS) {
    return cached.results;
  }

  // Extract individual/primary artists: e.g. "Drake feat. 21 Savage" -> ["Drake", "21 Savage"]
  const searchArtists: string[] = [];
  for (const art of cleanArtists) {
    const parts = art.split(/[,&/]| feat\.? | ft\.? /i).map(p => p.trim()).filter(Boolean);
    for (const p of parts) {
      if (!searchArtists.includes(p)) searchArtists.push(p);
    }
  }

  let localCandidates: any[] = [];

  // 1. Query local tracks matching seed artists using index (no slow ORDER BY RANDOM() full-table scan)
  if (searchArtists.length > 0) {
    const placeholders = searchArtists.map(() => '?').join(',');
    const matched = db.prepare(`
      SELECT id, title, artist, album, duration_ms, file_path, cover_url, spotify_id
      FROM tracks
      WHERE artist IN (${placeholders})
      LIMIT 60
    `).all(...searchArtists);
    localCandidates.push(...matched);

    // Also match primary artist with prefix for composite artist fields
    if (localCandidates.length < 10) {
      const primary = searchArtists[0];
      const likeMatched = db.prepare(`
        SELECT id, title, artist, album, duration_ms, file_path, cover_url, spotify_id
        FROM tracks
        WHERE artist LIKE ? AND artist NOT IN (${placeholders})
        LIMIT 30
      `).all(`${primary}%`, ...searchArtists);
      localCandidates.push(...likeMatched);
    }
  }

  // 2. Fast Fallback to local tracks if fewer than 6 candidates found (fast index scan instead of full table ORDER BY RANDOM())
  if (localCandidates.length < 6) {
    const moreLocal = db.prepare(`
      SELECT id, title, artist, album, duration_ms, file_path, cover_url, spotify_id
      FROM tracks
      ORDER BY id DESC
      LIMIT 80
    `).all();
    localCandidates.push(...moreLocal);
  }

  // Deduplicate and filter blacklisted
  const seenIds = new Set<number>();
  const validLocal: RecommendationTrack[] = [];

  for (const tr of shuffleArray(localCandidates)) {
    if (seenIds.has(tr.id)) continue;
    seenIds.add(tr.id);

    if (isTrackBlacklistedForUser(userId, tr.title, tr.artist, tr.spotify_id)) {
      continue;
    }

    validLocal.push({
      id: tr.id,
      title: tr.title,
      artist: tr.artist,
      album: tr.album || '',
      cover_url: tr.cover_url || '',
      duration_ms: tr.duration_ms || 180000,
      is_local: true,
      file_path: tr.file_path,
      spotify_id: tr.spotify_id || undefined
    });

    if (validLocal.length >= 10) break;
  }

  // 3. Smart Shuffle External Enrichment: If local pool is small, supplement with external tracks
  if (validLocal.length < 8 && searchArtists.length > 0) {
    try {
      const query = searchArtists[0];
      const externalTracks = await searchExternalTracks(query, 8, userId);
      for (const et of externalTracks) {
        if (isTrackBlacklistedForUser(userId, et.title, et.artist, et.id)) continue;
        const existsInLocal = validLocal.some(
          v => (v.spotify_id && v.spotify_id === et.id) ||
               (v.title.toLowerCase() === et.title.toLowerCase() && v.artist.toLowerCase() === et.artist.toLowerCase())
        );
        if (!existsInLocal) {
          validLocal.push({
            id: et.id,
            title: et.title,
            artist: et.artist,
            album: et.album || '',
            cover_url: et.cover_url || '',
            duration_ms: et.duration_ms || 180000,
            is_local: false,
            spotify_id: et.id
          });
        }
        if (validLocal.length >= 10) break;
      }
    } catch (_) {}
  }

  const finalResults = validLocal.slice(0, 10);

  pruneRecCache();
  recCache.set(cacheKey, { results: finalResults, cachedAt: now });

  return finalResults;
}
