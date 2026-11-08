import crypto from 'crypto';
import { db } from './db';
import { getOrGenerateJwtSecret } from './authSecret';

export interface SpotifyTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration_ms: number;
  cover_url?: string;
}

export interface SpotifyPlaylistData {
  name: string;
  description: string;
  cover_url?: string;
  tracks: SpotifyTrack[];
}

let spotifyAccessToken: string | null = null;
let tokenExpiresAt = 0;

export function getSpotifyCredentials() {
  const envId = process.env.SPOTIFY_CLIENT_ID;
  const envSecret = process.env.SPOTIFY_CLIENT_SECRET;

  const dbIdRow = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('spotify_client_id') as { value: string } | undefined;
  const dbSecretRow = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('spotify_client_secret') as { value: string } | undefined;

  return {
    clientId: dbIdRow?.value || envId || '',
    clientSecret: dbSecretRow?.value || envSecret || ''
  };
}

let inFlightTokenPromise: Promise<string | null> | null = null;

export async function getAccessToken(): Promise<string | null> {
  const { clientId, clientSecret } = getSpotifyCredentials();
  if (!clientId || !clientSecret) return null;

  if (spotifyAccessToken && Date.now() < tokenExpiresAt) {
    return spotifyAccessToken;
  }

  if (inFlightTokenPromise) {
    return inFlightTokenPromise;
  }

  inFlightTokenPromise = (async () => {
    try {
      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) {
        console.warn('[Spotify] Failed to get client credentials token:', res.statusText);
        return null;
      }

      const data: any = await res.json();
      spotifyAccessToken = data.access_token;
      tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
      return spotifyAccessToken;
    } catch (err: any) {
      console.warn('[Spotify] Token fetch error:', err.message);
      return null;
    } finally {
      inFlightTokenPromise = null;
    }
  })();

  return inFlightTokenPromise;
}

export async function getUserSpotifyToken(userId: number): Promise<string | null> {
  const row: any = db.prepare('SELECT spotify_access_token, spotify_refresh_token, spotify_token_expires FROM users WHERE id = ?').get(userId);
  if (!row || !row.spotify_access_token) return null;

  // If token is still valid (with 60-second grace window)
  if (row.spotify_token_expires && Date.now() < row.spotify_token_expires - 60000) {
    return row.spotify_access_token;
  }

  // Refresh token if available
  if (row.spotify_refresh_token) {
    const { clientId, clientSecret } = getSpotifyCredentials();
    if (!clientId || !clientSecret) return null;

    try {
      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: row.spotify_refresh_token
        }).toString(),
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) {
        console.warn('[Spotify] Failed to refresh user token:', res.statusText);
        return null;
      }

      const data: any = await res.json();
      const newAccessToken = data.access_token;
      const newExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
      const newRefreshToken = data.refresh_token || row.spotify_refresh_token;

      db.prepare(`
        UPDATE users
        SET spotify_access_token = ?, spotify_refresh_token = ?, spotify_token_expires = ?
        WHERE id = ?
      `).run(newAccessToken, newRefreshToken, newExpiresAt, userId);

      return newAccessToken;
    } catch (e: any) {
      console.warn('[Spotify] Error refreshing user token:', e.message);
      return null;
    }
  }

  return row.spotify_access_token;
}

export function getSpotifyAuthUrl(userId: number, redirectUri: string, origin: string): string {
  const { clientId } = getSpotifyCredentials();
  if (!clientId) throw new Error('Spotify Client ID не настроен в настройках приложения');

  const scopes = [
    'playlist-read-private',
    'playlist-read-collaborative',
    'user-library-read'
  ].join(' ');

  const exp = Date.now() + 10 * 60 * 1000; // 10 minutes TTL
  const payload = JSON.stringify({ userId, origin, redirectUri, exp });
  const secret = getOrGenerateJwtSecret();
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const statePayload = Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: scopes,
    redirect_uri: redirectUri,
    state: statePayload,
    show_dialog: 'true'
  });

  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export async function handleSpotifyOAuthCallback(code: string, stateStr: string): Promise<{ success: boolean; origin: string; error?: string }> {
  let userId: number;
  let origin = '';
  let redirectUri = '';

  try {
    const rawParsed = JSON.parse(Buffer.from(stateStr, 'base64url').toString('utf-8'));
    if (!rawParsed || typeof rawParsed !== 'object' || !rawParsed.p || !rawParsed.s || typeof rawParsed.p !== 'string' || typeof rawParsed.s !== 'string') {
      throw new Error('Неверный или поврежденный формат OAuth state');
    }

    const secret = getOrGenerateJwtSecret();
    const expectedSig = crypto.createHmac('sha256', secret).update(rawParsed.p).digest('base64url');
    
    const sigBuf = Buffer.from(rawParsed.s, 'utf-8');
    const expBuf = Buffer.from(expectedSig, 'utf-8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new Error('Подпись state не совпадает (возможна попытка CSRF-атаки)');
    }

    const data = JSON.parse(rawParsed.p);
    if (!data.exp || typeof data.exp !== 'number' || Date.now() > data.exp) {
      throw new Error('Срок действия OAuth state истек. Пожалуйста, повторите попытку авторизации.');
    }

    userId = data.userId;
    origin = data.origin || '';
    redirectUri = data.redirectUri;
  } catch (e: any) {
    throw new Error('Неверный параметр state в ответе Spotify: ' + e.message);
  }

  // Sanitize origin to prevent open-redirect vulnerabilities
  if (origin && !origin.startsWith('/') && !/^https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?$/i.test(origin)) {
    origin = '';
  }

  const { clientId, clientSecret } = getSpotifyCredentials();
  if (!clientId || !clientSecret) {
    throw new Error('Spotify Client ID или Secret не настроены');
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    }).toString(),
    signal: AbortSignal.timeout(10000)
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error('[Spotify OAuth Error]', errText);
    throw new Error(`Ошибка получения токена Spotify (${tokenRes.status})`);
  }

  const tokenData: any = await tokenRes.json();
  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token;
  const expiresAt = Date.now() + (tokenData.expires_in || 3600) * 1000;

  let spotifyUserId = '';
  let spotifyDisplayName = '';
  try {
    const meRes = await fetch('https://api.spotify.com/v1/me', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000)
    });
    if (meRes.ok) {
      const meData: any = await meRes.json();
      spotifyUserId = meData.id || '';
      spotifyDisplayName = meData.display_name || meData.id || '';
    }
  } catch (_) {}

  db.prepare(`
    UPDATE users
    SET spotify_access_token = ?, spotify_refresh_token = ?, spotify_token_expires = ?,
        spotify_user_id = ?, spotify_display_name = ?
    WHERE id = ?
  `).run(accessToken, refreshToken, expiresAt, spotifyUserId, spotifyDisplayName, userId);

  return { success: true, origin };
}

