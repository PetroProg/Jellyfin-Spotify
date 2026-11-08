import fs from 'fs';
import { db } from './db';
import { SpotifyTrack, getSpotifyCredentials, getAccessToken } from './spotify';
import { enqueuePlaylistDownload, cancelPlaylistDownloads, isTrackBlacklistedForUser, isPathInsideMusicDir } from './downloader';

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
      'chill phonk', 'wave', 'hardwave', 'memphis', 'cowbell', 'фонк', 'jumpstyle'
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
  rock: {
    key: 'rock',
    title: 'Рок и Альтернатива',
    badge: 'MODERN ROCK & METAL',
    accentColor: 'red',
    keywords: [
      'alternative metal', 'nu metal', 'metalcore', 'deathcore', 'post-hardcore',
      'post-grunge', 'modern rock', 'electronic rock', 'hard rock', 'heavy metal',
      'alternative rock', 'alt-rock', 'pop punk', 'emo', 'industrial metal',
      'symphonic metal', 'rap metal', 'rap rock', 'grunge', 'punk', 'post-punk',
      'индастриал', 'металкор', 'пост-гранж', 'альтернативный рок', 'альт-метал'
    ]
  },
  classic_rock: {
    key: 'classic_rock',
    title: 'Классический Рок',
    badge: 'CLASSIC ROCK',
    accentColor: 'peach',
    keywords: [
      'classic rock', 'arena rock', 'album rock', 'soft rock', 'glam metal',
      'southern rock', 'heartland rock', 'yacht rock', 'psychedelic rock',
      'progressive rock', 'blues rock', 'folk rock', 'art rock', 'roots rock',
      'rock & roll', 'rockabilly', 'british invasion', 'классический рок', 'русский рок'
    ]
  },
  hiphop_ru: {
    key: 'hiphop_ru',
    title: 'Русский Рэп и Хип-Хоп',
    badge: 'RU RAP & HIP-HOP',
    accentColor: 'peach',
    keywords: [
      'russian hip hop', 'russian rap', 'russian trap', 'russian drill',
      'russian plugg', 'ukrainian hip hop', 'kazakh hip hop',
      'русский рэп', 'русский хип-хоп', 'русский трэп', 'каспийский'
    ]
  },
  hiphop_intl: {
    key: 'hiphop_intl',
    title: 'Зарубежный Хип-Хоп',
    badge: 'HIP-HOP & TRAP',
    accentColor: 'mauve',
    keywords: [
      'hip hop', 'hip-hop', 'hip-hop/rap', 'rap', 'trap', 'drill', 'grime', 'boom bap',
      'cloud rap', 'rage', 'melodic rap', 'atl hip hop', 'chicago rap',
      'gangsta rap', 'west coast rap', 'east coast hip hop', 'southern hip hop',
      'underground hip hop', 'dirty south', 'рэп', 'хип-хоп', 'трэп'
    ]
  },
  pop: {
    key: 'pop',
    title: 'Поп и Ретро',
    badge: 'POP & RETRO',
    accentColor: 'pink',
    keywords: [
      'pop', 'dance pop', 'synth-pop', 'synthpop', 'electropop', 'teen pop', 'k-pop',
      'j-pop', 'europop', 'estrada', 'r&b', 'rnb', 'r&b/soul', 'soul', 'neo soul',
      'funk', 'disco', 'contemporary r&b', 'art pop', 'latin pop',
      'new wave', 'new romantic', '80s', 'russian pop', 'поп', 'соул'
    ]
  },
  chill: {
    key: 'chill',
    title: 'Инди и Lo-Fi',
    badge: 'INDIE & CHILL',
    accentColor: 'teal',
    keywords: [
      'lo-fi', 'lofi', 'chill', 'ambient', 'acoustic', 'folk',
      'singer-songwriter', 'downtempo', 'trip hop', 'dream pop',
      'bedroom pop', 'neoclassical', 'piano', 'инди', 'чилл'
    ]
  }
};

/**
 * Curated anchor sets to disambiguate Modern Rock / Alt-Metal / Metalcore vs Classic / Arena / Soft Rock
 * when external APIs return generic tags like "Rock" or "Hard Rock".
 */
const MODERN_ROCK_ANCHORS = new Set<string>([
  'starset', 'skillet', 'bad omens', 'bring me the horizon', 'motionless in white',
  'asking alexandria', 'thousand foot krutch', 'three days grace', 'breaking benjamin',
  'red', 'until i wake', 'the veer union', 'project vela', 'solence', 'caskets',
  'our last night', 'falling in reverse', 'i prevail', 'papa roach', 'shinedown',
  'from ashes to new', 'smash into pieces', 'citizen soldier', 'onlap', 'fame on fire',
  'written by wolves', 'the plot in you', 'the word alive', 'memphis may fire',
  'escape the fate', 'black veil brides', 'we came as romans', 'beartooth',
  'a day to remember', 'architects', 'sleep token', 'spiritbox', 'dayseeker',
  'imminence', 'catch your breath', 'point north', 'rain city drive', 'normandie',
  'hands like houses', '10 years', 'evans blue', 'my darkest days', 'theory of a deadman',
  'seether', 'staind', 'disturbed', 'godsmack', 'five finger death punch',
  'avenged sevenfold', 'bullet for my valentine', 'trivium', 'slipknot', 'korn',
  'system of a down', 'deftones', 'linkin park', 'evanescence', 'halestorm',
  'the pretty reckless', 'amaranthe', 'within temptation', 'nightwish', 'renegade five',
  'silent theory', 'ashes remain', 'manafest', 'dangerkids', 'hollywood undead',
  'cult to follow', 'blacklite district', 'throw the fight', 'villain of the story',
  'like a storm', 'nothing more', 'palisades', 'too close to touch', 'crown the empire',
  'wage war', 'fit for a king', 'ice nine kills', 'pierce the veil', 'sleeping with sirens',
  'all time low', 'fall out boy', 'panic! at the disco', 'my chemical romance',
  'paramore', 'sum 41', 'the offspring', 'rise against', 'billy talent', 'silverstein',
  'underneath', 'blessthefall', 'of mice & men', 'atreyu', 'killswitch engage',
  'parkway drive', 'while she sleeps', 'bury tomorrow', 'polaris', 'currents',
  'erra', 'northlane', 'landmvrks', 'wage war', 'zero 9:36', 'poorstacy',
  'grandson', ' Barns Courtney', 'royal blood', 'highly suspect', 'cleopatrick',
  'badflower', 'dead poet society', 'yonaka', 'pvrIS', 'new years day', 'in this moment',
  'lacuna coil', 'epica', 'delain', 'beast in black', 'battle beast', 'sabaton',
  'powerwolf', 'alestorm', 'wind rose', 'daughtry', 'nickelback', 'hinder',
  'default', 'saliva', 'trapt', 'puddle of mudd', 'chevelle', 'flyleaf',
  'sick puppies', 'adelitas way', 'pop evil', 'devour the day', 'saint asonia',
  'starbenders', 'self deception', 'dead by april', 'amaranthe', 'smash into pieces'
].map(s => s.toLowerCase().trim()));

