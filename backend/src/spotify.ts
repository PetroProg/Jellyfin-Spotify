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

export function extractPlaylistId(url: string): string | null {
  const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

export async function fetchSpotifyPlaylist(urlOrId: string): Promise<SpotifyPlaylistData> {
  const playlistId = extractPlaylistId(urlOrId) || urlOrId;
  const token = await getAccessToken();

  if (token) {
    // Official Spotify Web API
    try {
      const playlistRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (playlistRes.ok) {
        const pData: any = await playlistRes.json();
        const tracks: SpotifyTrack[] = [];

        for (const item of pData.tracks.items) {
          const t = item.track;
          if (!t) continue;
          tracks.push({
            id: t.id || Math.random().toString(36).substring(7),
            title: t.name,
            artist: t.artists.map((a: any) => a.name).join(', '),
            album: t.album?.name || '',
            duration_ms: t.duration_ms || 180000,
            cover_url: t.album?.images?.[0]?.url || pData.images?.[0]?.url
          });
        }

        return {
          name: pData.name || 'Spotify Playlist',
          description: pData.description || '',
          cover_url: pData.images?.[0]?.url,
          tracks
        };
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
            artist: t.subtitle || (t.artists?.map((a: any) => a.name).join(', ')) || 'Unknown Artist',
            album: entity.title || '',
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

export async function resolveSpotifyTrackCover(trackId: string): Promise<string | undefined> {
  if (!trackId) return undefined;
  // 1. Try Spotify Web API if credentials configured
  try {
    const token = await getAccessToken();
    if (token) {
      const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data: any = await res.json();
        const img = data.album?.images?.[0]?.url;
        if (img) return img;
      }
    }
  } catch (e) {}

  // 2. Fallback to Spotify oEmbed
  try {
    const oembedRes = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${trackId}`);
    if (oembedRes.ok) {
      const data: any = await oembedRes.json();
      if (data.thumbnail_url) {
        return data.thumbnail_url.replace('00001e02', '0000b273');
      }
    }
  } catch (e) {}

  return undefined;
}