export function disconnectSpotify(userId: number) {
  db.prepare(`
    UPDATE users
    SET spotify_access_token = NULL, spotify_refresh_token = NULL, spotify_token_expires = NULL,
        spotify_user_id = NULL, spotify_display_name = NULL
    WHERE id = ?
  `).run(userId);
}

export type SpotifyEntityType = 'playlist' | 'album' | 'track' | 'artist';

export interface ParsedSpotifyEntity {
  type: SpotifyEntityType;
  id: string;
}

export function parseSpotifyEntityUrl(input: string): ParsedSpotifyEntity | null {
  if (!input) return null;
  const trimmed = input.trim();

  // 1. Standard or regional Spotify URLs: https://open.spotify.com/(intl-xx/)?(embed/)?(playlist|album|track|artist)/{id}
  const urlMatch = trimmed.match(
    /(?:open\.spotify\.com|play\.spotify\.com)\/(?:intl-[a-zA-Z0-9-]+\/)?(?:embed\/)?(playlist|album|track|artist)\/([a-zA-Z0-9]{15,30})/i
  );
  if (urlMatch) {
    return {
      type: urlMatch[1].toLowerCase() as SpotifyEntityType,
      id: urlMatch[2]
    };
  }

  // 2. Spotify URI: spotify:(playlist|album|track|artist):{id}
  const uriMatch = trimmed.match(/spotify:(playlist|album|track|artist):([a-zA-Z0-9]{15,30})/i);
  if (uriMatch) {
    return {
      type: uriMatch[1].toLowerCase() as SpotifyEntityType,
      id: uriMatch[2]
    };
  }

  // 3. Relative path match: /(playlist|album|track|artist)/{id}
  const pathMatch = trimmed.match(/\b(playlist|album|track|artist)\/([a-zA-Z0-9]{15,30})/i);
  if (pathMatch) {
    return {
      type: pathMatch[1].toLowerCase() as SpotifyEntityType,
      id: pathMatch[2]
    };
  }

  return null;
}

function isAllowedSpotifyHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'open.spotify.com' ||
         h === 'spotify.link' ||
         h === 'spoti.fi' ||
         h === 'spotify.app.link' ||
         h.endsWith('.spotify.com') ||
         h.endsWith('.spotify.link') ||
         h.endsWith('.spotify.app.link');
}

async function readLimitedText(res: Response, maxBytes = 65536): Promise<string> {
  try {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const take = Math.min(value.length, maxBytes - totalBytes);
        chunks.push(value.subarray(0, take));
        totalBytes += take;
        if (totalBytes >= maxBytes) {
          try { await reader.cancel(); } catch (_) {}
          break;
        }
      }
    }
    return Buffer.concat(chunks).toString('utf-8');
  } catch (_) {
    return '';
  }
}

export async function resolveSpotifyEntityInput(input: string): Promise<ParsedSpotifyEntity | null> {
  const direct = parseSpotifyEntityUrl(input);
  if (direct) return direct;

  // Resolve short links: spotify.link/..., spoti.fi/..., spotify.app.link/...
  const shortLinkMatch = input.match(/https?:\/\/(?:spotify\.link|spoti\.fi|spotify\.app\.link)\/[^\s"'<>]+/i);
  if (shortLinkMatch) {
    try {
      let currentUrl = shortLinkMatch[0];
      // Manual redirect follow loop with domain whitelist (SSRF & loop prevention)
      for (let hop = 0; hop < 3; hop++) {
        const urlObj = new URL(currentUrl);
        if (!isAllowedSpotifyHost(urlObj.hostname)) {
          return null;
        }

        const res = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(8000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });

        // Check redirect Location
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) break;
          const nextUrl = new URL(loc, currentUrl).toString();
          const nextHost = new URL(nextUrl).hostname;
          if (!isAllowedSpotifyHost(nextHost)) {
            return null;
          }
          const resolved = parseSpotifyEntityUrl(nextUrl);
          if (resolved) return resolved;
          currentUrl = nextUrl;
          continue;
        }

        if (res.ok) {
          const html = await readLimitedText(res, 65536);
          const inHtml = parseSpotifyEntityUrl(html);
          if (inHtml) return inHtml;
        }
        break;
      }
    } catch (_) {}
  }

  return null;
}

