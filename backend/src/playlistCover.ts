import fs from 'fs';
import path from 'path';

export interface GenreCoverRule {
  id: string;
  name: string;
  keywords: string[];
  coverUrl: string;
  gradient: [string, string];
}

export const GENRE_COVER_RULES: GenreCoverRule[] = [
  {
    id: 'rock',
    name: 'Rock',
    keywords: [
      'rock', 'рок', 'punk', 'панк', 'grunge', 'гранж', 'hard rock', 'хард рок',
      'metalcore', 'post-hardcore', 'post hardcore', 'пост хардкор', 'heavy rock',
      'indie rock', 'инди рок', 'alt rock', 'альтернативный рок'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/misc/b36ca681666d617edd0dcb5ab389a6ac/1000x1000-000000-80-0-0.jpg',
    gradient: ['#1e1e2e', '#e06c75']
  },
  {
    id: 'pop',
    name: 'Pop',
    keywords: [
      'pop', 'поп', 'попса', 'k-pop', 'kpop', 'j-pop', 'jpop', 'dance pop',
      'synthpop', 'синтпоп', 'хиты', 'top hits', 'chart', 'чарт', 'billboard'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/misc/db7a604d9e7634a67d45cfc86b48370a/1000x1000-000000-80-0-0.jpg',
    gradient: ['#f5c2e7', '#cba6f7']
  },
  {
    id: 'rap',
    name: 'Rap',
    keywords: [
      'rap', 'рэп', 'хип-хоп', 'хип хоп', 'hip-hop', 'hip hop', 'hiphop', 'trap',
      'трэп', 'drill', 'дрил', 'дрифт', 'cloud rap', 'underground rap', 'gangsta rap', 'boom bap'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/misc/5c27115d3b797954afff59199dad98d1/1000x1000-000000-80-0-0.jpg',
    gradient: ['#181825', '#fab387']
  },
  {
    id: 'funk',
    name: 'Funk & Soul',
    keywords: [
      'funk', 'фанк', 'soul', 'соул', 'disco', 'диско', 'groove', 'грув',
      'motown', 'boogie', 'буги', 'funk soul'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/misc/3d5e8aab99b95bfa7ac7e9e466e7781e/1000x1000-000000-80-0-0.jpg',
    gradient: ['#f9e2af', '#fab387']
  },
  {
    id: 'metal',
    name: 'Metal',
    keywords: [
      'metal', 'метал', 'металл', 'heavy metal', 'хеви метал', 'death metal',
      'black metal', 'thrash', 'doom', 'nu metal', 'ню метал'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/misc/f14f9fde9feb38ca6d61960f00681860/1000x1000-000000-80-0-0.jpg',
    gradient: ['#11111b', '#f38ba8']
  },
  {
    id: 'electronic',
    name: 'Electronic',
    keywords: [
      'electronic', 'electro', 'электро', 'электроника', 'edm', 'techno', 'техно',
      'house', 'хаус', 'trance', 'транс', 'dnb', 'drum and bass', 'drum & bass',
      'днб', 'dubstep', 'дабстеп', 'rave', 'рейв'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/misc/bd5fdfa1a23e02e2697818e09e008e69/1000x1000-000000-80-0-0.jpg',
    gradient: ['#89dceb', '#74c7ec']
  },
  {
    id: 'jazz',
    name: 'Jazz',
    keywords: [
      'jazz', 'джаз', 'smooth jazz', 'bebop', 'бибоп', 'swing', 'свинг', 'big band', 'биг бэнд'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/misc/91468ecc5dfdd19c42a43d2cbdf27059/1000x1000-000000-80-0-0.jpg',
    gradient: ['#313244', '#f9e2af']
  },
  {
    id: 'classical',
    name: 'Classical',
    keywords: [
      'classical', 'классика', 'classic', 'orchestra', 'оркестр', 'piano', 'пианино',
      'фортепиано', 'symphony', 'симфония', 'bach', 'mozart', 'chopin', 'beethoven',
      'instrumental', 'инструментал'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/misc/609f69b669b242252aa8ee09b5597655/1000x1000-000000-80-0-0.jpg',
    gradient: ['#1e1e2e', '#cba6f7']
  },
  {
    id: 'phonk',
    name: 'Phonk',
    keywords: [
      'phonk', 'фонк', 'drift phonk', 'дрифт фонк', 'brazilian phonk'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/playlist/fb04bb66724612116cf2a18125b5d580/1000x1000-000000-80-0-0.jpg',
    gradient: ['#11111b', '#a6e3a1']
  },
  {
    id: 'synthwave',
    name: 'Synthwave',
    keywords: [
      'synthwave', 'retrowave', 'синтвейв', 'ретровейв', 'vaporwave', 'вайпорвейв',
      '80s', '80-е', 'восьмидесятые', 'cyberpunk', 'киберпанк'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/playlist/563cef05ec841602ed8a01ff69fb823c/1000x1000-000000-80-0-0.jpg',
    gradient: ['#f5c2e7', '#89dceb']
  },
  {
    id: 'workout',
    name: 'Workout',
    keywords: [
      'workout', 'gym', 'sport', 'спорт', 'тренировка', 'качалка', 'зал',
      'fitness', 'фитнес', 'power', 'motivation', 'мотивация', 'pump'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/playlist/372ba00f73c683b798725832a829ba87/1000x1000-000000-80-0-0.jpg',
    gradient: ['#f38ba8', '#fab387']
  },
  {
    id: 'chill',
    name: 'Chill & Lo-Fi',
    keywords: [
      'chill', 'relax', 'lofi', 'lo-fi', 'лоуфай', 'отдых', 'релакс', 'calm',
      'спокойствие', 'sleep', 'сон', 'meditation', 'медитация', 'study', 'учеба', 'vibe', 'chillout'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/playlist/075482705e468e64c20fc456108170c8/1000x1000-000000-80-0-0.jpg',
    gradient: ['#94e2d5', '#b4befe']
  },
  {
    id: 'gaming',
    name: 'Gaming & OST',
    keywords: [
      'gaming', 'game', 'games', 'игры', 'гейминг', 'ost', 'soundtrack', 'саундтрек', 'anime', 'аниме'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/misc/236d8057751d9c557728400dfe71483a/1000x1000-000000-80-0-0.jpg',
    gradient: ['#89b4fa', '#cba6f7']
  },
  {
    id: 'blues',
    name: 'Blues',
    keywords: [
      'blues', 'блюз'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/misc/1abb6810098d4015bdc860c91bcfd2b6/1000x1000-000000-80-0-0.jpg',
    gradient: ['#1e1e2e', '#89b4fa']
  },
  {
    id: 'alternative',
    name: 'Indie & Alt',
    keywords: [
      'indie', 'инди', 'alt', 'alternative', 'альтернатива', 'shoegaze', 'шугейз',
      'post-punk', 'постпанк', 'пост-панк'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/misc/fd252ab727d9a3b0b3c29014873f8f57/1000x1000-000000-80-0-0.jpg',
    gradient: ['#313244', '#eba0ac']
  },
  {
    id: 'folk',
    name: 'Folk & Acoustic',
    keywords: [
      'folk', 'фолк', 'acoustic', 'акустика', 'country', 'кантри', 'барды'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/misc/f9e070848998df8870ba65cd0d22b2b3/1000x1000-000000-80-0-0.jpg',
    gradient: ['#f9e2af', '#a6adc8']
  },
  {
    id: 'reggae',
    name: 'Reggae',
    keywords: [
      'reggae', 'регги', 'dub', 'ska', 'ска'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/misc/7b901a98628cf879e1465f1dfd697e00/1000x1000-000000-80-0-0.jpg',
    gradient: ['#a6e3a1', '#f9e2af']
  },
  {
    id: 'party',
    name: 'Party',
    keywords: [
      'party', 'вечеринка', 'тусовка', 'вписка', 'танцы', 'club'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/playlist/46a81b376b3cf9e6cf2c2a0d1b5ea3c7/1000x1000-000000-80-0-0.jpg',
    gradient: ['#f5c2e7', '#fab387']
  },
  {
    id: 'car',
    name: 'Drive & Road',
    keywords: [
      'car', 'drive', 'машина', 'авто', 'в дорогу', 'дорога', 'road trip', 'highway', 'за рулем'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/playlist/3da40989f5c4ce126ecba2aa5bfabfa4/1000x1000-000000-80-0-0.jpg',
    gradient: ['#1e1e2e', '#89dceb']
  },
  {
    id: 'romantic',
    name: 'Love & Romance',
    keywords: [
      'love', 'любовь', 'romantic', 'романтика', 'свидание'
    ],
    coverUrl: 'https://cdn-images.dzcdn.net/images/playlist/cbeaf7c3feef014dd5df4f808be5e386/1000x1000-000000-80-0-0.jpg',
    gradient: ['#f38ba8', '#f5c2e7']
  }
];

const DEFAULT_COVER_URL = 'https://cdn-images.dzcdn.net/images/misc/bd5fdfa1a23e02e2697818e09e008e69/1000x1000-000000-80-0-0.jpg';

/**
 * Normalizes input text and detects the best matching GenreCoverRule.
 */
export function detectGenreCoverRule(name: string, description?: string): GenreCoverRule | null {
  const rawText = `${name || ''} ${description || ''}`.toLowerCase().trim();
  if (!rawText) return null;

  const cleanName = (name || '').toLowerCase().trim();

  // Priority 1: Exact match with clean name
  for (const rule of GENRE_COVER_RULES) {
    if (rule.keywords.some(k => k === cleanName)) {
      return rule;
    }
  }

  // Priority 2: Word boundary matching
  for (const rule of GENRE_COVER_RULES) {
    for (const kw of rule.keywords) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?:^|[\\s_.,!?:;/'"()-])${escaped}(?:$|[\\s_.,!?:;/'"()-])`, 'i');
      if (pattern.test(rawText)) {
        return rule;
      }
    }
  }

  return null;
}

/**
 * Searches Deezer public API for a playlist cover matching query text.
 */
export async function searchDeezerPlaylistCover(query: string): Promise<string | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const url = `https://api.deezer.com/search/playlist?q=${encodeURIComponent(trimmed)}&limit=1`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (resp.ok) {
      const data: any = await resp.json();
      if (data && Array.isArray(data.data) && data.data.length > 0) {
        const item = data.data[0];
        const cover = item.picture_xl || item.picture_big || item.picture_medium || null;
        if (cover && typeof cover === 'string' && cover.startsWith('http')) {
          return cover;
        }
      }
    }
  } catch (err: any) {
    console.warn(`[PlaylistCover] Deezer search failed for "${query}":`, err.message);
  }

  return null;
}

/**
 * Generates an SVG placeholder cover for offline fallback.
 */
export function generateSvgCover(name: string, color1 = '#313244', color2 = '#cba6f7'): string {
  const safeName = (name || 'Playlist')
    .slice(0, 24)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" width="100%" height="100%">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${color1}"/>
      <stop offset="100%" stop-color="${color2}"/>
    </linearGradient>
    <radialGradient id="glowGrad" cx="50%" cy="40%" r="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="500" height="500" fill="url(#bgGrad)" />
  <circle cx="250" cy="200" r="220" fill="url(#glowGrad)" />

  <!-- Stylized vinyl circles -->
  <g opacity="0.12" stroke="#ffffff" stroke-width="2" fill="none">
    <circle cx="250" cy="220" r="140" />
    <circle cx="250" cy="220" r="110" />
    <circle cx="250" cy="220" r="80" />
    <circle cx="250" cy="220" r="50" />
  </g>

  <!-- Central Music Icon -->
  <g transform="translate(210, 180) scale(1.6)" fill="#ffffff" opacity="0.95">
    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
  </g>

  <!-- Title Badge -->
  <rect x="40" y="380" width="420" height="70" rx="16" fill="#11111b" opacity="0.6" />
  <text x="250" y="426" 
        font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" 
        font-size="24" 
        font-weight="700" 
        fill="#cdd6f4" 
        text-anchor="middle"
        letter-spacing="0.5">${safeName}</text>
</svg>`;
}

/**
 * Downloads a remote image and saves it to data/covers/playlist_${playlistId}.jpg.
 * Returns local API URL on success, or fallback remote URL if download fails.
 */
export async function downloadAndSaveCoverLocally(playlistId: number, imageUrl: string): Promise<string> {
  const coversDir = path.join(process.cwd(), 'data', 'covers');
  if (!fs.existsSync(coversDir)) {
    fs.mkdirSync(coversDir, { recursive: true });
  }

  const filePath = path.join(coversDir, `playlist_${playlistId}.jpg`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const resp = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (resp.ok) {
      const arrayBuffer = await resp.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length > 500) {
        await fs.promises.writeFile(filePath, buffer);
        return `/api/playlists/${playlistId}/cover?t=${Date.now()}`;
      }
    }
  } catch (err: any) {
    console.warn(`[PlaylistCover] Failed to save image locally for playlist ${playlistId}:`, err.message);
  }

  return imageUrl;
}

/**
 * Resolves a cover for a playlist (by genre rule, Deezer search, or offline SVG)
 * and saves it locally. Returns the final URL (/api/playlists/:id/cover?... or remote CDN).
 */
export async function resolveAndSavePlaylistCover(
  playlistId: number,
  name: string,
  description?: string
): Promise<string> {
  const matchedRule = detectGenreCoverRule(name, description);

  let targetImageUrl: string | null = matchedRule ? matchedRule.coverUrl : null;

  if (!targetImageUrl) {
    // If not matched by static genre dictionary, search Deezer
    targetImageUrl = await searchDeezerPlaylistCover(name);
  }

  if (targetImageUrl) {
    // Attempt to download and save locally
    const savedUrl = await downloadAndSaveCoverLocally(playlistId, targetImageUrl);
    return savedUrl;
  }

  // Offline or nothing found: generate an SVG fallback
  const coversDir = path.join(process.cwd(), 'data', 'covers');
  if (!fs.existsSync(coversDir)) {
    fs.mkdirSync(coversDir, { recursive: true });
  }

  const gradient = matchedRule ? matchedRule.gradient : ['#1e1e2e', '#cba6f7'];
  const svgContent = generateSvgCover(name, gradient[0], gradient[1]);
  const svgPath = path.join(coversDir, `playlist_${playlistId}.svg`);

  try {
    await fs.promises.writeFile(svgPath, svgContent, 'utf8');
    return `/api/playlists/${playlistId}/cover?t=${Date.now()}`;
  } catch (e: any) {
    console.error(`[PlaylistCover] Failed to write SVG fallback for playlist ${playlistId}:`, e.message);
    return DEFAULT_COVER_URL;
  }
}

/**
 * Asynchronously backfills missing covers for all playlists in the database.
 */
export function initPlaylistCoversBackfill(db: any): void {
  try {
    const rows = db.prepare(`
      SELECT id, name, description 
      FROM playlists 
      WHERE cover_url IS NULL OR cover_url = '' OR cover_url = '-'
    `).all() as Array<{ id: number; name: string; description?: string }>;

    if (!rows || rows.length === 0) return;

    console.log(`[PlaylistCover] Found ${rows.length} playlist(s) without covers. Starting background backfill...`);

    // Run in background without blocking startup
    (async () => {
      for (const pl of rows) {
        try {
          const coverUrl = await resolveAndSavePlaylistCover(pl.id, pl.name, pl.description);
          if (coverUrl) {
            db.prepare('UPDATE playlists SET cover_url = ? WHERE id = ?').run(coverUrl, pl.id);
            console.log(`[PlaylistCover] Auto-assigned cover for "${pl.name}" (id: ${pl.id}) -> ${coverUrl}`);
          }
        } catch (e: any) {
          console.warn(`[PlaylistCover] Failed to backfill cover for "${pl.name}":`, e.message);
        }
      }
    })().catch(err => {
      console.error('[PlaylistCover] Backfill loop error:', err);
    });
  } catch (err: any) {
    console.warn('[PlaylistCover] Backfill check error:', err.message);
  }
}
