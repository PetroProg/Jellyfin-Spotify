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

        // Fetch remaining pages if playlist has > 100 tracks (e.g. 200+ songs)
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
      if (data.thumbnail_url) {
        result.cover_url = data.thumbnail_url.replace('00001e02', '0000b273');
      }
    }
  } catch (e) {}

  return result;
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