export function extractPlaylistId(url: string): string | null {
  const parsed = parseSpotifyEntityUrl(url);
  if (parsed) return parsed.id;
  const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

function extractEntityCoverUrl(entity: any): string {
  if (!entity) return '';
  if (Array.isArray(entity.visualIdentity?.image) && entity.visualIdentity.image.length > 0) {
    const sorted = [...entity.visualIdentity.image].sort((a: any, b: any) => (b.maxHeight || 0) - (a.maxHeight || 0));
    if (sorted[0]?.url) return sorted[0].url;
  }
  if (Array.isArray(entity.coverArt?.sources) && entity.coverArt.sources.length > 0) {
    const sorted = [...entity.coverArt.sources].sort((a: any, b: any) => (b.height || 0) - (a.height || 0));
    if (sorted[0]?.url) return sorted[0].url;
  }
  return '';
}

export async function fetchSpotifyAlbum(albumId: string, userId?: number): Promise<SpotifyPlaylistData> {
  if (!albumId || !/^[a-zA-Z0-9]{15,30}$/.test(albumId)) {
    throw new Error('Некорректный идентификатор альбома Spotify');
  }
  let token: string | null = null;
  if (userId) {
    token = await getUserSpotifyToken(userId);
  }
  if (!token) {
    token = await getAccessToken();
  }

  if (token) {
    try {
      const albumRes = await fetch(`https://api.spotify.com/v1/albums/${albumId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(10000)
      });
      if (albumRes.ok) {
        const aData: any = await albumRes.json();
        const albumName = aData.name || 'Spotify Album';
        const albumCover = aData.images?.[0]?.url || '';
        const albumArtists = aData.artists?.map((a: any) => a.name).join(', ') || 'Unknown Artist';
        const tracks: SpotifyTrack[] = [];

        for (const t of aData.tracks?.items || []) {
          if (!t) continue;
          tracks.push({
            id: t.id || Math.random().toString(36).substring(7),
            title: t.name,
            artist: t.artists?.map((a: any) => a.name).join(', ') || albumArtists,
            album: albumName,
            duration_ms: t.duration_ms || 180000,
            cover_url: albumCover
          });
        }

        let nextUrl: string | null = aData.tracks?.next || null;
        let albumPages = 0;
        while (nextUrl && albumPages < 20 && nextUrl.startsWith('https://api.spotify.com/')) {
          albumPages++;
          try {
            const nextRes = await fetch(nextUrl, {
              headers: { 'Authorization': `Bearer ${token}` },
              signal: AbortSignal.timeout(10000)
            });
            if (!nextRes.ok) break;
            const nextData: any = await nextRes.json();
            for (const t of nextData.items || []) {
              if (!t) continue;
              tracks.push({
                id: t.id || Math.random().toString(36).substring(7),
                title: t.name,
                artist: t.artists?.map((a: any) => a.name).join(', ') || albumArtists,
                album: albumName,
                duration_ms: t.duration_ms || 180000,
                cover_url: albumCover
              });
              if (tracks.length >= 1000) break;
            }
            if (tracks.length >= 1000) break;
            nextUrl = nextData.next || null;
          } catch (pageErr: any) {
            console.warn('[Spotify album pagination error]:', pageErr.message);
            break;
          }
        }

        if (tracks.length > 0) {
          return {
            name: albumName,
            description: `Альбом • ${albumArtists}`,
            cover_url: albumCover,
            tracks
          };
        }
      }
    } catch (e: any) {
      console.warn('[Spotify Album API error, falling back to embed parser]:', e.message);
    }
  }

  // Fallback: Embed scraper (Zero API keys required!)
  const embedUrl = `https://open.spotify.com/embed/album/${albumId}`;
  const res = await fetch(embedUrl, {
    signal: AbortSignal.timeout(10000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  if (!res.ok) {
    throw new Error(`Не удалось загрузить альбом Spotify (${res.status})`);
  }

  const html = await res.text();
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const entity = nextData.props?.pageProps?.state?.data?.entity;
      if (entity) {
        const albumTitle = entity.title || entity.name || 'Spotify Album';
        const albumArtist = (entity.subtitle ? entity.subtitle.replace(/\u00a0/g, ' ') : '') || 'Unknown Artist';
        const albumCover = extractEntityCoverUrl(entity);

        const tracks: SpotifyTrack[] = (entity.trackList || []).map((t: any) => {
          const spId = t.uri ? t.uri.split(':').pop() : (t.id || Math.random().toString(36).substring(7));
          return {
            id: spId,
            title: t.title || t.name,
            artist: (t.subtitle ? t.subtitle.replace(/\u00a0/g, ' ') : (t.artists?.map((a: any) => a.name).join(', '))) || albumArtist,
            album: albumTitle,
            duration_ms: t.duration || 180000,
            cover_url: albumCover
          };
        });

        return {
          name: albumTitle,
          description: albumArtist ? `Альбом • ${albumArtist}` : 'Альбом из Spotify',
          cover_url: albumCover,
          tracks
        };
      }
    } catch (_) {}
  }

  throw new Error('Не удалось извлечь треки из альбома Spotify');
}

export async function fetchSpotifyArtistTopTracks(artistId: string, userId?: number): Promise<SpotifyPlaylistData> {
  if (!artistId || !/^[a-zA-Z0-9]{15,30}$/.test(artistId)) {
    throw new Error('Некорректный идентификатор исполнителя Spotify');
  }
  let token: string | null = null;
  if (userId) {
    token = await getUserSpotifyToken(userId);
  }
  if (!token) {
    token = await getAccessToken();
  }

  if (token) {
    try {
      const [artistRes, topRes] = await Promise.all([
        fetch(`https://api.spotify.com/v1/artists/${artistId}`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(10000)
        }),
        fetch(`https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=US`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(10000)
        })
      ]);

      if (topRes.ok) {
        const topData: any = await topRes.json();
        const artistData: any = artistRes.ok ? await artistRes.json() : {};
        const artistName = artistData.name || topData.tracks?.[0]?.artists?.[0]?.name || 'Spotify Artist';
        const artistCover = artistData.images?.[0]?.url || topData.tracks?.[0]?.album?.images?.[0]?.url || '';

        const tracks: SpotifyTrack[] = (topData.tracks || []).map((t: any) => ({
          id: t.id || Math.random().toString(36).substring(7),
          title: t.name,
          artist: t.artists?.map((a: any) => a.name).join(', ') || artistName,
          album: t.album?.name || '',
          duration_ms: t.duration_ms || 180000,
          cover_url: t.album?.images?.[0]?.url || artistCover
        }));

        if (tracks.length > 0) {
          return {
            name: artistName,
            description: `Лучшие треки • ${artistName}`,
            cover_url: artistCover,
            tracks
          };
        }
      }
    } catch (e: any) {
      console.warn('[Spotify Artist API error, falling back to embed parser]:', e.message);
    }
  }

  const embedUrl = `https://open.spotify.com/embed/artist/${artistId}`;
  const res = await fetch(embedUrl, {
    signal: AbortSignal.timeout(10000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  if (!res.ok) {
    throw new Error(`Не удалось загрузить страницу исполнителя Spotify (${res.status})`);
  }

  const html = await res.text();
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const entity = nextData.props?.pageProps?.state?.data?.entity;
      if (entity) {
        const artistName = entity.title || entity.name || 'Spotify Artist';
        const artistCover = extractEntityCoverUrl(entity);
        const tracks: SpotifyTrack[] = (entity.trackList || []).map((t: any) => {
          const spId = t.uri ? t.uri.split(':').pop() : (t.id || Math.random().toString(36).substring(7));
          return {
            id: spId,
            title: t.title || t.name,
            artist: (t.subtitle ? t.subtitle.replace(/\u00a0/g, ' ') : '') || artistName,
            album: '',
            duration_ms: t.duration || 180000,
            cover_url: artistCover
          };
        });

        return {
          name: artistName,
          description: `Лучшие треки • ${artistName}`,
          cover_url: artistCover,
          tracks
        };
      }
    } catch (_) {}
  }

  throw new Error('Не удалось извлечь треки исполнителя Spotify');
}

export async function fetchSpotifySingleTrackAsPlaylist(trackId: string, userId?: number): Promise<SpotifyPlaylistData> {
  if (!trackId || !/^[a-zA-Z0-9]{15,30}$/.test(trackId)) {
    throw new Error('Некорректный идентификатор трека Spotify');
  }
  let token: string | null = null;
  if (userId) {
    token = await getUserSpotifyToken(userId);
  }
  if (!token) {
    token = await getAccessToken();
  }

  if (token) {
    try {
      const sRes = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(10000)
      });
      if (sRes.ok) {
        const sData: any = await sRes.json();
        const artist = sData.artists?.map((a: any) => a.name).join(', ') || 'Unknown Artist';
        const title = sData.name || 'Track';
        const album = sData.album?.name || '';
        const cover_url = sData.album?.images?.[0]?.url || '';
        return {
          name: album || `${artist} — ${title}`,
          description: `Сингл • ${artist}`,
          cover_url,
          tracks: [
            {
              id: sData.id || trackId,
              title,
              artist,
              album,
              duration_ms: sData.duration_ms || 180000,
              cover_url
            }
          ]
        };
      }
    } catch (_) {}
  }

  const d = await resolveSpotifyTrackDetails(trackId);
  const title = d.title || 'Track';
  const artist = d.artist || 'Unknown Artist';
  const album = d.album || '';
  const cover_url = d.cover_url || '';

  return {
    name: album || `${artist} — ${title}`,
    description: `Сингл • ${artist}`,
    cover_url,
    tracks: [
      {
        id: trackId,
        title,
        artist,
        album,
        duration_ms: d.duration_ms || 180000,
        cover_url
      }
    ]
  };
}

export async function fetchSpotifyPlaylist(urlOrId: string, userId?: number): Promise<SpotifyPlaylistData> {
  const parsed = await resolveSpotifyEntityInput(urlOrId);
  if (parsed?.type === 'album') {
    return fetchSpotifyAlbum(parsed.id, userId);
  }
  if (parsed?.type === 'artist') {
    return fetchSpotifyArtistTopTracks(parsed.id, userId);
  }
  if (parsed?.type === 'track') {
    return fetchSpotifySingleTrackAsPlaylist(parsed.id, userId);
  }

  const rawPlaylistId = parsed?.id || extractPlaylistId(urlOrId) || urlOrId.trim();
  if (!rawPlaylistId || !/^[a-zA-Z0-9]{15,30}$/.test(rawPlaylistId)) {
    throw new Error('Некорректный идентификатор плейлиста Spotify');
  }
  const playlistId = rawPlaylistId;
  let token: string | null = null;
  if (userId) {
    token = await getUserSpotifyToken(userId);
  }
  if (!token) {
    token = await getAccessToken();
  }

  if (token) {
    // Official Spotify Web API (With user OAuth token, full pagination up to 10k tracks works!)
    try {
      const playlistRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(10000)
      });
      if (playlistRes.ok) {
        const pData: any = await playlistRes.json();
        const tracks: SpotifyTrack[] = [];

        for (const item of pData.tracks?.items || []) {
          const t = item.track;
          if (!t) continue;
          tracks.push({
            id: t.id || Math.random().toString(36).substring(7),
            title: t.name,
            artist: t.artists?.map((a: any) => a.name).join(', ') || 'Unknown Artist',
            album: t.album?.name || '',
            duration_ms: t.duration_ms || 180000,
            cover_url: t.album?.images?.[0]?.url || pData.images?.[0]?.url
          });
        }

        // Fetch remaining pages if playlist has > 100 tracks (e.g. 200, 500, 1000+ songs!)
        let nextUrl: string | null = pData.tracks?.next || null;
        let playlistPages = 0;
        while (nextUrl && playlistPages < 20 && nextUrl.startsWith('https://api.spotify.com/')) {
          playlistPages++;
          try {
            const nextRes = await fetch(nextUrl, {
              headers: { 'Authorization': `Bearer ${token}` },
              signal: AbortSignal.timeout(10000)
            });
            if (!nextRes.ok) break;
            const nextData: any = await nextRes.json();
            for (const item of nextData.items || []) {
              const t = item.track;
              if (!t) continue;
              tracks.push({
                id: t.id || Math.random().toString(36).substring(7),
                title: t.name,
                artist: t.artists?.map((a: any) => a.name).join(', ') || 'Unknown Artist',
                album: t.album?.name || '',
                duration_ms: t.duration_ms || 180000,
                cover_url: t.album?.images?.[0]?.url || pData.images?.[0]?.url
              });
              if (tracks.length >= 2000) break;
            }
            if (tracks.length >= 2000) break;
            nextUrl = nextData.next || null;
          } catch (pageErr: any) {
            console.warn('[Spotify pagination error]:', pageErr.message);
            break;
          }
        }

        if (tracks.length > 0) {
          return {
            name: pData.name || 'Spotify Playlist',
            description: pData.description || '',
            cover_url: pData.images?.[0]?.url,
            tracks
          };
        }
      }
    } catch (e: any) {
      console.warn('[Spotify API error, falling back to embed parser]:', e.message);
    }
  }

  // Fallback: Embed scraper (Zero API keys required!)
  const embedUrl = `https://open.spotify.com/embed/playlist/${playlistId}`;
  const res = await fetch(embedUrl, {
    signal: AbortSignal.timeout(10000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  if (!res.ok) {
    throw new Error(`Не удалось загрузить плейлист Spotify (${res.status})`);
  }

  const html = await res.text();
  
  // Extract JSON payload embedded inside <script id="__NEXT_DATA__"> or resource data
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const entity = nextData.props?.pageProps?.state?.data?.entity;
      if (entity) {
        const entityCover = extractEntityCoverUrl(entity);
        const tracks: SpotifyTrack[] = (entity.trackList || []).map((t: any) => {
          const spId = t.uri ? t.uri.split(':').pop() : (t.id || Math.random().toString(36).substring(7));
          return {
            id: spId,
            title: t.title || t.name,
            artist: (t.subtitle ? t.subtitle.replace(/\u00a0/g, ' ') : (t.artists?.map((a: any) => a.name).join(', '))) || 'Unknown Artist',
            album: t.album?.name || (entity.type === 'album' ? entity.title : '') || '',
            duration_ms: t.duration || 180000,
            cover_url: extractEntityCoverUrl(t) || (entity.type === 'album' ? entityCover : '')
          };
        });

        return {
          name: entity.title || 'Spotify Playlist',
          description: entity.subtitle || '',
          cover_url: entityCover,
          tracks
        };
      }
    } catch (e) {
      // Continue to regex fallback
    }
  }

  // Fallback 2: Regex extraction of Spotify oEmbed
  const oembedRes = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/playlist/${playlistId}`, {
    signal: AbortSignal.timeout(8000)
  });
  let name = 'Spotify Playlist';
  let cover_url = '';
  if (oembedRes.ok) {
    const oembedData: any = await oembedRes.json();
    name = oembedData.title || name;
    cover_url = oembedData.thumbnail_url || '';
  }

  return {
    name,
    description: 'Импортировано из Spotify',
    cover_url,
    tracks: []
  };
}

export interface SpotifyTrackDetails {
  title?: string;
  cover_url?: string;
  album?: string;
  artist?: string;
  duration_ms?: number;
}

interface TrackDetailsCacheEntry {
  data: SpotifyTrackDetails;
  expires: number;
}
const spotifyTrackDetailsCache = new Map<string, TrackDetailsCacheEntry>();
const TRACK_DETAILS_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_TRACK_DETAILS_CACHE_SIZE = 2000;

function pruneTrackDetailsCache() {
  if (spotifyTrackDetailsCache.size > MAX_TRACK_DETAILS_CACHE_SIZE) {
    const now = Date.now();
    for (const [k, v] of spotifyTrackDetailsCache.entries()) {
      if (now > v.expires) {
        spotifyTrackDetailsCache.delete(k);
      }
    }
    if (spotifyTrackDetailsCache.size > MAX_TRACK_DETAILS_CACHE_SIZE) {
      let toRemove = spotifyTrackDetailsCache.size - Math.floor(MAX_TRACK_DETAILS_CACHE_SIZE * 0.8);
      for (const k of spotifyTrackDetailsCache.keys()) {
        spotifyTrackDetailsCache.delete(k);
        if (--toRemove <= 0) break;
      }
    }
  }
}

export async function resolveSpotifyTrackDetails(trackId: string): Promise<SpotifyTrackDetails> {
  const result: SpotifyTrackDetails = {};
  if (!trackId || !/^[a-zA-Z0-9]{15,30}$/.test(trackId)) return result;

  const cached = spotifyTrackDetailsCache.get(trackId);
  if (cached && Date.now() < cached.expires) {
    return { ...cached.data };
  }

  try {
    const token = await getAccessToken();
    if (token) {
      const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const data: any = await res.json();
        result.title = data.name;
        result.cover_url = data.album?.images?.[0]?.url;
        result.album = data.album?.name;
        result.artist = data.artists?.map((a: any) => a.name).join(', ');
        result.duration_ms = data.duration_ms;
        return result;
      }
    }
  } catch (e) {}

  // Fallback 1: Spotify Embed Track page (__NEXT_DATA__) - provides artist, duration, cover_url without API keys
  try {
    const embedRes = await fetch(`https://open.spotify.com/embed/track/${trackId}`, {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (embedRes.ok) {
      const html = await embedRes.text();
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (nextDataMatch) {
        const nextData = JSON.parse(nextDataMatch[1]);
        const entity = nextData.props?.pageProps?.state?.data?.entity;
        if (entity) {
          result.title = entity.title || entity.name;
          result.artist = (entity.artists?.map((a: any) => a.name).join(', ')) ||
            (entity.subtitle ? entity.subtitle.replace(/\u00a0/g, ' ') : undefined);
          result.duration_ms = entity.duration;
          result.cover_url = extractEntityCoverUrl(entity);
          if (result.title && result.artist) {
            return result;
          }
        }
      }
    }
  } catch (e) {}

  try {
    const oembedRes = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${trackId}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (oembedRes.ok) {
      const data: any = await oembedRes.json();
      if (!result.title) result.title = data.title;
      if (data.thumbnail_url && !result.cover_url) {
        result.cover_url = data.thumbnail_url.replace('00001e02', '0000b273');
      }
    }
  } catch (e) {}

  if (result.title || result.cover_url) {
    pruneTrackDetailsCache();
    spotifyTrackDetailsCache.set(trackId, {
      data: { ...result },
      expires: Date.now() + TRACK_DETAILS_CACHE_TTL_MS
    });
  }

  return result;
}

