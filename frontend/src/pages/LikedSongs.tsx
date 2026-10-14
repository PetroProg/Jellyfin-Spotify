import React, { useState, useEffect, useRef } from 'react';
import { Heart, Play, Shuffle, ChevronUp, ArrowLeft, Download, Check, Loader2 } from 'lucide-react';
import { Track } from '../types';
import { apiRequest } from '../api/client';
import { useOfflineStore } from '../store/offlineStore';
import { TrackRow } from '../components/TrackRow';
import { ContextMenu } from '../components/ContextMenu';
import { AddToPlaylistModal } from '../components/AddToPlaylistModal';
import { usePlayerStore } from '../store/playerStore';
import { toast, confirmDialog } from '../store/toastStore';

interface LikedSongsProps {
  onBack?: () => void;
}

export const LikedSongs: React.FC<LikedSongsProps> = ({ onBack }) => {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [menuState, setMenuState] = useState<{ track: Track; pos: { x: number; y: number } } | null>(null);
  const [addToPlaylistTrack, setAddToPlaylistTrack] = useState<Track | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const LIKED_PLAYLIST_ID = -1;
  const isDownloaded = useOfflineStore((s) => s.downloadedIds.includes(LIKED_PLAYLIST_ID));
  const offlineProgress = useOfflineStore((s) => s.progress[LIKED_PLAYLIST_ID]);
  const startDownload = useOfflineStore((s) => s.startDownload);
  const removeDownload = useOfflineStore((s) => s.removeDownload);

  const downloading = !!offlineProgress?.inProgress;
  const progressText = offlineProgress ? `${offlineProgress.done}/${offlineProgress.total}` : '';

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

  const { playTrack, toggleShuffle, addToQueue, likedTrackIds } = usePlayerStore();

  const loadLikes = async () => {
    try {
      const data = await apiRequest<{ tracks: Track[] }>('/likes');
      setTracks(data.tracks || []);
    } catch (e) {
      console.warn(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLikes();
  }, [likedTrackIds]);

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
      toast.info(`«${track.title}» добавлена в «Никогда не включать» и удалена из плейлистов`);
    } catch (e: any) {
      toast.error(e.message || 'Ошибка добавления в черный список');
    }
  };

  const handleToggleDownload = async () => {
    if (downloading) return;

    if (isDownloaded) {
      const ok = await confirmDialog({
        title: 'Удалить любимые треки?',
        message: 'Вы уверены, что хотите удалить все скачанные любимые треки из памяти устройства?',
        confirmText: 'Удалить',
        cancelText: 'Отмена',
        isDestructive: true
      });
      if (!ok) return;

      try {
        await removeDownload(LIKED_PLAYLIST_ID, tracks);
        toast.info('Скачанные любимые треки удалены из памяти');
      } catch (e: any) {
        toast.error(e.message || 'Ошибка удаления из оффлайн');
      }
    } else {
      try {
        await startDownload(LIKED_PLAYLIST_ID, tracks);
        toast.success('Скачивание любимых треков начато');
      } catch (e: any) {
        toast.error(e.message || 'Ошибка сохранения оффлайн');
      }
    }
  };

  return (
    <div
      ref={containerRef}
      onScroll={(e) => setShowScrollTop(e.currentTarget.scrollTop > 200)}
      className="flex-1 overflow-y-auto px-4 md:px-8 py-6 pb-28 md:pb-24 select-none custom-scrollbar"
    >
      {onBack && (
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-cat-surface0/80 hover:bg-cat-surface1 border border-cat-surface1/50 text-sm font-semibold text-cat-subtext0 hover:text-cat-text transition-all duration-200 mb-4 cursor-pointer active:scale-95 group shadow-sm w-fit"
          title="Вернуться назад"
        >
          <ArrowLeft className="w-4 h-4 text-cat-mauve transition-transform group-hover:-translate-x-1" />
          <span>Назад</span>
        </button>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row items-center sm:items-end gap-5 mb-8">
        <div className="w-28 h-28 md:w-36 md:h-36 rounded-3xl bg-gradient-to-br from-cat-mauve to-cat-pink flex items-center justify-center text-cat-base shadow-xl flex-shrink-0">
          <Heart className="w-14 h-14 fill-current" />
        </div>
        <div className="flex-1 text-center sm:text-left min-w-0 w-full sm:w-auto">
          <span className="text-xs uppercase tracking-wider text-cat-subtext0 font-semibold">Плейлист</span>
          <h1 className="text-2xl md:text-4xl font-extrabold text-cat-text mt-1 truncate">Любимые треки</h1>
          <p className="text-xs text-cat-subtext0 mt-2">{tracks.length} треков</p>
          <div className="flex items-center justify-center sm:justify-start gap-3 mt-4 flex-wrap">
            <button
              onClick={() => tracks.length > 0 && playTrack(tracks[0], tracks, 0)}
              disabled={tracks.length === 0}
              className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-cat-mauve text-cat-base font-bold hover:opacity-95 active:scale-95 transition-all disabled:opacity-40"
            >
              <Play className="w-4 h-4 fill-current" />
              Слушать
            </button>
            <button
              onClick={() => {
                if (tracks.length > 0) {
                  playTrack(tracks[0], tracks, 0);
                  toggleShuffle();
                }
              }}
              disabled={tracks.length === 0}
              title="Перемешать"
              className="p-2.5 rounded-full bg-cat-surface0 hover:bg-cat-surface1 text-cat-text active:scale-95 transition-all disabled:opacity-40 cursor-pointer"
            >
              <Shuffle className="w-4 h-4" />
            </button>

            <button
              onClick={handleToggleDownload}
              disabled={tracks.length === 0 || downloading}
              title={isDownloaded ? 'Удалить из оффлайн' : 'Скачать все любимые треки оффлайн'}
              className={`flex items-center gap-1.5 p-2.5 rounded-full active:scale-95 transition-all disabled:opacity-40 cursor-pointer shrink-0 ${
                isDownloaded
                  ? 'bg-cat-green/20 text-cat-green border border-cat-green/30'
                  : 'bg-cat-surface0 hover:bg-cat-surface1 text-cat-subtext0 hover:text-cat-text'
              }`}
            >
              {downloading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-cat-mauve" />
                  <span className="text-xs font-mono">{progressText}</span>
                </>
              ) : isDownloaded ? (
                <Check className="w-4 h-4" />
              ) : (
                <Download className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Sorting / Table Header */}
      <div className="border-b border-cat-surface0/60 pb-2 mb-2 flex items-center justify-between text-xs font-semibold text-cat-subtext0 px-3">
        <div className="flex items-center gap-4 flex-1 md:w-2/5 md:flex-initial">
          <span className="w-6 text-center">#</span>
          <span>Название</span>
        </div>
        <div className="hidden md:flex items-center w-1/5 pr-3">
          <span>Исполнитель</span>
        </div>
        <div className="hidden lg:flex items-center w-1/5 pr-3">
          <span>Альбом</span>
        </div>
        <div className="hidden xl:flex items-center w-28 pr-3">
          <span>Дата</span>
        </div>
        <div className="flex items-center gap-6">
          <span>Время</span>
          <span className="w-7" />
        </div>
      </div>

      {/* Tracklist */}
      <div className="space-y-0.5">
        {loading ? (
          <div className="py-12 text-center text-cat-subtext0 text-sm">Загрузка любимых треков...</div>
        ) : tracks.length === 0 ? (
          <div className="py-12 text-center text-cat-subtext0 text-sm">У вас пока нет любимых треков</div>
        ) : (
          tracks.map((track, i) => (
            <TrackRow
              key={track.id}
              track={track}
              index={i}
              onPlay={() => playTrack(track, tracks, i)}
              onOpenMenu={(e, t) => setMenuState({ track: t, pos: { x: e.clientX, y: e.clientY } })}
            />
          ))
        )}
      </div>

      {menuState && (
        <ContextMenu
          track={menuState.track}
          position={menuState.pos}
          onClose={() => setMenuState(null)}
          onAddToQueue={(t) => addToQueue(t)}
          onAddToPlaylist={(t) => setAddToPlaylistTrack(t)}
          onBlacklist={handleBlacklist}
        />
      )}

      {addToPlaylistTrack && (
        <AddToPlaylistModal
          track={addToPlaylistTrack}
          isOpen={!!addToPlaylistTrack}
          onClose={() => setAddToPlaylistTrack(null)}
          onUpdated={loadLikes}
        />
      )}

      {/* Floating Scroll to Top Arrow */}
      {showScrollTop && (
        <button
          onClick={scrollToTop}
          title="Наверх"
          aria-label="Прокрутить наверх"
          className="fixed bottom-36 md:bottom-28 right-5 md:right-8 z-40 p-3.5 rounded-full bg-cat-mauve text-cat-base shadow-2xl hover:scale-110 active:scale-95 transition-all duration-200 cursor-pointer flex items-center justify-center border-2 border-cat-base animate-in fade-in zoom-in-75"
        >
          <ChevronUp className="w-5 h-5 stroke-[2.5]" />
        </button>
      )}
    </div>
  );
};
