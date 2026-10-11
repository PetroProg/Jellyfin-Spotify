import React, { useState, useEffect } from 'react';
import { ArrowUpDown, ArrowLeft, Loader2, RefreshCw } from 'lucide-react';
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
  const [activeJob, setActiveJob] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [resuming, setResuming] = useState(false);
  const [sortField, setSortField] = useState<SortField>('position');
  const [sortAsc, setSortAsc] = useState(true);
  const [menuState, setMenuState] = useState<{ track: Track; pos: { x: number; y: number } } | null>(null);

  const { playTrack, toggleShuffle, addToQueue } = usePlayerStore();

  const handleResume = async () => {
    if (resuming) return;
    setResuming(true);
    try {
      await apiRequest(`/playlists/${playlistId}/resume`, { method: 'POST' });
      await loadData();
    } catch (err: any) {
      alert(err.message || 'Ошибка возобновления загрузки');
    } finally {
      setResuming(false);
    }
  };

  const loadData = async () => {
    try {
      const data = await apiRequest<{ playlist: Playlist; tracks: Track[]; activeJob?: any }>(`/playlists/${playlistId}`);
      setPlaylist(data.playlist);
      setTracks(data.tracks || []);
      setActiveJob(data.activeJob || null);
    } catch (e: any) {
      console.warn(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [playlistId]);

  // Auto-refresh when downloads are in progress
  useEffect(() => {
    if (!activeJob || activeJob.status !== 'downloading') return;
    const interval = setInterval(() => {
      loadData();
    }, 3000);
    return () => clearInterval(interval);
  }, [playlistId, activeJob?.status, activeJob?.downloaded_tracks]);

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
        activeJob={activeJob}
        onPlayAll={() => sortedTracks.length > 0 && playTrack(sortedTracks[0], sortedTracks, 0)}
        onShuffleAll={() => {
          if (sortedTracks.length > 0) {
            playTrack(sortedTracks[0], sortedTracks, 0);
            toggleShuffle();
          }
        }}
        onCoverChange={(newUrl) => setPlaylist(prev => prev ? { ...prev, cover_url: newUrl } : null)}
      />

      {/* Live Download Banner */}
      {activeJob && (activeJob.status === 'downloading' || tracks.length < (activeJob.total_tracks || 0)) && (
        <div className="mb-4 p-4 rounded-2xl bg-cat-mantle border border-cat-mauve/40 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2.5 min-w-0">
              {activeJob.status === 'downloading' ? (
                <Loader2 className="w-4 h-4 animate-spin text-cat-mauve shrink-0" />
              ) : (
                <RefreshCw className="w-4 h-4 text-cat-subtext0 shrink-0" />
              )}
              <div className="min-w-0">
                <p className="text-xs font-bold text-cat-text">
                  {activeJob.status === 'downloading'
                    ? 'Идет фоновая загрузка треков в высоком качестве'
                    : 'Загрузка плейлиста была приостановлена'}
                </p>
                <p className="text-[11px] text-cat-subtext0 truncate">
                  {activeJob.status === 'downloading'
                    ? (activeJob.current_track ? `Качается: ${activeJob.current_track}` : 'Поиск и загрузка аудио...')
                    : `Скачано ${tracks.length} из ${activeJob.total_tracks} треков`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2.5 shrink-0 ml-3">
              <span className="text-xs font-black text-cat-mauve">
                {activeJob.downloaded_tracks || tracks.length} / {activeJob.total_tracks}
              </span>
              <button
                onClick={handleResume}
                disabled={resuming}
                title="Возобновить / проверить загрузку"
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cat-surface0 hover:bg-cat-surface1 text-xs text-cat-subtext0 hover:text-cat-text transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${resuming ? 'animate-spin text-cat-mauve' : ''}`} />
                <span className="hidden sm:inline">{resuming ? 'Запуск...' : 'Возобновить'}</span>
              </button>
            </div>
          </div>
          {/* Progress Bar */}
          <div className="w-full bg-cat-surface0 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-cat-mauve h-full rounded-full transition-all duration-500 ease-out"
              style={{
                width: `${Math.max(4, Math.min(100, (((activeJob.downloaded_tracks || tracks.length) || 0) / (activeJob.total_tracks || 1)) * 100))}%`
              }}
            />
          </div>
        </div>
      )}

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
            {activeJob && activeJob.status === 'downloading' ? (
              <div className="flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-6 h-6 animate-spin text-cat-mauve" />
                <p className="font-semibold text-cat-text">Идет загрузка первых треков из Spotify...</p>
                <p className="text-xs text-cat-subtext0">Они появятся в списке автоматически по мере скачивания</p>
              </div>
            ) : (
              'В этом плейлисте пока нет треков'
            )}
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