export interface DeezerInfoResult {
  cover_url?: string;
  album?: string;
  duration?: number;
  isrc?: string;
  preview?: string;
}

const deezerInfoCache = new Map<string, { data: DeezerInfoResult; expires: number }>();
const MAX_DEEZER_CACHE_SIZE = 2000;

function pruneDeezerCache() {
  if (deezerInfoCache.size > MAX_DEEZER_CACHE_SIZE) {
    const now = Date.now();
    for (const [k, v] of deezerInfoCache.entries()) {
      if (now > v.expires) {
        deezerInfoCache.delete(k);
      }
    }
    if (deezerInfoCache.size > MAX_DEEZER_CACHE_SIZE) {
      let toRemove = deezerInfoCache.size - Math.floor(MAX_DEEZER_CACHE_SIZE * 0.8);
      for (const k of deezerInfoCache.keys()) {
        deezerInfoCache.delete(k);
        if (--toRemove <= 0) break;
      }
    }
  }
}

function generateDeezerCandidateQueries(artist: string, title: string): string[] {
  const queries: string[] = [];

  const cleanTitle = title
    .replace(/\s*\((feat\.|ft\.|with|remix|acoustic|radio edit|deluxe|version)[^)]*\)/gi, '')
    .replace(/\s*\[(feat\.|ft\.|with|remix|acoustic|radio edit|deluxe|version)[^\]]*\]/gi, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .trim() || title;

  const artistParts = artist
    .split(/,|;|\bfeat\.?\b|\bft\.?\b|\bvs\.?\b|\bwith\b/i)
    .map(a => a.trim())
    .filter(Boolean);

  const primaryArtist = artistParts[0] || artist;
  const firstArtist = primaryArtist.split(/\s+&\s+/)[0]?.trim() || primaryArtist;

  // 1. Primary artist + clean title (e.g. "MiyaGi Untouchable")
  queries.push(`${primaryArtist} ${cleanTitle}`.trim());

  // 2. First artist + clean title (if primary had &)
  if (firstArtist !== primaryArtist) {
    queries.push(`${firstArtist} ${cleanTitle}`.trim());
  }

  // 3. Full artist + clean title
  if (artist !== primaryArtist) {
    queries.push(`${artist} ${cleanTitle}`.trim());
  }

  // 4. Primary artist + full title
  if (title !== cleanTitle) {
    queries.push(`${primaryArtist} ${title}`.trim());
  }

  // 5. Clean title + primary artist
  queries.push(`${cleanTitle} ${primaryArtist}`.trim());

  // 6. Clean title alone (if distinct enough)
  if (cleanTitle.length >= 4) {
    queries.push(cleanTitle);
  }

  return [...new Set(queries.filter(q => q.length > 0))];
}

