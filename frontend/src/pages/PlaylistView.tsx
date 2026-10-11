import React, { useState, useEffect } from 'react';
import { ArrowUpDown, ArrowLeft } from 'lucide-react';
import { Playlist, Track } from '../types';
import { apiRequest } from '../api/client';
import { PlaylistHeader } from '../components/PlaylistHeader';
import { TrackRow } from '../components/TrackRow';
import { ContextMenu } from '../components/ContextMenu';
import { usePlayerStore } from '../store/playerStore';

interface PlaylistViewProps {
  playlistId: number;
  onBack?: () => void;
}

type SortField = 'position' | 'title' | 'artist' | 'date' | 'duration';

export const PlaylistView: React.FC<PlaylistViewProps> = ({ playlistId, onBack }) => {
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortField, setSortField] = useState<SortField>('position');
  const [sortAsc, setSortAsc] = useState(true);
  const [menuState, setMenuState] = useState<{ track: Track; pos: { x: number; y: number } } | null>(null);

  const { playTrack, toggleShuffle, addToQueue } = usePlayerStore();

  const loadData = async () => {
    try {
      const data = await apiRequest<{ playlist: Playlist; tracks: Track[] }>(`/playlists/${playlistId}`);
      setPlaylist(data.playlist);
      setTracks(data.tracks || []);
    } catch (e: any) {
      console.warn(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [playlistId]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const sortedTracks = [...tracks].sort((a, b) => {
    let comp = 0;
    if (sortField === 'title') comp = a.title.localeCompare(b.title);
    else if (sortField === 'artist') comp = a.artist.localeCompare(b.artist);
    else if (sortField === 'duration') comp = a.duration_ms - b.duration_ms;
    else if (sortField === 'date') comp = (a.added_at || '').localeCompare(b.added_at || '');
    else comp = (a.position || 0) - (b.position || 0);

    return sortAsc ? comp : -comp;
  });

  const handleBlacklist = async (track: Track) => {
    try {
      await apiRequest('/blacklist', {
        method: 'POST',
        body: JSON.stringify({ title: track.title, artist: track.artist })
      });
      setTracks(prev => prev.filter(t => t.id !== track.id));
    } catch (e) {
      console.warn(e);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-cat-subtext0">
        Загрузка плейлиста...
      </div>
    );
  }

  if (!playlist) {
    return (
      <div className="flex-1 flex items-center justify-center text-cat-subtext0">
        Плейлист не найден
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 md:px-8 py-4 pb-28 md:pb-24 select-none custom-scrollbar">
      {onBack && (
        <button
          onClick={onBack}
          className="md:hidden flex items-center gap-1.5 text-xs text-cat-subtext0 mb-3 hover:text-cat-text"
        >
          <ArrowLeft className="w-4 h-4" /> Назад
        </button>
      )}

      <PlaylistHeader
        playlist={playlist}
        tracks={sortedTracks}
        onPlayAll={() => sortedTracks.length > 0 && playTrack(sortedTracks[0], sortedTracks, 0)}
        onShuffleAll={() => {
          if (sortedTracks.length > 0) {
            playTrack(sortedTracks[0], sortedTracks, 0);
            toggleShuffle();
          }
        }}
      />

      {/* Sorting / Table Header */}
      <div className="border-b border-cat-surface0/60 pb-2 mb-2 flex items-center justify-between text-xs font-semibold text-cat-subtext0 px-3">
        <div className="flex items-center gap-4 flex-1">
          <span className="w-6 text-center">#</span>
          <button
            onClick={() => handleSort('title')}
            className="flex items-center gap-1 hover:text-cat-text transition-colors"
          >
            Название <ArrowUpDown className="w-3 h-3" />
          </button>
        </div>

        <div className="hidden lg:flex items-center w-1/4">
          <button
            onClick={() => handleSort('artist')}
            className="flex items-center gap-1 hover:text-cat-text transition-colors"
          >
            Исполнитель <ArrowUpDown className="w-3 h-3" />
          </button>
        </div>

        <div className="flex items-center gap-6">
          <button
            onClick={() => handleSort('duration')}
            className="flex items-center gap-1 hover:text-cat-text transition-colors"
          >
            Время <ArrowUpDown className="w-3 h-3" />
          </button>
          <span className="w-7" />
        </div>
      </div>

      {/* Tracks List */}
      <div className="space-y-0.5">
        {sortedTracks.length === 0 ? (
          <div className="py-12 text-center text-cat-subtext0 text-sm">
            В этом плейлисте пока нет треков
          </div>
        ) : (
          sortedTracks.map((track, i) => (
            <TrackRow
              key={`${track.id}-${i}`}
              track={track}
              index={i}
              onPlay={() => playTrack(track, sortedTracks, i)}
              onOpenMenu={(e, t) => setMenuState({ track: t, pos: { x: e.clientX, y: e.clientY } })}
            />
          ))
        )}
      </div>

      {/* Context Menu Modal */}
      {menuState && (
        <ContextMenu
          track={menuState.track}
          position={menuState.pos}
          onClose={() => setMenuState(null)}
          onAddToQueue={(t) => addToQueue(t)}
          onBlacklist={handleBlacklist}
        />
      )}
    </div>
  );
};
