import { db } from './db';

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

async function getAccessToken(): Promise<string | null> {
  const { clientId, clientSecret } = getSpotifyCredentials();
  if (!clientId || !clientSecret) return null;

  if (spotifyAccessToken && Date.now() < tokenExpiresAt) {
    return spotifyAccessToken;
  }

  try {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
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
  }
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
        }).toString()
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

  const statePayload = Buffer.from(JSON.stringify({ userId, origin, redirectUri })).toString('base64url');

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
    const parsed = JSON.parse(Buffer.from(stateStr, 'base64url').toString('utf-8'));
    userId = parsed.userId;
    origin = parsed.origin || '';
    redirectUri = parsed.redirectUri;
  } catch (e: any) {
    throw new Error('Неверный параметр state в ответе Spotify');
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
    }).toString()
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
      headers: { 'Authorization': `Bearer ${accessToken}` }
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

export function extractPlaylistId(url: string): string | null {
  const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

export async function fetchSpotifyPlaylist(urlOrId: string, userId?: number): Promise<SpotifyPlaylistData> {
  const playlistId = extractPlaylistId(urlOrId) || urlOrId;
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
        headers: { 'Authorization': `Bearer ${token}` }
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
        while (nextUrl) {
          try {
            const nextRes = await fetch(nextUrl, {
              headers: { 'Authorization': `Bearer ${token}` }
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
            }
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
        const tracks: SpotifyTrack[] = (entity.trackList || []).map((t: any) => {
          const spId = t.uri ? t.uri.split(':').pop() : (t.id || Math.random().toString(36).substring(7));
          return {
            id: spId,
            title: t.title || t.name,
            artist: (t.subtitle ? t.subtitle.replace(/\u00a0/g, ' ') : (t.artists?.map((a: any) => a.name).join(', '))) || 'Unknown Artist',
            album: t.album?.name || (entity.type === 'album' ? entity.title : '') || '',
            duration_ms: t.duration || 180000,
            cover_url: ''
          };
        });

        return {
          name: entity.title || 'Spotify Playlist',
          description: entity.subtitle || '',
          cover_url: entity.coverArt?.sources?.[0]?.url,
          tracks
        };
      }
    } catch (e) {
      // Continue to regex fallback
    }
  }

  // Fallback 2: Regex extraction of Spotify oEmbed
  const oembedRes = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/playlist/${playlistId}`);
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
}

export async function resolveSpotifyTrackDetails(trackId: string): Promise<SpotifyTrackDetails> {
  const result: SpotifyTrackDetails = {};
  if (!trackId) return result;

  try {
    const token = await getAccessToken();
    if (token) {
      const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data: any = await res.json();
        result.title = data.name;
        result.cover_url = data.album?.images?.[0]?.url;
        result.album = data.album?.name;
        result.artist = data.artists?.map((a: any) => a.name).join(', ');
        return result;
      }
    }
  } catch (e) {}

  try {
    const oembedRes = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${trackId}`);
    if (oembedRes.ok) {
      const data: any = await oembedRes.json();
      result.title = data.title;
      if (data.thumbnail_url) {
        result.cover_url = data.thumbnail_url.replace('00001e02', '0000b273');
      }
    }
  } catch (e) {}

  return result;
}

export async function resolveDeezerTrackInfo(artist: string, title: string): Promise<{ cover_url?: string; album?: string; duration?: number; isrc?: string }> {
  try {
    const q = encodeURIComponent(`${artist} ${title}`.trim());
    const res = await fetch(`https://api.deezer.com/search?q=${q}`);
    if (!res.ok) return {};
    const data: any = await res.json();
    const item = data.data?.[0];
    if (!item) return {};
    return {
      cover_url: item.album?.cover_xl || item.album?.cover_big || item.album?.cover_medium,
      album: item.album?.title,
      duration: item.duration,
      isrc: item.isrc
    };
  } catch {
    return {};
  }
}

export async function resolveSpotifyTrackCover(trackId: string): Promise<string | undefined> {
  const details = await resolveSpotifyTrackDetails(trackId);
  return details.cover_url;
}

export async function searchSpotifyTracks(query: string, limit: number = 5): Promise<SpotifyTrack[]> {
  const token = await getAccessToken();
  if (!token) return [];

  try {
    const res = await fetch(`https://api.spotify.com/v1/search?type=track&limit=${limit}&q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      console.warn('[Spotify Search HTTP Error]', res.status, res.statusText);
      return [];
    }

    const data: any = await res.json();
    const tracks: SpotifyTrack[] = [];
    for (const t of data.tracks?.items || []) {
      if (!t) continue;
      tracks.push({
        id: t.id,
        title: t.name,
        artist: t.artists?.map((a: any) => a.name).join(', ') || 'Unknown Artist',
        album: t.album?.name || '',
        duration_ms: t.duration_ms || 180000,
        cover_url: t.album?.images?.[0]?.url || ''
      });
    }
    return tracks;
  } catch (err: any) {
    console.warn('[Spotify Search Error]', err.message);
    return [];
  }
}

export async function fetchSpotifyLikedSongs(userId: number): Promise<SpotifyPlaylistData> {
  const token = await getUserSpotifyToken(userId);
  if (!token) {
    throw new Error('Требуется подключить аккаунт Spotify в настройках для загрузки любимых треков');
  }

  const tracks: SpotifyTrack[] = [];
  let nextUrl: string | null = 'https://api.spotify.com/v1/me/tracks?limit=50';

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
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

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
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
    .filter(l => l.length > 0 && !l.startsWith('#'));

  const tracks: SpotifyTrack[] = [];
  const token = (userId ? await getUserSpotifyToken(userId) : null) || await getAccessToken();

  for (const line of lines) {
    // 1. Check if line contains a Spotify Track URL or URI
    const urlMatch = line.match(/track\/([a-zA-Z0-9]+)/) || line.match(/spotify:track:([a-zA-Z0-9]+)/);
    if (urlMatch) {
      const trackId = urlMatch[1];
      try {
        if (token) {
          const sRes = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (sRes.ok) {
            const sData: any = await sRes.json();
            tracks.push({
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
        tracks.push({
          id: trackId,
          title: d.title || 'Track',
          artist: d.artist || 'Unknown Artist',
          album: d.album || '',
          duration_ms: 180000,
          cover_url: d.cover_url || ''
        });
        continue;
      } catch (_) {}
    }

    // 2. Parse text formats:
    // "Artist - Title", "Artist — Title", "Artist: Title"
    const cleanLine = line.replace(/^\d+[\.\)\-\s]+/, '').trim(); // Remove leading numbering

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

    if (title) {
      tracks.push({
        id: Math.random().toString(36).substring(2, 12),
        title,
        artist,
        album: '',
        duration_ms: 180000,
        cover_url: ''
      });
    }
  }

  return tracks;
}


