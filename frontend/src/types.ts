export interface User {
  id: number;
  username: string;
  display_name: string;
  created_at?: string;
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
}

export interface Playlist {
  id: number;
  name: string;
  description?: string;
  cover_url?: string;
  track_count?: number;
  created_at: string;
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