export async function resolveDeezerTrackInfo(artist: string, title: string): Promise<DeezerInfoResult> {
  const cacheKey = `${artist.toLowerCase()}:::${title.toLowerCase()}`;
  const cached = deezerInfoCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }

  const queries = generateDeezerCandidateQueries(artist, title);

  const tryQuery = async (query: string): Promise<DeezerInfoResult | null> => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}`, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data: any = await res.json();
      const items = data.data || [];
      if (!items.length) return null;

      // Prefer item with preview
      const itemWithPreview = items.find((it: any) => it.preview) || items[0];
      if (!itemWithPreview) return null;

      return {
        cover_url: itemWithPreview.album?.cover_xl || itemWithPreview.album?.cover_big || itemWithPreview.album?.cover_medium,
        album: itemWithPreview.album?.title,
        duration: itemWithPreview.duration,
        isrc: itemWithPreview.isrc,
        preview: itemWithPreview.preview || undefined
      };
    } catch {
      return null;
    }
  };

  // 1. Run top 3 candidates concurrently in parallel (~150-250ms)
  const batch1 = queries.slice(0, 3);
  const results1 = await Promise.allSettled(batch1.map(q => tryQuery(q)));
  for (const r of results1) {
    if (r.status === 'fulfilled' && r.value?.preview) {
      pruneDeezerCache();
      deezerInfoCache.set(cacheKey, { data: r.value, expires: Date.now() + 3600000 });
      return r.value;
    }
  }

  // 2. If none had preview, try remaining candidates
  const batch2 = queries.slice(3, 6);
  if (batch2.length > 0) {
    const results2 = await Promise.allSettled(batch2.map(q => tryQuery(q)));
    for (const r of results2) {
      if (r.status === 'fulfilled' && r.value?.preview) {
        pruneDeezerCache();
        deezerInfoCache.set(cacheKey, { data: r.value, expires: Date.now() + 3600000 });
        return r.value;
      }
    }
  }

  // 3. Fallback: if no preview found anywhere, return best metadata found
  for (const r of results1) {
    if (r.status === 'fulfilled' && r.value) {
      pruneDeezerCache();
      deezerInfoCache.set(cacheKey, { data: r.value, expires: Date.now() + 1800000 });
      return r.value;
    }
  }

  return {};
}

export async function resolveSpotifyTrackCover(trackId: string): Promise<string | undefined> {
  const details = await resolveSpotifyTrackDetails(trackId);
  return details.cover_url;
}

export async function searchDeezerTracks(query: string, limit: number = 8): Promise<SpotifyTrack[]> {
  try {
    const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=${limit}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    const tracks: SpotifyTrack[] = [];
    for (const item of data.data || []) {
      if (!item || !item.id || !item.title) continue;
      tracks.push({
        id: `dz_${item.id}`,
        title: item.title,
        artist: item.artist?.name || 'Unknown Artist',
        album: item.album?.title || '',
        duration_ms: (item.duration || 180) * 1000,
        cover_url: item.album?.cover_xl || item.album?.cover_big || item.album?.cover_medium || ''
      });
    }
    return tracks;
  } catch (err: any) {
    console.warn('[Deezer Search Error]', err.message);
    return [];
  }
}

export async function searchItunesTracks(query: string, limit: number = 8): Promise<SpotifyTrack[]> {
  try {
    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=${limit}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    const tracks: SpotifyTrack[] = [];
    for (const item of data.results || []) {
      if (!item || !item.trackId || !item.trackName) continue;
      let cover = item.artworkUrl100 || '';
      if (cover) {
        cover = cover.replace('100x100bb.jpg', '600x600bb.jpg');
      }
      tracks.push({
        id: `it_${item.trackId}`,
        title: item.trackName,
        artist: item.artistName || 'Unknown Artist',
        album: item.collectionName || '',
        duration_ms: item.trackTimeMillis || 180000,
        cover_url: cover
      });
    }
    return tracks;
  } catch (err: any) {
    console.warn('[iTunes Search Error]', err.message);
    return [];
  }
}

interface SearchCacheEntry {
  results: SpotifyTrack[];
  expires: number;
}
const searchCache = new Map<string, SearchCacheEntry>();
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SEARCH_CACHE_SIZE = 1000;

function pruneSearchCache() {
  if (searchCache.size > MAX_SEARCH_CACHE_SIZE) {
    const now = Date.now();
    for (const [k, v] of searchCache.entries()) {
      if (now > v.expires) {
        searchCache.delete(k);
      }
    }
    if (searchCache.size > MAX_SEARCH_CACHE_SIZE) {
      let toRemove = searchCache.size - Math.floor(MAX_SEARCH_CACHE_SIZE * 0.8);
      for (const k of searchCache.keys()) {
        searchCache.delete(k);
        if (--toRemove <= 0) break;
      }
    }
  }
}

export async function searchExternalTracks(query: string, limit: number = 8, userId?: number): Promise<SpotifyTrack[]> {
  const cleanQ = (query || '').trim();
  if (!cleanQ) return [];

  const cacheKey = `${userId || 0}:::${limit}:::${cleanQ.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) {
    return cached.results.map(t => ({ ...t }));
  }

  const results: SpotifyTrack[] = [];
  const seenKeys = new Set<string>();

  const addUnique = (list: SpotifyTrack[]) => {
    for (const t of list) {
      if (!t.title || !t.artist) continue;
      const key = `${t.title.toLowerCase().trim()} - ${t.artist.toLowerCase().trim()}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        results.push(t);
        if (results.length >= limit) break;
      }
    }
  };

  // 1. Try Spotify if user has connected token or client credentials
  try {
    let token = userId ? await getUserSpotifyToken(userId) : null;
    if (!token) {
      token = await getAccessToken();
    }
    if (token) {
      const res = await fetch(`https://api.spotify.com/v1/search?type=track&limit=${limit}&q=${encodeURIComponent(cleanQ)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(4000)
      });
      if (res.ok) {
        const data: any = await res.json();
        const spotifyList: SpotifyTrack[] = [];
        for (const t of data.tracks?.items || []) {
          if (!t) continue;
          spotifyList.push({
            id: t.id,
            title: t.name,
            artist: t.artists?.map((a: any) => a.name).join(', ') || 'Unknown Artist',
            album: t.album?.name || '',
            duration_ms: t.duration_ms || 180000,
            cover_url: t.album?.images?.[0]?.url || ''
          });
        }
        addUnique(spotifyList);
      }
    }
  } catch (_) {}

  // 2. If Spotify returned insufficient results (or 403 Forbidden), query Deezer API (open, no auth, 100M+ tracks)
  if (results.length < limit) {
    const dzList = await searchDeezerTracks(cleanQ, limit);
    addUnique(dzList);
  }

  // 3. If still below limit, query Apple Music / iTunes API
  if (results.length < limit) {
    const itunesList = await searchItunesTracks(cleanQ, limit);
    addUnique(itunesList);
  }

  const finalResults = results.slice(0, limit);
  if (finalResults.length > 0) {
    pruneSearchCache();
    searchCache.set(cacheKey, {
      results: finalResults,
      expires: Date.now() + SEARCH_CACHE_TTL_MS
    });
  }

  return finalResults;
}

