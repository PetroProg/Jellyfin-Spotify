import fs from 'fs';
import { db } from './db';
import { SpotifyTrack, getSpotifyCredentials } from './spotify';
import { enqueuePlaylistDownload, cancelPlaylistDownloads } from './downloader';

export interface CategoryConfig {
  key: string;
  title: string;
  badge: string;
  accentColor: string;
  keywords: string[];
}

export const CATEGORY_DEFINITIONS: Record<string, CategoryConfig> = {
  phonk: {
    key: 'phonk',
    title: 'Фонк и Wave',
    badge: 'PHONK & WAVE',
    accentColor: 'sapphire',
    keywords: [
      'phonk', 'drift phonk', 'brazilian phonk', 'aggressive phonk',
      'chill phonk', 'wave', 'hardwave', 'memphis', 'cowbell', 'фонк'
    ]
  },
  electronic: {
    key: 'electronic',
    title: 'Электроника и Дэнс',
    badge: 'ELECTRONIC & EDM',
    accentColor: 'blue',
    keywords: [
      'electronic', 'edm', 'house', 'techno', 'trance', 'dubstep',
      'drum and bass', 'dnb', 'jungle', 'synthwave', 'retrowave',
      'hardstyle', 'electro', 'club', 'dance', 'bass', 'breakbeat',
      'future bass', 'garage', 'rave', 'hyperpop', 'eurodance',
      'tech house', 'deep house', 'big room', 'электроника', 'рейв', 'хаус', 'техно'
    ]
  },
  hiphop_ru: {
    key: 'hiphop_ru',
    title: 'Русский Хип-Хоп и Рэп',
    badge: 'RU HIP-HOP & RAP',
    accentColor: 'mauve',
    keywords: [
      'russian hip hop', 'russian rap', 'russian trap', 'russian drill',
      'russian plugg', 'russian drain', 'ukrainian hip hop', 'kazakh hip hop',
      'русский рэп', 'русский хип-хоп'
    ]
  },
  hiphop_intl: {
    key: 'hiphop_intl',
    title: 'Хип-Хоп и Трэп',
    badge: 'HIP-HOP & TRAP',
    accentColor: 'peach',
    keywords: [
      'hip hop', 'hip-hop', 'rap', 'trap', 'drill', 'grime', 'boom bap',
      'cloud rap', 'rage', 'melodic rap', 'atl hip hop', 'chicago rap',
      'gangsta rap', 'west coast rap', 'east coast hip hop', 'southern hip hop',
      'underground hip hop', 'dirty south', 'рэп', 'хип-хоп', 'трэп'
    ]
  },
  rock: {
    key: 'rock',
    title: 'Рок и Альтернатива',
    badge: 'ROCK & ALTERNATIVE',
    accentColor: 'red',
    keywords: [
      'rock', 'metal', 'alternative', 'punk', 'post-punk', 'grunge',
      'indie rock', 'hard rock', 'heavy metal', 'nu metal', 'metalcore',
      'deathcore', 'pop punk', 'emo', 'shoegaze', 'new wave', 'britpop',
      'classic rock', 'garage rock', 'psychedelic rock', 'progressive rock',
      'post-hardcore', 'gothic', 'russian rock', 'russian post-punk',
      'рок', 'панк', 'метал', 'пост-панк', 'альтернатива'
    ]
  },
  pop: {
    key: 'pop',
    title: 'Поп и R&B',
    badge: 'POP & R&B',
    accentColor: 'pink',
    keywords: [
      'pop', 'dance pop', 'synth-pop', 'electropop', 'teen pop', 'k-pop',
      'j-pop', 'europop', 'estrada', 'r&b', 'rnb', 'soul', 'neo soul',
      'funk', 'disco', 'contemporary r&b', 'art pop', 'latin pop',
      'russian pop', 'поп', 'соул'
    ]
  },
  chill: {
    key: 'chill',
    title: 'Инди и Атмосфера',
    badge: 'INDIE & CHILL',
    accentColor: 'teal',
    keywords: [
      'indie', 'lo-fi', 'lofi', 'chill', 'ambient', 'acoustic', 'folk',
      'singer-songwriter', 'soundtrack', 'score', 'classical', 'jazz',
      'blues', 'instrumental', 'downtempo', 'trip hop', 'dream pop',
      'bedroom pop', 'anime', 'neoclassical', 'piano', 'инди', 'чилл'
    ]
  }
};

interface ArtistMetadataRecord {
  artist_name: string;
  spotify_id: string | null;
  deezer_id: number | null;
  genres: string[];
  category: string | null;
  related_artists: { name: string; deezer_id?: number; cover_url?: string }[];
  cover_url: string | null;
}