const CLASSIC_ROCK_ANCHORS = new Set<string>([
  'scorpions', 'foreigner', 'bon jovi', 'aerosmith', 'bryan adams', 'journey',
  'deep purple', 'the rolling stones', 'the beatles', 'the animals', 'kiss',
  'kansas', 'the police', 'guns n\' roses', 'guns n roses', 'ac/dc', 'queen',
  'def leppard', 'whitesnake', 'van halen', 'toto', 'reo speedwagon', 'europe',
  'rod stewart', 'elton john', 'styx', 'asia', 'pat benatar', 'alice cooper',
  'metallica', 'led zeppelin', 'pink floyd', 'black sabbath', 'iron maiden',
  'judas priest', 'mötley crüe', 'motley crue', 'poison', 'skid row',
  'twisted sister', 'zz top', 'creedence clearwater revival', 'dire straits',
  'eagles', 'fleetwood mac', 'heart', 'boston', 'chicago', 'supertramp',
  'genesis', 'phil collins', 'billy idol', 'billy joel', 'bruce springsteen',
  'tom petty', 'u2', 'r.e.m.', 'oasis', 'blur', 'the verve', 'the cranberries',
  'roxette', 'richard marx', 'bonnie tyler', 'chris rea', 'status quo',
  'rainbow', 'uriah heep', 'nazareth', 'golden earring', 'slade', 'sweet',
  'smokie', 'shocking blue', 'the mamas & the papas', 'steppenwolf', 'the doors',
  'jimi hendrix', 'cream', 'eric clapton', 'santana', 'lynyrd skynyrd',
  'blue öyster cult', 'cheap trick', 'joan jett', 'blondie', 'talking heads',
  'the cure', 'depeche mode', 'tears for fears', 'simple minds', 'inxs',
  'midnight oil', 'men at work', 'crowded house', 'john lennon', 'paul mccartney',
  'george harrison', 'ozzy osbourne', 'dio', 'accept', 'helloween', 'saxon',
  'motorhead', 'motörhead', 'thin lizzy', 'ufo', 'bad company', 'free',
  'grand funk railroad', 'bobby hebb', 'the who', 'the kinks', 'yardbirds',
  'yes', 'emerson, lake & palmer', 'jethro tull', 'king crimson', 'rush',
  'marillion', 'alan parsons project', 'electric light orchestra', 'elo',
  'supertramp', '10cc', 'the moody blues', 'procol harum', 't. rex',
  'david bowie', 'iggy pop', 'lou reed', 'velvet underground', 'ramones',
  'the clash', 'sex pistols', 'bobby mcferrin', 'sting', 'peter gabriel',
  'mike oldfield', 'gary moore', 'jeff beck', 'rory gallagher', 'stevie ray vaughan',
  'bb king', 'b.b. king', 'johnny cash', 'bob dylan', 'neil young',
  'simon & garfunkel', 'cat stevens', 'don mclean', 'america', 'bread',
  'air supply', 'christopher cross', 'michael bolton', 'meat loaf', 'mr. big',
  'extreme', 'warrant', 'cinderella', 'ratt', 'dokken', 'quiet riot',
  'great white', 'tesla', 'winger', 'firehouse', 'steelheart', 'damn yankees',
  'bad english', 'night ranger', 'survivor', 'loverboy', 'starship',
  'jefferson airplane', 'jefferson starship', 'the doobie brothers',
  'steve miller band', 'bob seger', 'john mellencamp', 'huey lewis & the news',
  'the cars', 'pretenders', 'the bangles', 'the go-go\'s', 'cyndi lauper',
  'kim wilde', 'nena', 'opus', '3 doors down', 'the calling'
].map(s => s.toLowerCase().trim()));

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

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function hasCyrillic(text: string): boolean {
  return /[а-яёіїєґ]/i.test(text || '');
}

export function isNameMatch(candidateName: string, targetName: string): boolean {
  const normCand = (candidateName || '').toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
  const normTarget = (targetName || '').toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
  if (!normCand || !normTarget) return false;
  return normCand === normTarget || normCand.startsWith(normTarget) || normTarget.startsWith(normCand);
}