export async function searchSpotifyTracks(query: string, limit: number = 8, userId?: number): Promise<SpotifyTrack[]> {
  return await searchExternalTracks(query, limit, userId);
}

export async function fetchSpotifyLikedSongs(userId: number): Promise<SpotifyPlaylistData> {
  const token = await getUserSpotifyToken(userId);
  if (!token) {
    throw new Error('Требуется подключить аккаунт Spotify в настройках для загрузки любимых треков');
  }

  const tracks: SpotifyTrack[] = [];
  let nextUrl: string | null = 'https://api.spotify.com/v1/me/tracks?limit=50';

  let likedPages = 0;
  while (nextUrl && likedPages < 40 && nextUrl.startsWith('https://api.spotify.com/')) {
    likedPages++;
    const res = await fetch(nextUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ошибка загрузки любимых треков (${res.status}): ${err}`);
    }
    const data: any = await res.json();
    for (const item of data.items || []) {
      const t = item.track;
      if (!t) continue;
      tracks.push({
        id: t.id || Math.random().toString(36).substring(7),
        title: t.name,
        artist: t.artists?.map((a: any) => a.name).join(', ') || 'Unknown Artist',
        album: t.album?.name || '',
        duration_ms: t.duration_ms || 180000,
        cover_url: t.album?.images?.[0]?.url || ''
      });
    }
    nextUrl = data.next || null;
  }

  return {
    name: 'Любимые треки',
    description: 'Импортировано из Spotify Liked Songs',
    cover_url: tracks[0]?.cover_url || '',
    tracks
  };
}

export interface SpotifyUserPlaylistInfo {
  id: string;
  name: string;
  description: string;
  cover_url?: string;
  track_count: number;
}

export async function fetchSpotifyUserPlaylists(userId: number): Promise<SpotifyUserPlaylistInfo[]> {
  const token = await getUserSpotifyToken(userId);
  if (!token) {
    throw new Error('Требуется подключить аккаунт Spotify в настройках для загрузки плейлистов');
  }

  const playlists: SpotifyUserPlaylistInfo[] = [];
  let nextUrl: string | null = 'https://api.spotify.com/v1/me/playlists?limit=50';

  let likedPages = 0;
  while (nextUrl && likedPages < 40 && nextUrl.startsWith('https://api.spotify.com/')) {
    likedPages++;
    const res = await fetch(nextUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ошибка загрузки плейлистов Spotify (${res.status}): ${err}`);
    }
    const data: any = await res.json();
    for (const item of data.items || []) {
      if (!item || !item.id) continue;
      playlists.push({
        id: item.id,
        name: item.name || 'Unnamed Playlist',
        description: item.description || '',
        cover_url: item.images?.[0]?.url || '',
        track_count: item.tracks?.total || 0
      });
    }
    nextUrl = data.next || null;
  }

  return playlists;
}