const generationInProgress = new Map<number, Promise<any[]>>();

function hasCyrillic(text: string): boolean {
  return /[а-яёіїєґ]/i.test(text || '');
}

export function extractPrimaryArtist(artistStr: string): string {
  if (!artistStr) return 'Unknown Artist';
  const cleaned = artistStr
    .split(/\s*(?:,|feat\.|ft\.|&|;|\/|\bx\b|\bпри уч\.)\s*/i)[0]
    .trim();
  return cleaned || artistStr.trim();
}

function normalizeTrackKey(artist: string, title: string): string {
  const cleanArtist = extractPrimaryArtist(artist).toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
  const cleanTitle = (title || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^a-zа-яё0-9]/gi, '');
  return `${cleanArtist}:::${cleanTitle}`;
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 4500): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let cachedClientSpotifyToken: string | null = null;
let cachedClientTokenExp = 0;

async function getSpotifyAppToken(): Promise<string | null> {
  const { clientId, clientSecret } = getSpotifyCredentials();
  if (!clientId || !clientSecret) return null;
  if (cachedClientSpotifyToken && Date.now() < cachedClientTokenExp) {
    return cachedClientSpotifyToken;
  }
  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    cachedClientSpotifyToken = data.access_token;
    cachedClientTokenExp = Date.now() + (data.expires_in - 60) * 1000;
    return cachedClientSpotifyToken;
  } catch {
    return null;
  }
}

/**
 * Classifies a list of genre strings + artist/track context into a strict category key.
 */
export function classifyGenresToCategory(genres: string[], artistName: string, sampleTitle?: string): string | null {
  const joined = genres.map(g => g.toLowerCase().trim()).join(' | ');
  const isRu =
    hasCyrillic(artistName) ||
    hasCyrillic(sampleTitle || '') ||
    joined.includes('russian') ||
    joined.includes('ukrainian') ||
    joined.includes('kazakh') ||
    joined.includes('belarusian');

  // 1. Check Phonk first (since phonk is sometimes tagged along with hip-hop or electronic)
  for (const kw of CATEGORY_DEFINITIONS.phonk.keywords) {
    if (joined.includes(kw)) return 'phonk';
  }

  // 2. Check Hip-Hop / Rap / Trap
  const isHipHop =
    CATEGORY_DEFINITIONS.hiphop_ru.keywords.some(kw => joined.includes(kw)) ||
    CATEGORY_DEFINITIONS.hiphop_intl.keywords.some(kw => joined.includes(kw)) ||
    joined.includes('hip-hop/rap') ||
    joined.includes('hip hop/rap') ||
    joined.includes('rap');

  if (isHipHop) {
    return isRu ? 'hiphop_ru' : 'hiphop_intl';
  }

  // 3. Check Rock / Metal / Alternative / Punk
  if (CATEGORY_DEFINITIONS.rock.keywords.some(kw => joined.includes(kw))) {
    return 'rock';
  }

  // 4. Check Electronic / Dance / EDM
  if (CATEGORY_DEFINITIONS.electronic.keywords.some(kw => joined.includes(kw))) {
    return 'electronic';
  }

  // 5. Check Chill / Indie / Acoustic / Lo-Fi / Classical / Jazz
  if (CATEGORY_DEFINITIONS.chill.keywords.some(kw => joined.includes(kw))) {
    return 'chill';
  }

  // 6. Check Pop / R&B
  if (CATEGORY_DEFINITIONS.pop.keywords.some(kw => joined.includes(kw))) {
    return 'pop';
  }

  return null;
}

/**
 * Resolves and caches artist metadata (genres, category, Deezer ID, related artists, cover).
 */