export function extractPrimaryArtist(artistStr: string): string {
  if (!artistStr) return 'Unknown Artist';
  const cleaned = artistStr
    .replace(/\u00A0/g, ' ')
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

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Note: Spotify client credentials token is unified in spotify.ts (getAccessToken) with in-flight deduplication

/**
 * Checks if an artist is Russian / CIS music based on Cyrillic text, genres, or related artists.
 */
function isCisArtist(
  artistName: string,
  sampleTitle?: string,
  genres: string[] = [],
  relatedNames: string[] = []
): boolean {
  if (hasCyrillic(artistName)) return true;
  if (sampleTitle && hasCyrillic(sampleTitle)) return true;
  if (genres.some(g => /russian|ukrainian|kazakh|belarusian/i.test(g))) return true;
  if (relatedNames.some(name => hasCyrillic(name))) return true;
  return false;
}

/**
 * Classifies a list of genre strings + artist/track context + related_artists graph into a strict category key.
 */
export function classifyGenresToCategory(
  genres: string[],
  artistName: string,
  sampleTitle?: string,
  isRuHint = false,
  relatedNames: string[] = []
): string | null {
  const cleanArtist = extractPrimaryArtist(artistName).toLowerCase().trim();
  const gList = genres.map(g => g.toLowerCase().trim()).filter(Boolean);
  const joined = gList.join(' | ');
  const relLower = relatedNames.map(r => r.toLowerCase().trim()).filter(Boolean);

  const isRu = isRuHint ||
    hasCyrillic(artistName) ||
    hasCyrillic(sampleTitle || '') ||
    joined.includes('russian') ||
    joined.includes('ukrainian') ||
    joined.includes('kazakh') ||
    joined.includes('belarusian');

  // 0. Check direct anchor membership or strong related_artists graph overlap for Modern vs Classic Rock
  if (MODERN_ROCK_ANCHORS.has(cleanArtist)) {
    return 'rock';
  }
  if (CLASSIC_ROCK_ANCHORS.has(cleanArtist)) {
    return 'classic_rock';
  }

  let modernRockRelCount = 0;
  let classicRockRelCount = 0;
  for (const rName of relLower) {
    if (MODERN_ROCK_ANCHORS.has(rName)) modernRockRelCount++;
    if (CLASSIC_ROCK_ANCHORS.has(rName)) classicRockRelCount++;
  }

  // Only use related rock anchor counts if the artist is not an obvious pure pop or hip-hop act
  const hasRockGenre = gList.some(g => /rock|metal|alternative|grunge|punk/i.test(g));
  const hasPurePopGenre = gList.some(g => /^(pop|dance pop|teen pop|boy band|k-pop|r&b|disco|synthpop|synth-pop)$/i.test(g)) && !hasRockGenre;
  const hasPureHipHop = gList.some(g => /^(hip hop|hip-hop|rap|trap|drill)$/i.test(g)) && !hasRockGenre;

  if (!hasPurePopGenre && !hasPureHipHop) {
    if (modernRockRelCount >= 2 && modernRockRelCount >= classicRockRelCount) {
      return 'rock';
    }
    if (classicRockRelCount >= 2 && classicRockRelCount > modernRockRelCount) {
      return 'classic_rock';
    }
  }

  // 1. Phonk first (distinct subgenre, also check sample track title for "funk"/"montagem"/"slowed")
  if (
    CATEGORY_DEFINITIONS.phonk.keywords.some(kw => joined.includes(kw)) ||
    /\b(phonk|montagem|jumpstyle)\b/i.test(sampleTitle || '')
  ) {
    return 'phonk';
  }

  // 2. Check specific Classic Rock vs Modern Rock genre tags
  const hasClassicRockTag = CATEGORY_DEFINITIONS.classic_rock.keywords.some(kw =>
    gList.some(g => g === kw || g.includes(kw))
  );

  // Exclude non-rock "alternative" tags like "alternative folk", "alternative r&b", "alternative country"
  const isNonRockAlternative = gList.some(g =>
    /alternative (folk|r&b|country|hip-hop|rap|pop)/i.test(g)
  );

  const hasModernRockTag = CATEGORY_DEFINITIONS.rock.keywords.some(kw =>
    gList.some(g => g === kw || g.includes(kw))
  ) || (!isNonRockAlternative && gList.some(g => g === 'rock' || g === 'metal' || g === 'alternative'));

  // 3. Hip-Hop / Rap / Trap (including iTunes "hip-hop/rap")
  const hiphopKws = [
    'hip hop', 'hip-hop', 'hip-hop/rap', 'rap', 'trap', 'drill', 'grime', 'boom bap',
    'cloud rap', 'rage', 'melodic rap', 'gangsta rap', 'рэп', 'хип-хоп', 'трэп'
  ];
  const hasHipHopGenre = gList.some(g =>
    hiphopKws.some(kw =>
      g === kw ||
      g.split(/[\s/]+/).includes(kw) ||
      g.includes(kw)
    )
  );

  // 4. Electronic / Dance / EDM
  const hasElectronicGenre = CATEGORY_DEFINITIONS.electronic.keywords.some(kw =>
    gList.some(g => g === kw || g.includes(kw))
  );

  // Resolve Rock vs Classic Rock using related graph tie-breaker
  if (hasClassicRockTag && modernRockRelCount === 0) {
    return 'classic_rock';
  }

  if (hasModernRockTag) {
    // If related artists lean Classic Rock (e.g. Journey, Foreigner, Scorpions), classify as classic_rock
    if (classicRockRelCount >= 1 && modernRockRelCount === 0) {
      return 'classic_rock';
    }
    if (modernRockRelCount >= 1) {
      return 'rock';
    }
    // If artist has both Electronic/Hip-Hop AND generic "rock" from iTunes without rock related artists,
    // check whether Electronic or Hip-Hop is primary (e.g. French rap or EDM with one rock collab)
    if ((hasHipHopGenre || hasElectronicGenre) && gList[0] !== 'rock' && gList[0] !== 'hard rock' && gList[0] !== 'metal') {
      if (hasHipHopGenre) return isRu ? 'hiphop_ru' : 'hiphop_intl';
      if (hasElectronicGenre) return 'electronic';
    }
    return 'rock';
  }

  if (hasHipHopGenre) {
    return isRu ? 'hiphop_ru' : 'hiphop_intl';
  }

  if (hasElectronicGenre) {
    return 'electronic';
  }

  // 5. Pop / Retro / R&B / Disco / 80s
  if (CATEGORY_DEFINITIONS.pop.keywords.some(kw => gList.some(g => g === kw || g.includes(kw)))) {
    return 'pop';
  }

  // 6. Chill / Lo-Fi / Acoustic
  if (CATEGORY_DEFINITIONS.chill.keywords.some(kw => gList.some(g => g === kw || g.includes(kw)))) {
    return 'chill';
  }

  return isRu ? 'hiphop_ru' : 'pop';
}

/**
 * Resolves and caches artist metadata (genres, category, Deezer ID, related artists, cover).
 */
export async function resolveArtistMetadata(artistName: string, sampleTrackTitle?: string): Promise<ArtistMetadataRecord> {
  const primary = extractPrimaryArtist(artistName);
  const key = primary.toLowerCase();

  try {
    const cached: any = db.prepare('SELECT * FROM artist_metadata WHERE artist_name = ?').get(key);
    if (cached && cached.category && cached.deezer_id) {
      const rels = JSON.parse(cached.related_artists || '[]');
      const cachedGenres = JSON.parse(cached.genres || '[]');
      if (rels.length > 0) {
        const relNames = rels.map((r: any) => r.name || '');
        const isRu = isCisArtist(primary, sampleTrackTitle, cachedGenres, relNames);
        // Re-evaluate category dynamically using current graph + anchor rules so stale categories never persist
        const freshCategory = classifyGenresToCategory(cachedGenres, primary, sampleTrackTitle, isRu, relNames) || cached.category;
        if (freshCategory !== cached.category) {
          try {
            db.prepare('UPDATE artist_metadata SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE artist_name = ?')
              .run(freshCategory, key);
          } catch (_) {}
        }
        return {
          artist_name: key,
          spotify_id: cached.spotify_id,
          deezer_id: cached.deezer_id,
          genres: cachedGenres,
          category: freshCategory,
          related_artists: rels,
          cover_url: cached.cover_url
        };
      }
    }
  } catch (_) {}

  const genres: string[] = [];
  let spotifyId: string | null = null;
  let deezerId: number | null = null;
  let coverUrl: string | null = null;
  const relatedArtists: { name: string; deezer_id?: number; cover_url?: string }[] = [];

  // Slight throttle to protect against Deezer API rate-limits
  await delay(60);

  // 1. iTunes search: search for musicArtist entity first, song fallback second
  try {
    const itArtistRes = await fetchWithTimeout(
      `https://itunes.apple.com/search?term=${encodeURIComponent(primary)}&entity=musicArtist&limit=3`
    );
    if (itArtistRes.ok) {
      const data: any = await itArtistRes.json();
      for (const item of data.results || []) {
        const itemArtist = extractPrimaryArtist(item.artistName || '').toLowerCase();
        if (itemArtist === key || itemArtist.includes(key) || key.includes(itemArtist)) {
          if (item.primaryGenreName && item.primaryGenreName !== 'Music') {
            const g = String(item.primaryGenreName).toLowerCase();
            if (!genres.includes(g)) genres.push(g);
          }
        }
      }
    }
  } catch (_) {}

  if (genres.length === 0) {
    try {
      const itSongRes = await fetchWithTimeout(
        `https://itunes.apple.com/search?term=${encodeURIComponent(primary)}&entity=song&limit=5`
      );
      if (itSongRes.ok) {
        const data: any = await itSongRes.json();
        for (const item of data.results || []) {
          const itemArtist = extractPrimaryArtist(item.artistName || '').toLowerCase();
          if (itemArtist === key || itemArtist.includes(key) || key.includes(itemArtist)) {
            if (item.primaryGenreName && item.primaryGenreName !== 'Music') {
              const g = String(item.primaryGenreName).toLowerCase();
              if (!genres.includes(g)) genres.push(g);
            }
          }
        }
      }
    } catch (_) {}
  }

  // 2. Deezer search: sort by nb_fan desc to pick the verified main artist
  try {
    const dzRes = await fetchWithTimeout(
      `https://api.deezer.com/search/artist?q=${encodeURIComponent(primary)}&limit=5`
    );
    if (dzRes.ok) {
      const dzData: any = await dzRes.json();
      const matching = (dzData.data || []).filter((a: any) => isNameMatch(a.name, primary));
      const candidates = matching.sort(
        (a: any, b: any) => (b.nb_fan || 0) - (a.nb_fan || 0)
      );
      const best = candidates[0];
      if (best && best.id) {
        deezerId = Number(best.id);
        coverUrl = best.picture_xl || best.picture_big || best.picture_medium || null;

        await delay(50);
        const relRes = await fetchWithTimeout(
          `https://api.deezer.com/artist/${deezerId}/related?limit=20`
        );
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

  // 3. Spotify search (for additional genre precision)
  try {
    const token = await getAccessToken();
    if (token) {
      const spRes = await fetchWithTimeout(
        `https://api.spotify.com/v1/search?type=artist&limit=2&q=${encodeURIComponent(primary)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (spRes.ok) {
        const spData: any = await spRes.json();
        const spArtist = spData.artists?.items?.[0];
        if (spArtist) {
          spotifyId = spArtist.id || null;
          if (!coverUrl && spArtist.images?.[0]?.url) {
            coverUrl = spArtist.images[0].url;
          }
          for (const g of spArtist.genres || []) {
            const cleanG = g.toLowerCase();
            if (!genres.includes(cleanG)) genres.push(cleanG);
          }
        }
      }
    }
  } catch (_) {}

  const relNames = relatedArtists.map(r => r.name);
  const isRu = isCisArtist(primary, sampleTrackTitle, genres, relNames);
  const category = classifyGenresToCategory(genres, primary, sampleTrackTitle, isRu, relNames);

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
      const sRes = await fetchWithTimeout(
        `https://api.deezer.com/search/artist?q=${encodeURIComponent(artistName)}&limit=5`
      );
      if (sRes.ok) {
        const sData: any = await sRes.json();
        const matching = (sData.data || []).filter((a: any) => isNameMatch(a.name, artistName));
        const best = matching.sort(
          (a: any, b: any) => (b.nb_fan || 0) - (a.nb_fan || 0)
        )[0];
        resolvedDzId = best?.id;
      }
    }

    if (resolvedDzId) {
      const topRes = await fetchWithTimeout(
        `https://api.deezer.com/artist/${resolvedDzId}/top?limit=50`
      );
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
        `https://itunes.apple.com/search?term=${encodeURIComponent(artistName)}&entity=song&limit=35`
      );
      if (res.ok) {
        const data: any = await res.json();
        for (const item of data.results || []) {
          if (!item.trackName || !item.artistName) continue;
          const itA = extractPrimaryArtist(item.artistName).toLowerCase();
          const target = extractPrimaryArtist(artistName).toLowerCase();
          if (itA !== target && !itA.includes(target) && !target.includes(itA)) {
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
 * Fallback to curated genre searches to ensure exactly 25 tracks per mix without cross-genre pollution.
 */
async function fetchGenreFallbackTracks(categoryKey: string): Promise<SpotifyTrack[]> {
  const results: SpotifyTrack[] = [];
  try {
    let url = '';
    if (categoryKey === 'pop') {
      url = 'https://api.deezer.com/chart/132/tracks?limit=40';
    } else if (categoryKey === 'rock') {
      // Modern Rock / Alt-Metal / Post-Grunge search instead of generic 70s/80s Rock chart
      url = `https://api.deezer.com/search?q=${encodeURIComponent('Breaking Benjamin Three Days Grace Starset')}&limit=40`;
    } else if (categoryKey === 'classic_rock') {
      url = 'https://api.deezer.com/chart/152/tracks?limit=40';
    } else if (categoryKey === 'electronic') {
      url = 'https://api.deezer.com/chart/113/tracks?limit=40';
    } else if (categoryKey === 'hiphop_intl') {
      url = 'https://api.deezer.com/chart/116/tracks?limit=40';
    } else if (categoryKey === 'hiphop_ru') {
      url = `https://api.deezer.com/search?q=${encodeURIComponent('рэп русский')}&limit=40`;
    } else if (categoryKey === 'phonk') {
      url = `https://api.deezer.com/search?q=${encodeURIComponent('phonk drift')}&limit=40`;
    } else if (categoryKey === 'chill') {
      url = `https://api.deezer.com/search?q=${encodeURIComponent('lofi chill')}&limit=40`;
    }

    if (url) {
      const res = await fetchWithTimeout(url);
      if (res.ok) {
        const data: any = await res.json();
        for (const item of data.data || []) {
          if (!item.title || !item.artist?.name) continue;
          results.push({
            id: `dz_${item.id}`,
            title: item.title_short || item.title,
            artist: item.artist.name,
            album: item.album?.title || '',
            duration_ms: (item.duration || 180) * 1000,
            cover_url: item.album?.cover_xl || item.album?.cover_big || item.album?.cover_medium || ''
          });
        }
      }
    }
  } catch (_) {}
  return results;
}

/**
 * Cleans up orphan tracks on disk & DB that were only in old Daily Mixes
 * and were not liked or added to any permanent playlist.
 * Preserves tracks recommended in the last 7 days so recurrent tracks can play instantly.
 */
export function cleanupOrphanDailyMixTracks() {
  try {
    const unlinkedTracks: any[] = db.prepare(`
      SELECT t.id, t.file_path, t.artist, t.title, t.spotify_id
      FROM tracks t
      LEFT JOIN playlist_tracks pt ON pt.track_id = t.id
      LEFT JOIN liked_tracks lt ON lt.track_id = t.id
      WHERE pt.track_id IS NULL
        AND lt.track_id IS NULL
        AND t.created_at < datetime('now', '-15 minutes')
    `).all();

    if (unlinkedTracks.length === 0) return;

    // Get active history from past 7 days to preserve recently recommended tracks
    const recentHistoryRows: any[] = db.prepare(`
      SELECT track_key, spotify_id FROM daily_mix_history
      WHERE created_at >= datetime('now', '-7 days')
    `).all();

    const recentKeys = new Set<string>();
    const recentSpIds = new Set<string>();
    for (const r of recentHistoryRows) {
      if (r.track_key) recentKeys.add(r.track_key);
      if (r.spotify_id) recentSpIds.add(r.spotify_id);
    }

    const toDelete: any[] = [];
    for (const tr of unlinkedTracks) {
      if (tr.spotify_id && recentSpIds.has(tr.spotify_id)) {
        continue;
      }
      const key = normalizeTrackKey(tr.artist, tr.title);
      if (recentKeys.has(key)) {
        continue;
      }
      toDelete.push(tr);
    }

    if (toDelete.length === 0) return;

    const deleteStmt = db.prepare('DELETE FROM tracks WHERE id = ?');
    const deleteTx = db.transaction((items: any[]) => {
      for (const item of items) {
        if (item.file_path && fs.existsSync(item.file_path) && isPathInsideMusicDir(item.file_path)) {
          try {
            fs.unlinkSync(item.file_path);
          } catch (_) {}
        }
        deleteStmt.run(item.id);
      }
    });

    deleteTx(toDelete);
    console.log(`[DailyMix Cleanup] Removed ${toDelete.length} unliked orphan track(s) from old mixes.`);

    // Clean up stale daily_mix_history older than 30 days to keep database compact
    try {
      db.prepare("DELETE FROM daily_mix_history WHERE created_at < datetime('now', '-30 days')").run();
    } catch (_) {}
  } catch (err: any) {
    console.warn('[DailyMix Cleanup Warning]:', err.message);
  }
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

export function findLocalTrackByInfo(title: string, artist: string, spotifyId?: string | null): any {
  try {
    if (spotifyId) {
      const bySp: any = db.prepare('SELECT * FROM tracks WHERE spotify_id = ?').get(spotifyId);
      if (bySp && bySp.file_path && fs.existsSync(bySp.file_path)) return bySp;
    }
    const cleanT = (title || '').toLowerCase().trim();
    const cleanA = extractPrimaryArtist(artist).toLowerCase().trim();
    const cand: any = db.prepare(`
      SELECT * FROM tracks
      WHERE LOWER(title) = ? AND LOWER(artist) LIKE ?
      LIMIT 1
    `).get(cleanT, `%${cleanA}%`);
    if (cand && cand.file_path && fs.existsSync(cand.file_path)) return cand;
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Loads recent history of tracks recommended to the user in Daily Mixes.
 * Returns a Set of normalized track keys from the last `days` days.
 */
export function getRecentDailyMixHistoryKeys(userId: number, days = 14): Set<string> {
  const set = new Set<string>();
  try {
    const rows = db.prepare(`
      SELECT track_key FROM daily_mix_history
      WHERE user_id = ? AND created_at >= datetime('now', '-' || ? || ' days')
    `).all(userId, days) as { track_key: string }[];
    for (const r of rows) {
      if (r.track_key) set.add(r.track_key);
    }
  } catch (err: any) {
    console.warn('[DailyMix History Error]:', err.message);
  }
  return set;
}

/**
 * Gets a pool of recurrent candidate tracks that appeared in previous Daily Mixes
 * for this category between 2 and 14 days ago (excluding today and yesterday to prevent back-to-back repeats).
 */
export function getRecurrentCandidatesForCategory(
  userId: number,
  categoryKey: string,
  todayDate: string,
  ownedTrackKeys: Set<string>,
  isBlacklisted: (artist: string, title: string, spId?: string) => boolean
): SpotifyTrack[] {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT title, artist, album, duration_ms, cover_url, spotify_id, track_key
      FROM daily_mix_history
      WHERE user_id = ?
        AND category = ?
        AND recommended_date != ?
        AND recommended_date < date(?, '-1 day')
        AND created_at >= datetime('now', '-14 days')
      ORDER BY RANDOM()
      LIMIT 40
    `).all(userId, categoryKey, todayDate, todayDate) as any[];

    const results: SpotifyTrack[] = [];
    const seen = new Set<string>();

    for (const r of rows) {
      const key = r.track_key || normalizeTrackKey(r.artist, r.title);
      if (seen.has(key)) continue;
      if (ownedTrackKeys.has(key)) continue;
      if (isBlacklisted(r.artist, r.title, r.spotify_id)) continue;
      seen.add(key);

      results.push({
        id: r.spotify_id || `hist_${Math.abs(hashCode(key))}`,
        title: r.title,
        artist: r.artist,
        album: r.album || '',
        duration_ms: r.duration_ms || 180000,
        cover_url: r.cover_url || ''
      });
    }
    return results;
  } catch (err: any) {
    console.warn('[DailyMix] getRecurrentCandidates error:', err.message);
    return [];
  }
}

/**
 * Records newly selected tracks into daily_mix_history.
 */
export function recordDailyMixHistory(
  userId: number,
  category: string,
  today: string,
  tracks: { title: string; artist: string; album?: string; duration_ms?: number; cover_url?: string; spotify_id?: string }[]
): void {
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO daily_mix_history (
        user_id, track_key, title, artist, album, duration_ms, cover_url, spotify_id, category, recommended_date, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const insertMany = db.transaction((items: typeof tracks) => {
      for (const t of items) {
        const key = normalizeTrackKey(t.artist, t.title);
        stmt.run(
          userId,
          key,
          t.title,
          t.artist,
          t.album || '',
          t.duration_ms || 180000,
          t.cover_url || '',
          t.spotify_id || null,
          category,
          today
        );
      }
    });
    insertMany(tracks);
  } catch (err: any) {
    console.warn('[DailyMix] Error recording history:', err.message);
  }
}

function shuffleCandidatesWithVariety(tracks: SpotifyTrack[]): SpotifyTrack[] {
  if (tracks.length <= 2) return tracks;
  const topSlice = tracks.slice(0, 15).sort(() => Math.random() - 0.5);
  const deepSlice = tracks.slice(15).sort(() => Math.random() - 0.5);
  const mixed: SpotifyTrack[] = [];
  let tI = 0;
  let dI = 0;
  while (tI < topSlice.length || dI < deepSlice.length) {
    if (tI < topSlice.length) mixed.push(topSlice[tI++]);
    if (dI < deepSlice.length && Math.random() > 0.25) mixed.push(deepSlice[dI++]);
  }
  return mixed;
}

export function getUserTimezone(userId: number): string {
  try {
    const row = db.prepare('SELECT timezone FROM users WHERE id = ?').get(userId) as any;
    if (row && row.timezone) return row.timezone;
  } catch (_) {}
  return process.env.TIMEZONE || 'Europe/Kyiv';
}

export function getTodayDateKey(timeZone?: string): string {
  try {
    const tz = timeZone || process.env.TIMEZONE || 'Europe/Kyiv';
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Returns existing Daily Mixes for today, or generates new ones if none exist for today (or if forceRefresh = true).
 */
export async function getOrGenerateDailyMixes(userId: number, forceRefresh = false, timeZone?: string): Promise<any[]> {
  const resolvedTz = timeZone || getUserTimezone(userId);
  const today = getTodayDateKey(resolvedTz);

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

  const summary: any = db.prepare(`
    SELECT COUNT(pt.track_id) as track_count, MAX(pt.added_at) as max_added_at, MAX(pt.position) as max_position
    FROM playlist_tracks pt
    WHERE pt.playlist_id = ?
  `).get(row.id);

  const version = `v_${row.id}_${summary?.track_count || row.track_count || 0}_${summary?.max_position ?? -1}_${summary?.max_added_at || ''}_${row.name}_${row.cover_url || ''}`;

  return {
    ...row,
    version,
    category_title: cat.title,
    category_badge: cat.badge,
    accent_color: cat.accentColor,
    seed_artists: seedArtists,
    activeJob: activeJob || null
  };
}

/**
 * Playlist name heuristics to separate user-curated "Old/Retro/Classic" playlists from "Gym/Modern/Workout" playlists.
 */
function isRetroPlaylistName(name?: string | null): boolean {
  if (!name) return false;
  return /\b(old|retro|classic|70s|80s|90s|vintage|gold|старые|ретро|классика)\b/i.test(name);
}

function isModernWorkoutPlaylistName(name?: string | null): boolean {
  if (!name) return false;
  return /\b(gym|workout|fitness|phonk|sport|rage|hard|зал|тренировка|фонк)\b/i.test(name);
}

async function generateDailyMixesInternal(userId: number, today: string): Promise<any[]> {
  // 1. Gather all user tracks from permanent playlists and liked_tracks, including source playlist name
  const userTracks: any[] = db.prepare(`
    SELECT DISTINCT
      t.id, t.title, t.artist, t.album, t.duration_ms, t.cover_url, t.spotify_id,
      p.id as source_playlist_id,
      p.name as source_playlist_name
    FROM tracks t
    LEFT JOIN playlist_tracks pt ON pt.track_id = t.id
    LEFT JOIN playlists p ON p.id = pt.playlist_id AND COALESCE(p.is_daily_mix, 0) = 0
    LEFT JOIN liked_tracks lt ON lt.track_id = t.id AND lt.user_id = ?
    WHERE p.user_id = ? OR lt.user_id = ?
  `).all(userId, userId, userId);

  if (userTracks.length === 0) {
    return [];
  }

  // 2. Blacklist checker with full normalization & artist splitting
  const isBlacklisted = (artist: string, title: string, spId?: string) => {
    return isTrackBlacklistedForUser(userId, title, artist, spId);
  };

  // Build set of all tracks already owned by user
  const ownedTrackKeys = new Set<string>();
  const ownedSpotifyIds = new Set<string>();
  const ownedTitleToArtists = new Map<string, Set<string>>();
  for (const ut of userTracks) {
    ownedTrackKeys.add(normalizeTrackKey(ut.artist, ut.title));
    if (ut.spotify_id) ownedSpotifyIds.add(ut.spotify_id);
    const cleanT = (ut.title || '').toLowerCase().replace(/\s*[\(\[].*?[\)\]]/g, '').trim();
    if (cleanT.length >= 4) {
      if (!ownedTitleToArtists.has(cleanT)) ownedTitleToArtists.set(cleanT, new Set());
      ownedTitleToArtists.get(cleanT)!.add(extractPrimaryArtist(ut.artist).toLowerCase());
    }
  }

  // 3. Extract unique primary artists, count frequency, and track source playlists
  const artistMap = new Map<string, {
    displayName: string;
    count: number;
    sampleTitle: string;
    tracks: any[];
    playlistIds: Set<number>;
    playlistNames: Set<string>;
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
        playlistIds: new Set(),
        playlistNames: new Set()
      });
    }
    const entry = artistMap.get(key)!;
    if (!entry.tracks.some(t => t.id === ut.id)) {
      entry.tracks.push(ut);
      entry.count++;
    }
    if (ut.source_playlist_id) {
      entry.playlistIds.add(ut.source_playlist_id);
    }
    if (ut.source_playlist_name) {
      entry.playlistNames.add(ut.source_playlist_name);
    }
  }

  // Sort artists by track count descending, take top 65 so all playlists are well-represented
  const sortedArtists = Array.from(artistMap.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 65);

  // Resolve artist metadata in batches of 4 with pauses to prevent Deezer 429
  const metadataByArtist = new Map<string, ArtistMetadataRecord>();
  const batchSize = 4;
  for (let i = 0; i < sortedArtists.length; i += batchSize) {
    const batch = sortedArtists.slice(i, i + batchSize);
    const resolved = await Promise.all(
      batch.map(([_, info]) => resolveArtistMetadata(info.displayName, info.sampleTitle))
    );
    for (const meta of resolved) {
      metadataByArtist.set(meta.artist_name, meta);
    }
    if (i + batchSize < sortedArtists.length) {
      await delay(100);
    }
  }

  // 4. Group artists & their user tracks into categories, accounting for source playlist context
  type ClusterArtist = {
    key: string;
    displayName: string;
    count: number;
    playlistIds: Set<number>;
    playlistNames: Set<string>;
    meta: ArtistMetadataRecord;
    graphDegree?: number;
  };

  const rawClusters = new Map<string, {
    artists: ClusterArtist[];
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
      const isRu = isCisArtist(info.displayName, info.sampleTitle);
      cat = isRu ? 'hiphop_ru' : 'pop';
    }

    // Apply Source Playlist Context (Improvement #2):
    // If an artist is in a Retro/Old playlist (e.g. "Old songs") and NOT in a Gym/Workout playlist,
    // prevent them from polluting Modern Rock ('rock') unless they are an explicit Modern Rock anchor.
    const pNames = Array.from(info.playlistNames);
    const inRetroPlaylist = pNames.some(isRetroPlaylistName);
    const inModernWorkoutPlaylist = pNames.some(isModernWorkoutPlaylistName);

    if (cat === 'rock' && inRetroPlaylist && !inModernWorkoutPlaylist) {
      const relLower = (meta?.related_artists || []).map(r => r.name.toLowerCase().trim());
      const modernOverlap = relLower.filter(r => MODERN_ROCK_ANCHORS.has(r)).length;
      if (!MODERN_ROCK_ANCHORS.has(artistKey) && modernOverlap < 2) {
        cat = 'classic_rock';
      }
    } else if (cat === 'classic_rock' && inModernWorkoutPlaylist && !inRetroPlaylist) {
      if (!CLASSIC_ROCK_ANCHORS.has(artistKey)) {
        cat = 'rock';
      }
    }

    const cluster = ensureCluster(cat);
    cluster.artists.push({
      key: artistKey,
      displayName: info.displayName,
      count: info.count,
      playlistIds: info.playlistIds,
      playlistNames: info.playlistNames,
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

  // 5. Graph Overlap & Co-occurrence Filtering within each cluster (Improvement #4):
  // Prune accidental genre-tag outliers (e.g., an artist whose related_artists graph has 0 overlap
  // with every other artist in the cluster).
  for (const [catKey, cluster] of rawClusters.entries()) {
    if (cluster.artists.length < 4) continue;

    // Build related set for each artist in the cluster
    const relSets = new Map<string, Set<string>>();
    for (const a of cluster.artists) {
      const s = new Set<string>();
      for (const r of a.meta.related_artists || []) {
        if (r.name) s.add(r.name.toLowerCase().trim());
      }
      relSets.set(a.key, s);
    }

    // Compute graphDegree: how many other artists in this cluster share a direct link or common related artist
    let connectedArtistsCount = 0;
    for (const a of cluster.artists) {
      const aRels = relSets.get(a.key)!;
      let degree = 0;
      for (const b of cluster.artists) {
        if (a.key === b.key) continue;
        const bRels = relSets.get(b.key)!;
        const directLink = aRels.has(b.key) || bRels.has(a.key);
        let sharedNeighbor = false;
        if (!directLink) {
          for (const nr of aRels) {
            if (bRels.has(nr)) {
              sharedNeighbor = true;
              break;
            }
          }
        }
        if (directLink || sharedNeighbor) {
          degree++;
        }
      }
      a.graphDegree = degree;
      if (degree >= 1) connectedArtistsCount++;
    }

    // If the cluster has a well-connected core (>= 3 connected artists), remove isolated outliers (graphDegree === 0)
    // unless they are explicit category anchors.
    if (connectedArtistsCount >= 3) {
      const isAnchorForCat = (artistKey: string): boolean => {
        if (catKey === 'rock') return MODERN_ROCK_ANCHORS.has(artistKey);
        if (catKey === 'classic_rock') return CLASSIC_ROCK_ANCHORS.has(artistKey);
        return false;
      };

      const filteredArtists = cluster.artists.filter(
        a => (a.graphDegree || 0) >= 1 || isAnchorForCat(a.key)
      );

      if (filteredArtists.length >= 3) {
        const allowedKeys = new Set(filteredArtists.map(a => a.key));
        cluster.artists = filteredArtists;
        cluster.userTracks = cluster.userTracks.filter(t =>
          allowedKeys.has(extractPrimaryArtist(t.artist).toLowerCase())
        );
      }
    }
  }

  // Only merge closely-related sub-branches if one has < 2 tracks (e.g. phonk into electronic)
  // NEVER merge classic_rock with modern rock, or rock with hip-hop!
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

  if (rawClusters.has('phonk') && rawClusters.get('phonk')!.userTracks.length < 2 && rawClusters.has('electronic')) {
    mergeClusterInto('phonk', 'electronic');
  }

  // Keep clusters that have at least 2 tracks from user's library
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
    const placeholders = oldIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM playlists WHERE id IN (${placeholders})`).run(...oldIds);
    cleanupOrphanDailyMixTracks();
  }

  const createdMixes: any[] = [];
  const TARGET_MIX_SIZE = 25; // EXACTLY 25 tracks in every Daily Mix

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

    // Sort cluster artists by connectivity + track count so the most representative core artists lead the mix
    const rankedClusterArtists = [...cluster.artists].sort((a, b) => {
      const scoreA = a.count * 2 + (a.graphDegree || 0) * 1.5 + Math.random() * 1.5;
      const scoreB = b.count * 2 + (b.graphDegree || 0) * 1.5 + Math.random() * 1.5;
      return scoreB - scoreA;
    });

    const coreArtistKeys = new Set(rankedClusterArtists.map(a => a.key));

    // 1. Pick 2-3 familiar tracks from user's library in this cluster
    // User requested: "например 2-3 песни из моих любимых или плейлистов"
    const TARGET_FAMILIAR_COUNT = Math.min(3, Math.max(2, Math.min(cluster.userTracks.length, 3)));
    const shuffledUserTracks = [...cluster.userTracks]
      .filter(ut => coreArtistKeys.has(extractPrimaryArtist(ut.artist).toLowerCase()))
      .sort(() => Math.random() - 0.5);

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
    for (const ut of shuffledUserTracks) {
      if (familiarTracks.length >= TARGET_FAMILIAR_COUNT) break;
      if (!familiarTracks.some(f => f.id === ut.id)) {
        familiarTracks.push(ut);
      }
    }

    // 2. Pick 5-8 recurring discovery tracks from history (User requested: "5-8 повторяются")
    // Sourced from daily_mix_history 2 to 14 days ago, excluding yesterday so yesterday's mix never clones!
    const targetRecurrentCount = Math.floor(Math.random() * 4) + 5; // 5, 6, 7 or 8 tracks
    const recurrentPool = getRecurrentCandidatesForCategory(
      userId,
      catKey,
      today,
      ownedTrackKeys,
      isBlacklisted
    );

    const recurrentTracks: SpotifyTrack[] = [];
    const recurrentArtistsUsed = new Set<string>();

    for (const rec of recurrentPool) {
      if (recurrentTracks.length >= targetRecurrentCount) break;
      const pa = extractPrimaryArtist(rec.artist).toLowerCase();
      if (recurrentArtistsUsed.has(pa)) continue; // max 1 per artist for diversity
      recurrentTracks.push(rec);
      recurrentArtistsUsed.add(pa);
    }

    // 3. All remaining tracks are completely FRESH discoveries (User: "и все остальные новые")
    // E.g. 25 - 3 - 6 = 16 fresh tracks
    const TARGET_FRESH_COUNT = TARGET_MIX_SIZE - familiarTracks.length - recurrentTracks.length;

    const freshCandidates: SpotifyTrack[] = [];
    const usedTrackKeys = new Set<string>(ownedTrackKeys);
    for (const ft of familiarTracks) {
      usedTrackKeys.add(normalizeTrackKey(ft.artist, ft.title));
    }
    for (const rt of recurrentTracks) {
      usedTrackKeys.add(normalizeTrackKey(rt.artist, rt.title));
    }

    const artistCountInMix = new Map<string, number>();
    for (const ft of familiarTracks) {
      const pa = extractPrimaryArtist(ft.artist).toLowerCase();
      artistCountInMix.set(pa, (artistCountInMix.get(pa) || 0) + 1);
    }
    for (const rt of recurrentTracks) {
      const pa = extractPrimaryArtist(rt.artist).toLowerCase();
      artistCountInMix.set(pa, (artistCountInMix.get(pa) || 0) + 1);
    }

    let maxTracksPerArtist = 1; // Strict 1 track per artist initially for maximum diversity!
    const recentHistoryKeys = getRecentDailyMixHistoryKeys(userId, 14);

    const canAddCandidate = (cand: SpotifyTrack): boolean => {
      if (!cand.title || !cand.artist) return false;
      const pa = extractPrimaryArtist(cand.artist).toLowerCase();

      // 1. Cover / Remake filter: reject explicit cover keywords
      if (/\b(cover|rock cover|metal cover|acoustic cover|tribute|караоке|кавер|remake)\b/i.test(cand.title) ||
          /\b(cover|rock cover|metal cover|acoustic cover|tribute|караоке|кавер|remake)\b/i.test(cand.album || '')) {
        return false;
      }

      // 2. Reject duplicate song title by a different artist if user already owns it
      // (Prevents unwanted remakes/covers of library hits like Adele - Set Fire to the Rain)
      const cleanCandTitle = (cand.title || '').toLowerCase().replace(/\s*[\(\[].*?[\)\]]/g, '').trim();
      if (cleanCandTitle.length >= 4 && ownedTitleToArtists.has(cleanCandTitle)) {
        const owners = ownedTitleToArtists.get(cleanCandTitle)!;
        if (!owners.has(pa)) {
          return false;
        }
      }

      // 3. Known cover-band pop rework filter in rock / metal / alternative mixes:
      if (catKey === 'rock' || catKey === 'classic_rock') {
        if (/^(no resolve|fame on fire|our last night|leo moracchioli|punk goes pop|goblins from mars)$/i.test(pa)) {
          if (/set fire to the rain|easy on me|someone you loved|stay|counting stars|hello|rolling in the deep|shape of you|bad guy|blank space|drivers license|industry baby|as it was|anti-hero|flowers|unstoppable/i.test(cleanCandTitle)) {
            return false;
          }
        }
      }

      // Never allow a Classic Rock anchor in Modern Rock mix or vice versa
      if (catKey === 'rock' && CLASSIC_ROCK_ANCHORS.has(pa)) return false;
      if (catKey === 'classic_rock' && MODERN_ROCK_ANCHORS.has(pa)) return false;

      // Reject incompatible cross-genre collabs
      if (catKey === 'rock' || catKey === 'classic_rock') {
        if (/pitbull|flo rida|cardi b|nicki minaj|drake|travis scott|kanye|gucci mane/i.test(pa)) return false;
        if (/backstreet boys|\*nsync|westlife|spice girls/i.test(pa)) return false;
      }

      const tKey = normalizeTrackKey(cand.artist, cand.title);
      if (usedTrackKeys.has(tKey)) return false;
      if (recentHistoryKeys.has(tKey)) return false; // Exclude tracks from last 14 days!
      if (cand.id && ownedSpotifyIds.has(cand.id)) return false;
      if (isBlacklisted(cand.artist, cand.title, cand.id)) return false;
      if ((artistCountInMix.get(pa) || 0) >= maxTracksPerArtist) return false;
      return true;
    };

    const addCandidate = (cand: SpotifyTrack) => {
      const tKey = normalizeTrackKey(cand.artist, cand.title);
      usedTrackKeys.add(tKey);
      const pa = extractPrimaryArtist(cand.artist).toLowerCase();
      artistCountInMix.set(pa, (artistCountInMix.get(pa) || 0) + 1);
      freshCandidates.push(cand);
    };

    // Stage A: Unheard tracks from seed artists in this category
    // Rotate seeds from top 25 so different bands lead each day
    const topCandidateSeeds = rankedClusterArtists.slice(0, 25);
    const seedArtistsPool = [...topCandidateSeeds].sort(() => Math.random() - 0.5).slice(0, 10);

    const seedTrackLists = await Promise.all(
      seedArtistsPool.map(sa => fetchArtistCandidateTracks(sa.displayName, sa.meta.deezer_id))
    );

    for (const trackList of seedTrackLists) {
      const shuffled = shuffleCandidatesWithVariety(trackList);
      for (const cand of shuffled) {
        if (freshCandidates.length >= Math.ceil(TARGET_FRESH_COUNT * 0.45)) break;
        if (canAddCandidate(cand)) {
          addCandidate(cand);
          break; // max 1 initially
        }
      }
    }

    // Stage B: Tracks from Related Artists verified by BOTH Category AND Graph Overlap
    const relatedRecommendationCount = new Map<string, number>();
    const clusterNeighborhood = new Set<string>(cluster.artists.map(a => a.key));

    for (const ca of cluster.artists) {
      for (const rel of ca.meta.related_artists || []) {
        const rKey = rel.name.toLowerCase().trim();
        clusterNeighborhood.add(rKey);
        relatedRecommendationCount.set(rKey, (relatedRecommendationCount.get(rKey) || 0) + 1);
      }
    }

    const relatedPool: { name: string; deezer_id?: number; cover_url?: string; recCount: number }[] = [];
    const seenRelated = new Set<string>(cluster.artists.map(a => a.key));

    for (const sa of seedArtistsPool) {
      for (const rel of sa.meta.related_artists || []) {
        const rKey = rel.name.toLowerCase().trim();
        if (!seenRelated.has(rKey)) {
          seenRelated.add(rKey);
          relatedPool.push({
            ...rel,
            recCount: relatedRecommendationCount.get(rKey) || 1
          });
        }
      }
    }

    const sortedRelated = relatedPool
      .sort((a, b) => (b.recCount + Math.random() * 0.8) - (a.recCount + Math.random() * 0.8))
      .slice(0, 30);

    for (let rIdx = 0; rIdx < sortedRelated.length; rIdx += 5) {
      if (freshCandidates.length >= TARGET_FRESH_COUNT) break;
      const rBatch = sortedRelated.slice(rIdx, rIdx + 5);

      const batchResults = await Promise.all(
        rBatch.map(async (rel) => {
          const relKey = rel.name.toLowerCase().trim();
          if (catKey === 'rock' && CLASSIC_ROCK_ANCHORS.has(relKey)) return [];
          if (catKey === 'classic_rock' && MODERN_ROCK_ANCHORS.has(relKey)) return [];

          const relMeta = await resolveArtistMetadata(rel.name);
          if (relMeta.category !== catKey) {
            return [];
          }

          const candNeighbors = (relMeta.related_artists || []).map(r => r.name.toLowerCase().trim());
          let graphOverlap = 0;
          for (const cn of candNeighbors) {
            if (clusterNeighborhood.has(cn)) {
              graphOverlap++;
            }
          }

          if (graphOverlap === 0 && rel.recCount < 2 && cluster.artists.length >= 2) {
            return [];
          }

          return await fetchArtistCandidateTracks(rel.name, rel.deezer_id || relMeta.deezer_id);
        })
      );

      for (const trackList of batchResults) {
        const shuffled = shuffleCandidatesWithVariety(trackList);
        for (const cand of shuffled) {
          if (freshCandidates.length >= TARGET_FRESH_COUNT) break;
          if (canAddCandidate(cand)) {
            addCandidate(cand);
            break; // max 1 initially
          }
        }
      }
    }

    // Stage C: If still below TARGET_FRESH_COUNT, expand artist cap to 2 tracks
    if (freshCandidates.length < TARGET_FRESH_COUNT) {
      maxTracksPerArtist = 2;
      for (const trackList of seedTrackLists) {
        const shuffled = shuffleCandidatesWithVariety(trackList);
        for (const cand of shuffled) {
          if (freshCandidates.length >= TARGET_FRESH_COUNT) break;
          if (canAddCandidate(cand)) {
            addCandidate(cand);
          }
        }
      }
    }

    // Stage D: If STILL below TARGET_FRESH_COUNT, fetch genre fallback tracks
    if (freshCandidates.length < TARGET_FRESH_COUNT) {
      maxTracksPerArtist = 3;
      const fallbackTracks = await fetchGenreFallbackTracks(catKey);
      const shuffled = fallbackTracks.sort(() => Math.random() - 0.5);
      for (const cand of shuffled) {
        if (freshCandidates.length >= TARGET_FRESH_COUNT) break;
        if (canAddCandidate(cand)) {
          addCandidate(cand);
        }
      }
    }

    const finalNewTracks = freshCandidates.slice(0, TARGET_FRESH_COUNT);

    // 4. Assemble the final 25 tracks with balanced slots
    // Position 0 is ALWAYS familiar (0 ms instant play)
    // Familiar: 2-3 tracks (pos 0, pos 12, pos 24)
    // Recurrent: 5-8 tracks spaced across the playlist
    // Fresh discoveries: fill all remaining positions!
    const mixSlots: { type: 'familiar' | 'recurrent' | 'new'; track: any }[] = new Array(TARGET_MIX_SIZE).fill(null);

    if (familiarTracks.length > 0) mixSlots[0] = { type: 'familiar', track: familiarTracks[0] };
    if (familiarTracks.length > 1) mixSlots[12] = { type: 'familiar', track: familiarTracks[1] };
    if (familiarTracks.length > 2) mixSlots[24] = { type: 'familiar', track: familiarTracks[2] };

    const recurrentSlots = [3, 7, 10, 15, 18, 21, 5, 23];
    let rI = 0;
    for (const pos of recurrentSlots) {
      if (rI < recurrentTracks.length && !mixSlots[pos]) {
        mixSlots[pos] = { type: 'recurrent', track: recurrentTracks[rI++] };
      }
    }
    while (rI < recurrentTracks.length) {
      const emptyPos = mixSlots.findIndex(s => s === null);
      if (emptyPos === -1) break;
      mixSlots[emptyPos] = { type: 'recurrent', track: recurrentTracks[rI++] };
    }

    let nI = 0;
    for (let pos = 0; pos < TARGET_MIX_SIZE; pos++) {
      if (!mixSlots[pos]) {
        if (nI < finalNewTracks.length) {
          mixSlots[pos] = { type: 'new', track: finalNewTracks[nI++] };
        } else if (rI < recurrentPool.length) {
          mixSlots[pos] = { type: 'recurrent', track: recurrentPool[rI++] };
        }
      }
    }

    let finalMixItems: { type: 'familiar' | 'recurrent' | 'new'; track: any; position: number }[] = [];
    let currentPos = 0;
    for (let i = 0; i < TARGET_MIX_SIZE; i++) {
      if (mixSlots[i]) {
        finalMixItems.push({
          type: mixSlots[i].type,
          track: mixSlots[i].track,
          position: currentPos++
        });
      }
    }

    finalMixItems = finalMixItems.filter(item => !isTrackBlacklistedForUser(userId, item.track.title, item.track.artist, item.track.id));

    // Record newly selected discovery tracks (recurrent + new) into daily_mix_history
    const discoveryTracksToRecord = finalMixItems
      .filter(item => item.type === 'recurrent' || item.type === 'new')
      .map(item => item.track);
    recordDailyMixHistory(userId, catKey, today, discoveryTracksToRecord);

    const seedNames = seedArtistsPool.slice(0, 4).map(a => a.displayName);
    const mixName = `Микс дня #${mixNumber} • ${catDef.title}`;
    const mixDesc = `${catDef.title} • На основе ${seedNames.join(', ')} и новых исполнителей`;
    const mixCover =
      seedArtistsPool.find(a => a.meta.cover_url)?.meta.cover_url ||
      familiarTracks.find(t => t.cover_url)?.cover_url ||
      finalNewTracks.find(t => t.cover_url)?.cover_url ||
      '';

    const insertPt = db.prepare(`
      INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
      VALUES (?, ?, ?)
    `);

    // Create Daily Mix playlist row first to obtain ID
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
      JSON.stringify([]) // will be updated with tracksToDownload
    );

    const mixPlaylistId = Number(insertRes.lastInsertRowid);
    const tracksToDownload: SpotifyTrack[] = [];
    const localTracksToInsert: { trackId: number; position: number }[] = [];

    for (const item of finalMixItems) {
      if (item.type === 'familiar') {
        localTracksToInsert.push({ trackId: item.track.id, position: item.position });
      } else {
        const local = findLocalTrackByInfo(item.track.title, item.track.artist, item.track.id);
        if (local && local.id) {
          localTracksToInsert.push({ trackId: local.id, position: item.position });
        } else {
          tracksToDownload.push({
            ...item.track,
            position: item.position
          });
        }
      }
    }

    if (localTracksToInsert.length > 0) {
      const insertManyPt = db.transaction((rows: { trackId: number; position: number }[]) => {
        for (const r of rows) {
          insertPt.run(mixPlaylistId, r.trackId, r.position);
        }
      });
      insertManyPt(localTracksToInsert);
    }

    db.prepare('UPDATE playlists SET daily_mix_tracks_json = ? WHERE id = ?')
      .run(JSON.stringify(tracksToDownload), mixPlaylistId);

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

  // If user already saved this daily mix today, return existing without creating duplicates
  const existing: any = db.prepare('SELECT id, name FROM playlists WHERE user_id = ? AND name = ?').get(userId, newName);
  if (existing) {
    return { id: existing.id, name: existing.name };
  }

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
  if (tracks.length > 0) {
    const insertAllPt = db.transaction((items: any[]) => {
      for (const t of items) {
        insertPt.run(newPlaylistId, t.track_id, t.position);
      }
    });
    insertAllPt(tracks);
  }

  // If there are still pending/in-flight tracks from the Daily Mix, ensure they are also queued for the saved playlist
  if (mix.daily_mix_tracks_json) {
    try {
      const pendingTracks: SpotifyTrack[] = JSON.parse(mix.daily_mix_tracks_json) || [];
      const existingTrackIds = new Set(tracks.map(t => t.track_id));
      const tracksToQueue: SpotifyTrack[] = [];
      let nextPos = tracks.length;

      for (const pt of pendingTracks) {
        const customPos = (pt as any).position;
        const local = findLocalTrackByInfo(pt.title, pt.artist, pt.id);
        if (local && local.id && !existingTrackIds.has(local.id)) {
          insertPt.run(newPlaylistId, local.id, typeof customPos === 'number' ? customPos : nextPos++);
          existingTrackIds.add(local.id);
        } else if (!local || !existingTrackIds.has(local.id)) {
          tracksToQueue.push({
            ...pt,
            position: typeof customPos === 'number' ? customPos : nextPos++
          } as any);
        }
      }

      if (tracksToQueue.length > 0) {
        const jobId = `save_dm_${newPlaylistId}_${Date.now().toString(36)}`;
        db.prepare(`
          INSERT INTO download_jobs (id, user_id, playlist_id, playlist_name, total_tracks, downloaded_tracks, status)
          VALUES (?, ?, ?, ?, ?, ?, 'downloading')
        `).run(jobId, userId, newPlaylistId, newName, tracks.length + tracksToQueue.length, tracks.length);
        enqueuePlaylistDownload(jobId, userId, newPlaylistId, tracksToQueue);
      }
    } catch (_) {}
  }

  return { id: newPlaylistId, name: newName };
}