export async function parseTrackListText(text: string, userId?: number): Promise<SpotifyTrack[]> {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'))
    .slice(0, 500);

  const rawTracks: SpotifyTrack[] = [];
  const token = (userId ? await getUserSpotifyToken(userId) : null) || await getAccessToken();
  let complexEntitiesCount = 0;
  let resolvedSingleTrackCount = 0;
  const MAX_SINGLE_TRACK_RESOLVES = 40;

  for (const line of lines) {
    if (rawTracks.length >= 500) break;

    // 1. Check if line contains any Spotify URL/URI (track, album, playlist, artist, or short link)
    const entity = await resolveSpotifyEntityInput(line);
    if (entity) {
      try {
        if (entity.type === 'track') {
          if (resolvedSingleTrackCount >= MAX_SINGLE_TRACK_RESOLVES) {
            console.warn(`[parseTrackListText] Skipping track entity (${entity.id}): resolve limit reached (${MAX_SINGLE_TRACK_RESOLVES})`);
            continue;
          }
          resolvedSingleTrackCount++;
          const trackId = entity.id;
          if (token) {
            const sRes = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
              headers: { 'Authorization': `Bearer ${token}` },
              signal: AbortSignal.timeout(8000)
            });
            if (sRes.ok) {
              const sData: any = await sRes.json();
              rawTracks.push({
                id: sData.id,
                title: sData.name,
                artist: sData.artists?.map((a: any) => a.name).join(', ') || 'Unknown Artist',
                album: sData.album?.name || '',
                duration_ms: sData.duration_ms || 180000,
                cover_url: sData.album?.images?.[0]?.url || ''
              });
              continue;
            }
          }
          const d = await resolveSpotifyTrackDetails(trackId);
          if (d.title) {
            rawTracks.push({
              id: trackId,
              title: d.title,
              artist: d.artist || 'Unknown Artist',
              album: d.album || '',
              duration_ms: d.duration_ms || 180000,
              cover_url: d.cover_url || ''
            });
          }
          continue;
        } else if (entity.type === 'album') {
          if (complexEntitiesCount >= 5 || rawTracks.length >= 500) {
            console.warn(`[parseTrackListText] Skipping complex entity ${entity.type} (${entity.id}): limit reached`);
            continue;
          }
          complexEntitiesCount++;
          const albumData = await fetchSpotifyAlbum(entity.id, userId);
          rawTracks.push(...(albumData.tracks || []).slice(0, 500 - rawTracks.length));
          continue;
        } else if (entity.type === 'playlist') {
          if (complexEntitiesCount >= 5 || rawTracks.length >= 500) {
            console.warn(`[parseTrackListText] Skipping complex entity ${entity.type} (${entity.id}): limit reached`);
            continue;
          }
          complexEntitiesCount++;
          const plData = await fetchSpotifyPlaylist(entity.id, userId);
          rawTracks.push(...(plData.tracks || []).slice(0, 500 - rawTracks.length));
          continue;
        } else if (entity.type === 'artist') {
          if (complexEntitiesCount >= 5 || rawTracks.length >= 500) {
            console.warn(`[parseTrackListText] Skipping complex entity ${entity.type} (${entity.id}): limit reached`);
            continue;
          }
          complexEntitiesCount++;
          const artistData = await fetchSpotifyArtistTopTracks(entity.id, userId);
          rawTracks.push(...(artistData.tracks || []).slice(0, 500 - rawTracks.length));
          continue;
        }
      } catch (err: any) {
        console.warn(`[parseTrackListText] Failed to resolve Spotify ${entity.type} (${entity.id}):`, err.message);
        continue;
      }
    }

    // 2. Strict URL guard: NEVER parse raw URLs or URIs as "Unknown Artist - https://..."
    const cleanLine = line.replace(/^\d+[\.\)\-\s]+/, '').trim(); // Remove leading numbering
    if (/https?:\/\/|^www\.|^spotify:/i.test(cleanLine) || /https?:\/\//i.test(line)) {
      console.warn(`[parseTrackListText] Skipping unrecognized URL line: "${line}"`);
      continue;
    }

    // 3. Parse text formats:
    // "Artist - Title", "Artist — Title", "Artist: Title"
    let artist = 'Unknown Artist';
    let title = cleanLine;

    if (cleanLine.includes(' - ')) {
      const parts = cleanLine.split(' - ');
      artist = parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    } else if (cleanLine.includes(' — ')) {
      const parts = cleanLine.split(' — ');
      artist = parts[0].trim();
      title = parts.slice(1).join(' — ').trim();
    } else if (cleanLine.includes(': ')) {
      const parts = cleanLine.split(': ');
      artist = parts[0].trim();
      title = parts.slice(1).join(': ').trim();
    }

    if (title && !/https?:\/\//i.test(title) && !/https?:\/\//i.test(artist)) {
      rawTracks.push({
        id: Math.random().toString(36).substring(2, 12),
        title,
        artist,
        album: '',
        duration_ms: 180000,
        cover_url: ''
      });
    }
  }

  // Deduplicate tracks while preserving order
  const seen = new Set<string>();
  const tracks: SpotifyTrack[] = [];
  for (const t of rawTracks) {
    const idKey = t.id && t.id.length >= 15 ? `sp:${t.id}` : '';
    const nameKey = `name:${(t.title || '').toLowerCase().trim()}|${(t.artist || '').toLowerCase().trim()}`;
    if ((idKey && seen.has(idKey)) || seen.has(nameKey)) continue;
    if (idKey) seen.add(idKey);
    seen.add(nameKey);
    tracks.push(t);
  }

  return tracks;
}