export async function resolveArtistMetadata(artistName: string, sampleTrackTitle?: string): Promise<ArtistMetadataRecord> {
  const primary = extractPrimaryArtist(artistName);
  const key = primary.toLowerCase();

  try {
    const cached: any = db.prepare('SELECT * FROM artist_metadata WHERE artist_name = ?').get(key);
    if (cached && cached.category) {
      return {
        artist_name: key,
        spotify_id: cached.spotify_id,
        deezer_id: cached.deezer_id,
        genres: JSON.parse(cached.genres || '[]'),
        category: cached.category,
        related_artists: JSON.parse(cached.related_artists || '[]'),
        cover_url: cached.cover_url
      };
    }
  } catch (_) {}

  const genres: string[] = [];
  let spotifyId: string | null = null;
  let deezerId: number | null = null;
  let coverUrl: string | null = null;
  const relatedArtists: { name: string; deezer_id?: number; cover_url?: string }[] = [];

  // Run lookups in parallel: iTunes (genre), Deezer (artist ID + related), Spotify (detailed genres)
  await Promise.all([
    // 1. iTunes Search API for reliable primaryGenreName
    (async () => {
      try {
        const q = encodeURIComponent(`${primary} ${sampleTrackTitle || ''}`.trim());
        const res = await fetchWithTimeout(`https://itunes.apple.com/search?term=${q}&entity=song&limit=5`);
        if (res.ok) {
          const data: any = await res.json();
          for (const item of data.results || []) {
            if (item.primaryGenreName) {
              const g = String(item.primaryGenreName).toLowerCase();
              if (g !== 'music' && !genres.includes(g)) {
                genres.push(g);
              }
            }
          }
        }
      } catch (_) {}
    })(),

    // 2. Deezer Artist Search + Related Artists
    (async () => {
      try {
        const res = await fetchWithTimeout(`https://api.deezer.com/search/artist?q=${encodeURIComponent(primary)}&limit=3`);
        if (res.ok) {
          const data: any = await res.json();
          const best = (data.data || [])[0];
          if (best && best.id) {
            deezerId = Number(best.id);
            coverUrl = best.picture_xl || best.picture_big || best.picture_medium || null;

            const relRes = await fetchWithTimeout(`https://api.deezer.com/artist/${deezerId}/related?limit=15`);
            if (relRes.ok) {
              const relData: any = await relRes.json();
              for (const r of relData.data || []) {
                if (r.name) {
                  relatedArtists.push({
                    name: r.name,
                    deezer_id: r.id,
                    cover_url: r.picture_xl || r.picture_big || r.picture_medium
                  });
                }
              }
            }
          }
        }
      } catch (_) {}
    })(),

    // 3. Spotify Artist Search (if configured)
    (async () => {
      try {
        const token = await getSpotifyAppToken();
        if (!token) return;
        const res = await fetchWithTimeout(
          `https://api.spotify.com/v1/search?type=artist&limit=2&q=${encodeURIComponent(primary)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (res.ok) {
          const data: any = await res.json();
          const spArtist = data.artists?.items?.[0];
          if (spArtist) {
            spotifyId = spArtist.id || null;
            if (!coverUrl && spArtist.images?.[0]?.url) {
              coverUrl = spArtist.images[0].url;
            }
            for (const g of spArtist.genres || []) {
              if (!genres.includes(g.toLowerCase())) {
                genres.push(g.toLowerCase());
              }
            }
          }
        }
      } catch (_) {}
    })()
  ]);

  const category = classifyGenresToCategory(genres, primary, sampleTrackTitle);

  const record: ArtistMetadataRecord = {
    artist_name: key,
    spotify_id: spotifyId,
    deezer_id: deezerId,
    genres,
    category,
    related_artists: relatedArtists,
    cover_url: coverUrl
  };

  try {
    db.prepare(`
      INSERT INTO artist_metadata (artist_name, spotify_id, deezer_id, genres, category, related_artists, cover_url, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(artist_name) DO UPDATE SET
        spotify_id = COALESCE(excluded.spotify_id, artist_metadata.spotify_id),
        deezer_id = COALESCE(excluded.deezer_id, artist_metadata.deezer_id),
        genres = excluded.genres,
        category = COALESCE(excluded.category, artist_metadata.category),
        related_artists = excluded.related_artists,
        cover_url = COALESCE(excluded.cover_url, artist_metadata.cover_url),
        updated_at = CURRENT_TIMESTAMP
    `).run(
      key,
      spotifyId,
      deezerId,
      JSON.stringify(genres),
      category,
      JSON.stringify(relatedArtists),
      coverUrl
    );
  } catch (_) {}

  return record;
}

/**
 * Fetches top tracks for an artist via Deezer API and iTunes fallback.
 */
async function fetchArtistCandidateTracks(
  artistName: string,
  deezerId?: number | null
): Promise<SpotifyTrack[]> {
  const results: SpotifyTrack[] = [];

  try {
    let resolvedDzId = deezerId;
    if (!resolvedDzId) {
      const sRes = await fetchWithTimeout(`https://api.deezer.com/search/artist?q=${encodeURIComponent(artistName)}&limit=1`);
      if (sRes.ok) {
        const sData: any = await sRes.json();
        resolvedDzId = sData.data?.[0]?.id;
      }
    }

    if (resolvedDzId) {
      const topRes = await fetchWithTimeout(`https://api.deezer.com/artist/${resolvedDzId}/top?limit=15`);
      if (topRes.ok) {
        const topData: any = await topRes.json();
        for (const item of topData.data || []) {
          if (!item.title) continue;
          results.push({
            id: `dz_${item.id}`,
            title: item.title_short || item.title,
            artist: item.artist?.name || artistName,
            album: item.album?.title || '',
            duration_ms: (item.duration || 180) * 1000,
            cover_url: item.album?.cover_xl || item.album?.cover_big || item.album?.cover_medium || ''
          });
        }
      }
    }
  } catch (_) {}

  // Fallback to iTunes if Deezer returned few tracks
  if (results.length < 5) {
    try {
      const res = await fetchWithTimeout(
        `https://itunes.apple.com/search?term=${encodeURIComponent(artistName)}&entity=song&limit=12`
      );
      if (res.ok) {
        const data: any = await res.json();
        for (const item of data.results || []) {
          if (!item.trackName || !item.artistName) continue;
          if (extractPrimaryArtist(item.artistName).toLowerCase() !== extractPrimaryArtist(artistName).toLowerCase()) {
            continue;
          }
          results.push({
            id: `it_${item.trackId}`,
            title: item.trackName,
            artist: item.artistName,
            album: item.collectionName || '',
            duration_ms: item.trackTimeMillis || 180000,
            cover_url: (item.artworkUrl100 || '').replace('100x100bb', '600x600bb')
          });
        }
      }
    } catch (_) {}
  }

  return results;
}

/**
 * Cleans up orphan tracks on disk & DB that were only in old Daily Mixes
 * and were not liked or added to any permanent playlist.
 */
export function cleanupOrphanDailyMixTracks() {
  try {
    const orphans: any[] = db.prepare(`
      SELECT t.id, t.file_path
      FROM tracks t
      LEFT JOIN playlist_tracks pt ON pt.track_id = t.id
      LEFT JOIN liked_tracks lt ON lt.track_id = t.id
      WHERE pt.track_id IS NULL
        AND lt.track_id IS NULL
        AND t.created_at < datetime('now', '-15 minutes')
    `).all();

    for (const orphan of orphans) {
      if (orphan.file_path && fs.existsSync(orphan.file_path)) {
        try {
          fs.unlinkSync(orphan.file_path);
        } catch (_) {}
      }
      db.prepare('DELETE FROM tracks WHERE id = ?').run(orphan.id);
    }

    if (orphans.length > 0) {
      console.log(`[DailyMix Cleanup] Removed ${orphans.length} unliked orphan track(s) from old mixes.`);
    }
  } catch (err: any) {
    console.warn('[DailyMix Cleanup Warning]:', err.message);
  }
}

function getTodayDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns existing Daily Mixes for today, or generates new ones if none exist for today (or if forceRefresh = true).
 */
export async function getOrGenerateDailyMixes(userId: number, forceRefresh = false): Promise<any[]> {
  const today = getTodayDateKey();

  if (!forceRefresh) {
    const existingMixes: any[] = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) as track_count
      FROM playlists p
      WHERE p.user_id = ? AND p.is_daily_mix = 1 AND p.daily_mix_date = ?
      ORDER BY p.daily_mix_number ASC
    `).all(userId, today);

    if (existingMixes.length > 0) {
      return existingMixes.map(enrichDailyMixRow);
    }
  }

  // Prevent concurrent duplicate generation for the same user
  if (generationInProgress.has(userId)) {
    return await generationInProgress.get(userId)!;
  }

  const genPromise = generateDailyMixesInternal(userId, today);
  generationInProgress.set(userId, genPromise);
  try {
    return await genPromise;
  } finally {
    generationInProgress.delete(userId);
  }
}

function enrichDailyMixRow(row: any) {
  const cat = CATEGORY_DEFINITIONS[row.daily_mix_category] || {
    key: row.daily_mix_category || 'mix',
    title: row.name,
    badge: 'DAILY MIX',
    accentColor: 'mauve'
  };
  const activeJob = db.prepare(`
    SELECT id, status, total_tracks, downloaded_tracks, current_track
    FROM download_jobs
    WHERE playlist_id = ? AND status IN ('pending', 'downloading')
    ORDER BY created_at DESC LIMIT 1
  `).get(row.id);

  let seedArtists: string[] = [];
  try {
    seedArtists = JSON.parse(row.daily_mix_seed_artists || '[]');
  } catch (_) {}

  return {
    ...row,
    category_title: cat.title,
    category_badge: cat.badge,
    accent_color: cat.accentColor,
    seed_artists: seedArtists,
    activeJob: activeJob || null
  };
}

async function generateDailyMixesInternal(userId: number, today: string): Promise<any[]> {
  // 1. Gather all user tracks from permanent playlists and liked_tracks
  const userTracks: any[] = db.prepare(`
    SELECT DISTINCT t.id, t.title, t.artist, t.album, t.duration_ms, t.cover_url, t.spotify_id, p.id as source_playlist_id
    FROM tracks t
    LEFT JOIN playlist_tracks pt ON pt.track_id = t.id
    LEFT JOIN playlists p ON p.id = pt.playlist_id AND COALESCE(p.is_daily_mix, 0) = 0
    LEFT JOIN liked_tracks lt ON lt.track_id = t.id AND lt.user_id = ?
    WHERE p.user_id = ? OR lt.user_id = ?
  `).all(userId, userId, userId);

  if (userTracks.length === 0) {
    return [];
  }

  // 2. Load user blacklist
  const blacklistRows: any[] = db.prepare(`
    SELECT LOWER(title) as title, LOWER(artist) as artist, spotify_id
    FROM blacklist
    WHERE user_id = ?
  `).all(userId);

  const isBlacklisted = (artist: string, title: string, spId?: string) => {
    const lArtist = artist.toLowerCase().trim();
    const lPrimary = extractPrimaryArtist(artist).toLowerCase();
    const lTitle = title.toLowerCase().trim();
    return blacklistRows.some(b =>
      (spId && b.spotify_id === spId) ||
      (b.title === lTitle && (b.artist === lArtist || b.artist === lPrimary)) ||
      (b.title === '*' && (b.artist === lArtist || b.artist === lPrimary))
    );
  };

  // Build set of all tracks already owned by user (so we know what is familiar vs brand new)
  const ownedTrackKeys = new Set<string>();
  const ownedSpotifyIds = new Set<string>();
  for (const ut of userTracks) {
    ownedTrackKeys.add(normalizeTrackKey(ut.artist, ut.title));
    if (ut.spotify_id) ownedSpotifyIds.add(ut.spotify_id);
  }

  // 3. Extract unique primary artists and count their frequency
  const artistMap = new Map<string, {
    displayName: string;
    count: number;
    sampleTitle: string;
    tracks: any[];
    playlistIds: Set<number>;
  }>();

  for (const ut of userTracks) {
    if (isBlacklisted(ut.artist, ut.title, ut.spotify_id)) continue;
    const primary = extractPrimaryArtist(ut.artist);
    const key = primary.toLowerCase();
    if (!artistMap.has(key)) {
      artistMap.set(key, {
        displayName: primary,
        count: 0,
        sampleTitle: ut.title,
        tracks: [],
        playlistIds: new Set()
      });
    }
    const entry = artistMap.get(key)!;
    entry.count++;
    // Deduplicate track IDs inside artist entry
    if (!entry.tracks.some(t => t.id === ut.id)) {
      entry.tracks.push(ut);
    }
    if (ut.source_playlist_id) {
      entry.playlistIds.add(ut.source_playlist_id);
    }
  }

  // Sort artists by track count descending, take top 45 artists to classify fast
  const sortedArtists = Array.from(artistMap.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 45);

  // Resolve artist metadata in batches of 6 to avoid overwhelming external APIs
  const metadataByArtist = new Map<string, ArtistMetadataRecord>();
  const batchSize = 6;
  for (let i = 0; i < sortedArtists.length; i += batchSize) {
    const batch = sortedArtists.slice(i, i + batchSize);
    const resolved = await Promise.all(
      batch.map(([_, info]) => resolveArtistMetadata(info.displayName, info.sampleTitle))
    );
    for (const meta of resolved) {
      metadataByArtist.set(meta.artist_name, meta);
    }
  }

  // Fallback co-occurrence: if an artist has no category yet, infer from the dominant category of their playlist
  const playlistDominantCat = new Map<number, Map<string, number>>();
  for (const [artistKey, info] of sortedArtists) {
    const cat = metadataByArtist.get(artistKey)?.category;
    if (!cat) continue;
    for (const pid of info.playlistIds) {
      if (!playlistDominantCat.has(pid)) playlistDominantCat.set(pid, new Map());
      const counts = playlistDominantCat.get(pid)!;
      counts.set(cat, (counts.get(cat) || 0) + info.count);
    }
  }

  // Group artists & their user tracks into categories
  const rawClusters = new Map<string, {
    artists: { key: string; displayName: string; count: number; meta: ArtistMetadataRecord }[];
    userTracks: any[];
  }>();

  const ensureCluster = (catKey: string) => {
    if (!rawClusters.has(catKey)) {
      rawClusters.set(catKey, { artists: [], userTracks: [] });
    }
    return rawClusters.get(catKey)!;
  };

  for (const [artistKey, info] of sortedArtists) {
    const meta = metadataByArtist.get(artistKey);
    let cat = meta?.category || null;

    if (!cat) {
      // Try playlist co-occurrence
      for (const pid of info.playlistIds) {
        const counts = playlistDominantCat.get(pid);
        if (counts && counts.size > 0) {
          cat = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
          break;
        }
      }
    }

    if (!cat) {
      cat = hasCyrillic(info.displayName) ? 'hiphop_ru' : 'pop';
    }

    const cluster = ensureCluster(cat);
    cluster.artists.push({
      key: artistKey,
      displayName: info.displayName,
      count: info.count,
      meta: meta || {
        artist_name: artistKey,
        spotify_id: null,
        deezer_id: null,
        genres: [],
        category: cat,
        related_artists: [],
        cover_url: null
      }
    });

    for (const t of info.tracks) {
      if (!cluster.userTracks.some(existing => existing.id === t.id)) {
        cluster.userTracks.push(t);
      }
    }
  }

  // Smart consolidation of closely-related sub-categories if one sub-branch has too few tracks (< 3)
  const mergeClusterInto = (fromKey: string, intoKey: string) => {
    const fromC = rawClusters.get(fromKey);
    if (!fromC) return;
    const intoC = ensureCluster(intoKey);
    intoC.artists.push(...fromC.artists);
    for (const t of fromC.userTracks) {
      if (!intoC.userTracks.some(e => e.id === t.id)) intoC.userTracks.push(t);
    }
    rawClusters.delete(fromKey);
  };

  if (rawClusters.has('phonk') && rawClusters.get('phonk')!.userTracks.length < 3 && rawClusters.has('electronic')) {
    mergeClusterInto('phonk', 'electronic');
  } else if (rawClusters.has('electronic') && rawClusters.get('electronic')!.userTracks.length < 3 && rawClusters.has('phonk')) {
    mergeClusterInto('electronic', 'phonk');
  }

  if (rawClusters.has('hiphop_ru') && rawClusters.get('hiphop_ru')!.userTracks.length < 3 && rawClusters.has('hiphop_intl')) {
    mergeClusterInto('hiphop_ru', 'hiphop_intl');
  } else if (rawClusters.has('hiphop_intl') && rawClusters.get('hiphop_intl')!.userTracks.length < 3 && rawClusters.has('hiphop_ru')) {
    mergeClusterInto('hiphop_intl', 'hiphop_ru');
  }

  // Filter clusters that have enough material (at least 2 tracks or the largest cluster if library is tiny)
  let validClusters = Array.from(rawClusters.entries())
    .filter(([_, c]) => c.userTracks.length >= 2)
    .sort((a, b) => b[1].userTracks.length - a[1].userTracks.length)
    .slice(0, 6);

  if (validClusters.length === 0 && rawClusters.size > 0) {
    validClusters = [Array.from(rawClusters.entries())[0]];
  }

  // Remove old Daily Mixes for this user before creating new ones
  const oldMixes: any[] = db.prepare(`
    SELECT id FROM playlists WHERE user_id = ? AND is_daily_mix = 1
  `).all(userId);

  if (oldMixes.length > 0) {
    const oldIds = oldMixes.map(m => m.id);
    cancelPlaylistDownloads(oldIds);
    for (const oldId of oldIds) {
      db.prepare('DELETE FROM playlists WHERE id = ?').run(oldId);
    }
    cleanupOrphanDailyMixTracks();
  }

  const createdMixes: any[] = [];
  const TARGET_MIX_SIZE = 25;
  const TARGET_FAMILIAR_COUNT = 5; // 20% familiar tracks from user's playlists in this category
  const TARGET_NEW_COUNT = TARGET_MIX_SIZE - TARGET_FAMILIAR_COUNT; // 80% brand new tracks

  for (let idx = 0; idx < validClusters.length; idx++) {
    const [catKey, cluster] = validClusters[idx];
    const mixNumber = idx + 1;
    const catDef = CATEGORY_DEFINITIONS[catKey] || {
      key: catKey,
      title: 'Разное',
      badge: 'DAILY MIX',
      accentColor: 'mauve',
      keywords: []
    };

    // 1. Pick 15-20% (up to 5) familiar tracks from user's library in this category
    const shuffledUserTracks = [...cluster.userTracks].sort(() => Math.random() - 0.5);
    const familiarTracks: any[] = [];
    const familiarArtistsUsed = new Set<string>();

    for (const ut of shuffledUserTracks) {
      if (familiarTracks.length >= TARGET_FAMILIAR_COUNT) break;
      const pArtist = extractPrimaryArtist(ut.artist).toLowerCase();
      if (!familiarArtistsUsed.has(pArtist)) {
        familiarTracks.push(ut);
        familiarArtistsUsed.add(pArtist);
      }
    }
    // If fewer unique artists than TARGET_FAMILIAR_COUNT, fill up to min(TARGET_FAMILIAR_COUNT, 20% of mix)
    for (const ut of shuffledUserTracks) {
      if (familiarTracks.length >= Math.min(TARGET_FAMILIAR_COUNT, Math.ceil(cluster.userTracks.length * 0.5))) break;
      if (!familiarTracks.some(f => f.id === ut.id)) {
        familiarTracks.push(ut);
      }
    }

    // 2. Discover 80-85% NEW tracks strictly in this category
    const newCandidates: SpotifyTrack[] = [];
    const usedTrackKeys = new Set<string>(ownedTrackKeys);
    const artistCountInMix = new Map<string, number>();

    for (const ft of familiarTracks) {
      const pa = extractPrimaryArtist(ft.artist).toLowerCase();
      artistCountInMix.set(pa, (artistCountInMix.get(pa) || 0) + 1);
    }

    const canAddCandidate = (cand: SpotifyTrack): boolean => {
      if (!cand.title || !cand.artist) return false;
      const tKey = normalizeTrackKey(cand.artist, cand.title);
      if (usedTrackKeys.has(tKey)) return false;
      if (cand.id && ownedSpotifyIds.has(cand.id)) return false;
      if (isBlacklisted(cand.artist, cand.title, cand.id)) return false;
      const pa = extractPrimaryArtist(cand.artist).toLowerCase();
      if ((artistCountInMix.get(pa) || 0) >= 2) return false;
      return true;
    };

    const addCandidate = (cand: SpotifyTrack) => {
      const tKey = normalizeTrackKey(cand.artist, cand.title);
      usedTrackKeys.add(tKey);
      const pa = extractPrimaryArtist(cand.artist).toLowerCase();
      artistCountInMix.set(pa, (artistCountInMix.get(pa) || 0) + 1);
      newCandidates.push(cand);
    };

    // Part A: Unheard tracks from user's seed artists in this category
    const seedArtistsPool = [...cluster.artists]
      .sort((a, b) => (b.count + Math.random() * 2) - (a.count + Math.random() * 2))
      .slice(0, 8);

    const seedTrackLists = await Promise.all(
      seedArtistsPool.map(sa => fetchArtistCandidateTracks(sa.displayName, sa.meta.deezer_id))
    );

    for (const trackList of seedTrackLists) {
      let addedForThisSeed = 0;
      for (const cand of trackList) {
        if (newCandidates.length >= Math.ceil(TARGET_NEW_COUNT * 0.45)) break;
        if (addedForThisSeed >= 2) break;
        if (canAddCandidate(cand)) {
          addCandidate(cand);
          addedForThisSeed++;
        }
      }
    }

    // Part B: Tracks from Related / Similar Artists strictly matching this category
    const relatedPool: { name: string; deezer_id?: number; cover_url?: string }[] = [];
    const seenRelated = new Set<string>(cluster.artists.map(a => a.key));

    for (const sa of seedArtistsPool) {
      for (const rel of sa.meta.related_artists || []) {
        const rKey = rel.name.toLowerCase().trim();
        if (!seenRelated.has(rKey)) {
          seenRelated.add(rKey);
          relatedPool.push(rel);
        }
      }
    }

    const shuffledRelated = relatedPool.sort(() => Math.random() - 0.5).slice(0, 18);

    for (let rIdx = 0; rIdx < shuffledRelated.length; rIdx += 5) {
      if (newCandidates.length >= TARGET_NEW_COUNT) break;
      const rBatch = shuffledRelated.slice(rIdx, rIdx + 5);

      const batchResults = await Promise.all(
        rBatch.map(async (rel) => {
          const relMeta = await resolveArtistMetadata(rel.name);
          const relCat = relMeta.category;
          // Strict category compatibility check so unrelated genres never mix
          const isSameCategory =
            relCat === catKey ||
            (!relCat && (catKey !== 'hiphop_ru' || hasCyrillic(rel.name))) ||
            (catKey === 'hiphop_ru' && relCat === 'hiphop_intl' && hasCyrillic(rel.name));

          if (!isSameCategory) return [];
          return await fetchArtistCandidateTracks(rel.name, rel.deezer_id || relMeta.deezer_id);
        })
      );

      for (const trackList of batchResults) {
        let addedForRel = 0;
        for (const cand of trackList) {
          if (newCandidates.length >= TARGET_NEW_COUNT) break;
          if (addedForRel >= 2) break;
          if (canAddCandidate(cand)) {
            addCandidate(cand);
            addedForRel++;
          }
        }
      }
    }

    // If still below TARGET_NEW_COUNT, allow more unheard tracks from seed artists
    if (newCandidates.length < TARGET_NEW_COUNT) {
      for (const trackList of seedTrackLists) {
        for (const cand of trackList) {
          if (newCandidates.length >= TARGET_NEW_COUNT) break;
          if (canAddCandidate(cand)) {
            addCandidate(cand);
          }
        }
      }
    }

    // 3. Interleave Familiar Tracks (15-20%) and New Tracks (80-85%)
    // Place familiar tracks at positions 0, 5, 10, 15, 20 so playback starts instantly
    const finalMixItems: { type: 'familiar' | 'new'; track: any; position: number }[] = [];
    let famIdx = 0;
    let newIdx = 0;
    const totalCount = familiarTracks.length + newCandidates.length;

    for (let pos = 0; pos < totalCount; pos++) {
      const shouldPlaceFamiliar =
        (pos % 5 === 0 && famIdx < familiarTracks.length) ||
        newIdx >= newCandidates.length;

      if (shouldPlaceFamiliar && famIdx < familiarTracks.length) {
        finalMixItems.push({ type: 'familiar', track: familiarTracks[famIdx++], position: pos });
      } else if (newIdx < newCandidates.length) {
        finalMixItems.push({ type: 'new', track: newCandidates[newIdx++], position: pos });
      }
    }

    const seedNames = seedArtistsPool.slice(0, 4).map(a => a.displayName);
    const mixName = `Микс дня #${mixNumber} • ${catDef.title}`;
    const mixDesc = `${catDef.title} • На основе ${seedNames.join(', ')} и новых исполнителей`;
    const mixCover =
      seedArtistsPool.find(a => a.meta.cover_url)?.meta.cover_url ||
      familiarTracks.find(t => t.cover_url)?.cover_url ||
      newCandidates.find(t => t.cover_url)?.cover_url ||
      '';

    const tracksToDownload: SpotifyTrack[] = finalMixItems
      .filter(item => item.type === 'new')
      .map(item => ({
        ...item.track,
        position: item.position
      }));

    // Create Daily Mix playlist row
    const insertRes = db.prepare(`
      INSERT INTO playlists (
        user_id, name, description, cover_url,
        is_daily_mix, daily_mix_category, daily_mix_number,
        daily_mix_date, daily_mix_seed_artists, daily_mix_tracks_json
      )
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      userId,
      mixName,
      mixDesc,
      mixCover,
      catKey,
      mixNumber,
      today,
      JSON.stringify(seedNames),
      JSON.stringify(tracksToDownload)
    );

    const mixPlaylistId = Number(insertRes.lastInsertRowid);

    // Immediately insert the 15-20% familiar tracks into playlist_tracks
    const insertPt = db.prepare(`
      INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
      VALUES (?, ?, ?)
    `);
    for (const item of finalMixItems) {
      if (item.type === 'familiar') {
        insertPt.run(mixPlaylistId, item.track.id, item.position);
      }
    }

    // Queue full background pre-download for all new tracks in the Daily Mix
    if (tracksToDownload.length > 0) {
      const jobId = `dm_${mixPlaylistId}_${Date.now().toString(36)}`;
      db.prepare(`
        INSERT INTO download_jobs (id, user_id, playlist_id, playlist_name, total_tracks, downloaded_tracks, status)
        VALUES (?, ?, ?, ?, ?, ?, 'downloading')
      `).run(
        jobId,
        userId,
        mixPlaylistId,
        mixName,
        finalMixItems.length,
        familiarTracks.length
      );

      enqueuePlaylistDownload(jobId, userId, mixPlaylistId, tracksToDownload);
    }

    const createdRow = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) as track_count
      FROM playlists p
      WHERE p.id = ?
    `).get(mixPlaylistId);

    if (createdRow) {
      createdMixes.push(enrichDailyMixRow(createdRow));
    }
  }

  return createdMixes;
}

/**
 * Clones a Daily Mix into a permanent user playlist.
 */
export function saveDailyMixAsPlaylist(userId: number, mixPlaylistId: number): { id: number; name: string } {
  const mix: any = db.prepare(`
    SELECT * FROM playlists WHERE id = ? AND user_id = ? AND is_daily_mix = 1
  `).get(mixPlaylistId, userId);

  if (!mix) {
    throw new Error('Плейлист дня не найден');
  }

  const dateLabel = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  const newName = `${mix.name} (${dateLabel})`;

  const info = db.prepare(`
    INSERT INTO playlists (user_id, name, description, cover_url, is_daily_mix)
    VALUES (?, ?, ?, ?, 0)
  `).run(userId, newName, mix.description, mix.cover_url || '');

  const newPlaylistId = Number(info.lastInsertRowid);

  const tracks: any[] = db.prepare(`
    SELECT track_id, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC
  `).all(mixPlaylistId);

  const insertPt = db.prepare(`
    INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
    VALUES (?, ?, ?)
  `);
  for (const t of tracks) {
    insertPt.run(newPlaylistId, t.track_id, t.position);
  }

  return { id: newPlaylistId, name: newName };
}
