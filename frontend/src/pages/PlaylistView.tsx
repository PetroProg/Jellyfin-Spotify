import React, { useState, useEffect, useRef } from 'react';
import { ArrowUpDown, ArrowLeft, Loader2, RefreshCw, ChevronUp } from 'lucide-react';
import { Playlist, Track } from '../types';
import { apiRequest } from '../api/client';
import { PlaylistHeader } from '../components/PlaylistHeader';
import { TrackRow } from '../components/TrackRow';
import { ContextMenu } from '../components/ContextMenu';
import { AddToPlaylistModal } from '../components/AddToPlaylistModal';
import { usePlayerStore } from '../store/playerStore';
import { toast } from '../store/toastStore';
import { useOfflineStore } from '../store/offlineStore';
import { getOfflinePlaylistData, saveOfflinePlaylistData } from '../utils/offline';
import { useI18nStore } from '../store/i18nStore';

interface PlaylistViewProps {
  playlistId: number;
  onBack?: () => void;
  onDeleted?: () => void;
  onRenamed?: () => void;
}

type SortField = 'position' | 'title' | 'artist' | 'album' | 'date' | 'duration';

export const PlaylistView: React.FC<PlaylistViewProps> = ({ playlistId, onBack, onDeleted, onRenamed }) => {
  const { t } = useI18nStore();
  const offlineData = getOfflinePlaylistData(Number(playlistId));
  const [playlist, setPlaylist] = useState<Playlist | null>(offlineData?.playlist || null);
  const [tracks, setTracks] = useState<Track[]>(offlineData?.tracks || []);
  const [activeJob, setActiveJob] = useState<any>(null);
  const [loading, setLoading] = useState(!offlineData?.playlist);
  const [resuming, setResuming] = useState(false);
  const [sortField, setSortField] = useState<SortField>('position');
  const [sortAsc, setSortAsc] = useState(true);
  const [menuState, setMenuState] = useState<{ track: Track; pos: { x: number; y: number } } | null>(null);
  const [addToPlaylistTrack, setAddToPlaylistTrack] = useState<Track | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleScroll = () => {
      setShowScrollTop(el.scrollTop > 200);
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [loading]);

  const scrollToTop = () => {
    containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const { playTrack, shufflePlay, toggleShuffle, addToQueue } = usePlayerStore();

  const handleResume = async () => {
    if (resuming) return;
    setResuming(true);
    try {
      await apiRequest(`/playlists/${playlistId}/resume`, { method: 'POST' });
      toast.info(t('Download resumed', 'Возобновление загрузки начато'));
      await loadData();
    } catch (err: any) {
      toast.error(err.message || t('Failed to resume download', 'Ошибка возобновления загрузки'));
    } finally {
      setResuming(false);
    }
  };

  const loadData = async (silent = false) => {
    try {
      if (!silent && !playlist) setLoading(true);
      const data = await apiRequest<{ playlist: Playlist; tracks: Track[]; activeJob?: any }>(`/playlists/${playlistId}`);
      setPlaylist(data.playlist);
      setTracks(data.tracks || []);
      setActiveJob(data.activeJob || null);
      usePlayerStore.getState().updateQueueIfCurrent(Number(playlistId), data.tracks || []);
      if (useOfflineStore.getState().isDownloaded(Number(playlistId))) {
        saveOfflinePlaylistData(data.playlist, data.tracks || []);
        useOfflineStore.getState().syncPlaylist(Number(playlistId), data.tracks || [], data.playlist);
      }
    } catch (e: any) {
      console.warn('[PlaylistView] Network error or offline, fallback to offline cache:', e);
      const offline = getOfflinePlaylistData(Number(playlistId));
      if (offline && offline.playlist) {
        setPlaylist(offline.playlist);
        setTracks(offline.tracks || []);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [playlistId]);

  // Auto-refresh when downloads are in progress
  useEffect(() => {
    if (!activeJob || (activeJob.status !== 'downloading' && activeJob.status !== 'pending')) return;
    const interval = setInterval(() => {
      loadData(true);
    }, 2500);
    return () => clearInterval(interval);
  }, [playlistId, activeJob?.status, activeJob?.downloaded_tracks, activeJob?.current_track]);

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
    else if (sortField === 'album') comp = (a.album || '').localeCompare(b.album || '');
    else if (sortField === 'duration') comp = a.duration_ms - b.duration_ms;
    else if (sortField === 'date') comp = (a.added_at || '').localeCompare(b.added_at || '');
    else comp = (a.position || 0) - (b.position || 0);

    return sortAsc ? comp : -comp;
  });

  useEffect(() => {
    const handleBlacklisted = (e: any) => {
      const { trackId, title, artist } = e.detail || {};
      setTracks((prev) =>
        prev.filter(
          (t) =>
            t.id !== trackId &&
            !(
              t.title.toLowerCase() === (title || '').toLowerCase() &&
              t.artist.toLowerCase() === (artist || '').toLowerCase()
            )
        )
      );
    };
    window.addEventListener('jellyfy:track_blacklisted', handleBlacklisted);
    return () => window.removeEventListener('jellyfy:track_blacklisted', handleBlacklisted);
  }, []);

  const handleBlacklist = async (track: Track) => {
    try {
      await usePlayerStore.getState().blacklistTrack(track);
      toast.info(
        t(
          `"${track.title}" added to "Never Play" and removed from playlists`,
          `«${track.title}» добавлена в «Никогда не включать» и удалена из плейлистов`
        )
      );
    } catch (e: any) {
      toast.error(e.message || t('Failed to add to blacklist', 'Ошибка добавления в черный список'));
    }
  };

  const handleRemoveTrack = async (track: Track) => {
    try {
      await apiRequest(`/playlists/${playlistId}/tracks/${track.id}`, { method: 'DELETE' });
      setTracks(prev => prev.filter(t => t.id !== track.id));
      toast.success(t('Track removed from playlist', 'Трек удален из плейлиста'));
    } catch (e: any) {
      toast.error(e.message || t('Failed to remove track from playlist', 'Ошибка удаления трека из плейлиста'));
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-cat-subtext0">
        {t('Loading playlist...', 'Загрузка плейлиста...')}
      </div>
    );
  }

  if (!playlist) {
    return (
      <div className="flex-1 flex items-center justify-center text-cat-subtext0">
        {t('Playlist not found', 'Плейлист не найден')}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={(e) => setShowScrollTop(e.currentTarget.scrollTop > 200)}
      className="flex-1 w-full max-w-full overflow-y-auto overflow-x-hidden px-4 md:px-8 py-4 pb-28 md:pb-24 select-none custom-scrollbar"
    >
      {onBack && (
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-cat-surface0/80 hover:bg-cat-surface1 border border-cat-surface1/50 text-sm font-semibold text-cat-subtext0 hover:text-cat-text transition-all duration-200 mb-4 cursor-pointer active:scale-95 group shadow-sm w-fit"
          title={t('Go back', 'Вернуться назад')}
        >
          <ArrowLeft className="w-4 h-4 text-cat-mauve transition-transform group-hover:-translate-x-1" />
          <span>{t('Back', 'Назад')}</span>
        </button>
      )}

      <PlaylistHeader
        playlist={playlist}
        tracks={sortedTracks}
        activeJob={activeJob}
        onPlayAll={() => sortedTracks.length > 0 && playTrack(sortedTracks[0], sortedTracks, 0, Number(playlistId))}
        onShuffleAll={() => {
          if (sortedTracks.length > 0) {
            shufflePlay(sortedTracks, Number(playlistId));
          }
        }}
        onCoverChange={(newUrl) => setPlaylist(prev => prev ? { ...prev, cover_url: newUrl } : null)}
        onRename={(newName, newDesc) => {
          setPlaylist(prev => prev ? { ...prev, name: newName, description: newDesc !== undefined ? newDesc : prev.description } : null);
          onRenamed?.();
        }}
        onDelete={onDeleted || onBack}
      />

      {/* Live Download Banner */}
      {activeJob && (activeJob.status === 'downloading' || tracks.length < (activeJob.total_tracks || 0)) && (
        <div className="mb-4 p-4 rounded-2xl bg-cat-mantle border border-cat-mauve/40 shadow-lg overflow-hidden w-full max-w-full box-border">
          <div className="flex items-center justify-between mb-2 gap-2">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              {activeJob.status === 'downloading' ? (
                <Loader2 className="w-4 h-4 animate-spin text-cat-mauve shrink-0" />
              ) : (
                <RefreshCw className="w-4 h-4 text-cat-subtext0 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-cat-text truncate">
                  {activeJob.status === 'downloading'
                    ? t('Downloading tracks in high quality in the background', 'Идет фоновая загрузка треков в высоком качестве')
                    : t('Playlist download was paused', 'Загрузка плейлиста была приостановлена')}
                </p>
                <p className="text-[11px] text-cat-subtext0 truncate">
                  {activeJob.status === 'downloading'
                    ? activeJob.current_track
                      ? t(`Downloading: ${activeJob.current_track}`, `Качается: ${activeJob.current_track}`)
                      : t('Searching and downloading audio...', 'Поиск и загрузка аудио...')
                    : t(
                        `Downloaded ${tracks.length} of ${activeJob.total_tracks} tracks`,
                        `Скачано ${tracks.length} из ${activeJob.total_tracks} треков`
                      )}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-1">
              <span className="text-xs font-black text-cat-mauve whitespace-nowrap">
                {activeJob.downloaded_tracks || tracks.length} / {activeJob.total_tracks}
              </span>
              <button
                onClick={handleResume}
                disabled={resuming}
                title={t('Resume / verify download', 'Возобновить / проверить загрузку')}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cat-surface0 hover:bg-cat-surface1 text-xs text-cat-subtext0 hover:text-cat-text transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${resuming ? 'animate-spin text-cat-mauve' : ''}`} />
                <span className="hidden sm:inline">
                  {resuming ? t('Starting...', 'Запуск...') : t('Resume', 'Возобновить')}
                </span>
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
      <div className="border-b border-cat-surface0/60 pb-2 mb-2 flex items-center justify-between text-xs font-semibold text-cat-subtext0 px-2 sm:px-3 w-full max-w-full">
        {/* Col 1: # and Title */}
        <div className="flex items-center gap-3 sm:gap-4 flex-1 md:w-2/5 md:flex-initial min-w-0">
          <span className="w-6 text-center shrink-0">#</span>
          <button
            onClick={() => handleSort('title')}
            className="flex items-center gap-1 hover:text-cat-text transition-colors truncate"
          >
            {t('Title', 'Название')} <ArrowUpDown className="w-3 h-3 shrink-0" />
          </button>
        </div>

        {/* Col 2: Artist */}
        <div className="hidden md:flex items-center w-1/5 pr-3">
          <button
            onClick={() => handleSort('artist')}
            className="flex items-center gap-1 hover:text-cat-text transition-colors"
          >
            {t('Artist', 'Исполнитель')} <ArrowUpDown className="w-3 h-3" />
          </button>
        </div>

        {/* Col 3: Album */}
        <div className="hidden lg:flex items-center w-1/5 pr-3">
          <button
            onClick={() => handleSort('album')}
            className="flex items-center gap-1 hover:text-cat-text transition-colors"
          >
            {t('Album', 'Альбом')} <ArrowUpDown className="w-3 h-3" />
          </button>
        </div>

        {/* Col 4: Date Added */}
        <div className="hidden xl:flex items-center w-28 pr-3">
          <button
            onClick={() => handleSort('date')}
            className="flex items-center gap-1 hover:text-cat-text transition-colors"
          >
            {t('Date', 'Дата')} <ArrowUpDown className="w-3 h-3" />
          </button>
        </div>

        {/* Col 5: Duration */}
        <div className="flex items-center gap-3 sm:gap-6 shrink-0">
          <button
            onClick={() => handleSort('duration')}
            className="flex items-center gap-1 hover:text-cat-text transition-colors"
          >
            {t('Time', 'Время')} <ArrowUpDown className="w-3 h-3 shrink-0" />
          </button>
          <span className="w-7 shrink-0" />
        </div>
      </div>

      {/* Tracks List */}
      <div className="space-y-0.5">
        {sortedTracks.length === 0 ? (
          <div className="py-12 text-center text-cat-subtext0 text-sm">
            {activeJob && activeJob.status === 'downloading' ? (
              <div className="flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-6 h-6 animate-spin text-cat-mauve" />
                <p className="font-semibold text-cat-text">
                  {t('Downloading the first tracks from Spotify...', 'Идет загрузка первых треков из Spotify...')}
                </p>
                <p className="text-xs text-cat-subtext0">
                  {t(
                    'They will appear in the list automatically as they finish downloading',
                    'Они появятся в списке автоматически по мере скачивания'
                  )}
                </p>
              </div>
            ) : (
              t('No tracks in this playlist yet', 'В этом плейлисте пока нет треков')
            )}
          </div>
        ) : (
          sortedTracks.map((track, i) => (
            <TrackRow
              key={`${track.id}-${i}`}
              track={track}
              index={i}
              playlistName={playlist.name}
              onPlay={() => playTrack(track, sortedTracks, i, Number(playlistId))}
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
          onAddToPlaylist={(t) => setAddToPlaylistTrack(t)}
          onRemoveFromPlaylist={handleRemoveTrack}
          onBlacklist={handleBlacklist}
        />
      )}

      {/* Add To Playlist Modal */}
      {addToPlaylistTrack && (
        <AddToPlaylistModal
          track={addToPlaylistTrack}
          isOpen={!!addToPlaylistTrack}
          onClose={() => setAddToPlaylistTrack(null)}
          onUpdated={loadData}
        />
      )}

      {/* Floating Scroll to Top Arrow */}
      {showScrollTop && (
        <button
          onClick={scrollToTop}
          title={t('Back to top', 'Наверх')}
          aria-label={t('Scroll to top', 'Прокрутить наверх')}
          className="fixed bottom-36 md:bottom-28 right-5 md:right-8 z-40 p-3.5 rounded-full bg-cat-mauve text-cat-base shadow-2xl hover:scale-110 active:scale-95 transition-all duration-200 cursor-pointer flex items-center justify-center border-2 border-cat-base animate-in fade-in zoom-in-75"
        >
          <ChevronUp className="w-5 h-5 stroke-[2.5]" />
        </button>
      )}
    </div>
  );
};
