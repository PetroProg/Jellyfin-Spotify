export interface User {
  id: number;
  username: string;
  display_name: string;
  created_at?: string;
  settings?: Record<string, string>;
}

export interface Track {
  id: number;
  title: string;
  artist: string;
  album?: string;
  duration_ms: number;
  cover_url?: string;
  added_at?: string;
  position?: number;
  spotify_id?: string;
  streamUrl?: string;
  isPreview?: boolean;
}

export interface Playlist {
  id: number;
  name: string;
  description?: string;
  cover_url?: string;
  track_count?: number;
  created_at: string;
  is_daily_mix?: number;
  daily_mix_category?: string;
  daily_mix_number?: number;
  daily_mix_date?: string;
  category_title?: string;
  category_badge?: string;
  accent_color?: string;
  seed_artists?: string[];
  activeJob?: DownloadJob | null;
  version?: string;
}

export interface DownloadJob {
  id: string;
  playlist_id: number;
  playlist_name: string;
  total_tracks: number;
  downloaded_tracks: number;
  current_track?: string;
  status: 'pending' | 'downloading' | 'completed' | 'failed';
  error?: string;
  created_at: string;
}

export interface BlacklistItem {
  id: number;
  title: string;
  artist: string;
  created_at: string;
}

export type RepeatMode = 'off' | 'all' | 'one';

export interface SpotifySearchResult {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration_ms: number;
  cover_url: string;
  is_downloaded: boolean;
  local_track_id: number | null;
  local_track?: Track | null;
}
