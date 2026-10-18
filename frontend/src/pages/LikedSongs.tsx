import React, { useState, useEffect, useRef } from 'react';
import { Heart, Play, Shuffle, ChevronUp, ArrowLeft, Download, Check, Loader2, RefreshCw } from 'lucide-react';
import { Track, DownloadJob } from '../types';
import { apiRequest } from '../api/client';
import { useOfflineStore } from '../store/offlineStore';
import { getOfflinePlaylistData, saveOfflinePlaylistData } from '../utils/offline';
import { TrackRow } from '../components/TrackRow';
import { ContextMenu } from '../components/ContextMenu';
import { AddToPlaylistModal } from '../components/AddToPlaylistModal';
import { usePlayerStore } from '../store/playerStore';
import { toast, confirmDialog } from '../store/toastStore';
import { useI18nStore, formatTrackCount } from '../store/i18nStore';

interface LikedSongsProps {
  onBack?: () => void;
}

export const LikedSongs: React.FC<LikedSongsProps> = ({ onBack }) => {
  const { lang, t } = useI18nStore();
  const LIKED_PLAYLIST_ID = -1;
  const CACHED_LIKED_TRACKS_KEY = 'jellyfy_cached_liked_tracks';

  const getInitialTracks = (): Track[] => {
    try {
      const offline = getOfflinePlaylistData(LIKED_PLAYLIST_ID);
      if (offline && offline.tracks && offline.tracks.length > 0) return offline.tracks;
      const raw = localStorage.getItem(CACHED_LIKED_TRACKS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (_) {}
    return [];
  };

  const initialTracks = getInitialTracks();
  const [tracks, setTracks] = useState<Track[]>(initialTracks);
  const [loading, setLoading] = useState(initialTracks.length === 0);
  const [menuState, setMenuState] = useState<{ track: Track; pos: { x: number; y: number } } | null>(null);
  const [addToPlaylistTrack, setAddToPlaylistTrack] = useState<Track | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [activeJob, setActiveJob] = useState<DownloadJob | null>(null);
  const [syncingSpotify, setSyncingSpotify] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const { playTrack, shufflePlay, toggleShuffle, addToQueue, likedTrackIds } = usePlayerStore();

  const loadLikes = async () => {
    try {
      const data = await apiRequest<{ tracks: Track[] }>('/likes', { timeoutMs: 5000 });
      const loadedTracks = data.tracks || [];
      setTracks(loadedTracks);
      localStorage.setItem(CACHED_LIKED_TRACKS_KEY, JSON.stringify(loadedTracks));

      const likedPl = {
        id: LIKED_PLAYLIST_ID,
        name: 'Любимые треки',
        description: 'Ваша медиатека сохраненных композиций',
        created_at: new Date().toISOString(),
        track_count: loadedTracks.length,
      };
      saveOfflinePlaylistData(likedPl, loadedTracks);

      if (useOfflineStore.getState().isDownloaded(LIKED_PLAYLIST_ID)) {
        useOfflineStore.getState().syncPlaylist(LIKED_PLAYLIST_ID, loadedTracks, likedPl);
      }
    } catch (e) {
      console.warn('[LikedSongs] Network error, fallback to offline tracks:', e);
      const offline = getOfflinePlaylistData(LIKED_PLAYLIST_ID);
      if (offline && offline.tracks && offline.tracks.length > 0) {
        setTracks(offline.tracks);
      } else {
        const raw = localStorage.getItem(CACHED_LIKED_TRACKS_KEY);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) setTracks(parsed);
          } catch (_) {}
        }
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLikes();
  }, [likedTrackIds]);

  const pollJobs = async () => {
    try {
      const data = await apiRequest<{ jobs: DownloadJob[] }>('/spotify/jobs');
      const likedJob = (data.jobs || []).find(
        (j) => (j.playlist_name === 'Любимые треки' || j.playlist_id === null) && (j.status === 'downloading' || j.status === 'pending')
      );
      setActiveJob(likedJob || null);
    } catch (_) {}
  };

  useEffect(() => {
    pollJobs();
    const interval = setInterval(pollJobs, 2500);
    return () => clearInterval(interval);
  }, []);

  // When Spotify is actively downloading liked tracks, live-refresh the track list
  useEffect(() => {
    if (!activeJob) return;
    const interval = setInterval(() => {
      loadLikes();
    }, 2500);
    return () => clearInterval(interval);
  }, [activeJob?.id, activeJob?.downloaded_tracks, activeJob?.status]);

  const handleSyncSpotify = async () => {
    if (syncingSpotify) return;
    setSyncingSpotify(true);
    try {
      const res = await apiRequest<any>('/spotify/import-liked', { method: 'POST' });
      toast.success(
        res.message ||
          t(
            'Started syncing Liked Songs. All your existing tracks on the site are preserved.',
            'Синхронизация любимых треков начата. Все треки на сайте сохранены.'
          )
      );
      pollJobs();
      loadLikes();
    } catch (err: any) {
      toast.error(err.message || t('Failed to sync with Spotify', 'Ошибка синхронизации со Spotify'));
    } finally {
      setSyncingSpotify(false);
    }
  };

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

  const handleToggleDownload = async () => {
    if (downloading) return;

    if (isDownloaded) {
      const ok = await confirmDialog({
        title: t('Remove offline Liked Songs?', 'Удалить любимые треки?'),
        message: t(
          'Are you sure you want to remove all downloaded Liked Songs from this device?',
          'Вы уверены, что хотите удалить все скачанные любимые треки из памяти устройства?'
        ),
        confirmText: t('Remove', 'Удалить'),
        cancelText: t('Cancel', 'Отмена'),
        isDestructive: true
      });
      if (!ok) return;

      try {
        await removeDownload(LIKED_PLAYLIST_ID, tracks);
        toast.info(t('Downloaded Liked Songs removed from device memory', 'Скачанные любимые треки удалены из памяти'));
      } catch (e: any) {
        toast.error(e.message || t('Failed to remove offline cache', 'Ошибка удаления из оффлайн'));
      }
    } else {
      try {
        const likedPl = {
          id: LIKED_PLAYLIST_ID,
          name: 'Любимые треки',
          description: 'Ваша медиатека сохраненных композиций',
          created_at: new Date().toISOString(),
          track_count: tracks.length,
        };
        await startDownload(LIKED_PLAYLIST_ID, tracks, likedPl);
        toast.success(t('Started downloading Liked Songs for offline', 'Скачивание любимых треков начато'));
      } catch (e: any) {
        toast.error(e.message || t('Failed to save offline', 'Ошибка сохранения оффлайн'));
      }
    }
  };

  return (
    <div
      ref={containerRef}
      onScroll={(e) => setShowScrollTop(e.currentTarget.scrollTop > 200)}
      className="flex-1 w-full max-w-full overflow-y-auto overflow-x-hidden px-4 md:px-8 py-6 pb-28 md:pb-24 select-none custom-scrollbar"
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

      {/* Header */}
      <div className="w-full max-w-full flex flex-col sm:flex-row items-center sm:items-end gap-5 mb-8 overflow-hidden">
        <div className="w-28 h-28 md:w-36 md:h-36 rounded-3xl bg-gradient-to-br from-cat-mauve to-cat-pink flex items-center justify-center text-cat-base shadow-xl flex-shrink-0">
          <Heart className="w-14 h-14 fill-current" />
        </div>
        <div className="w-full max-w-full flex-1 text-center sm:text-left min-w-0 px-2 sm:px-0">
          <span className="text-xs uppercase tracking-wider text-cat-subtext0 font-semibold block truncate">
            {t('Playlist', 'Плейлист')}
          </span>
          <h1 className="text-xl sm:text-2xl md:text-4xl font-extrabold text-cat-text mt-1 break-words line-clamp-2 sm:line-clamp-none leading-tight">
            {t('Liked Songs', 'Любимые треки')}
          </h1>
          <p className="text-xs text-cat-subtext0 mt-2">{formatTrackCount(tracks.length, lang)}</p>
          <div className="flex items-center justify-center sm:justify-start gap-3 mt-4 flex-wrap w-full max-w-full">
            <button
              onClick={() => tracks.length > 0 && playTrack(tracks[0], tracks, 0)}
              disabled={tracks.length === 0}
              className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-cat-mauve text-cat-base font-bold hover:opacity-95 active:scale-95 transition-all disabled:opacity-40"
            >
              <Play className="w-4 h-4 fill-current" />
              {t('Play', 'Слушать')}
            </button>
            <button
              onClick={() => {
                if (tracks.length > 0) {
                  shufflePlay(tracks);
                }
              }}
              disabled={tracks.length === 0}
              title={t('Shuffle', 'Перемешать')}
              className="p-2.5 rounded-full bg-cat-surface0 hover:bg-cat-surface1 text-cat-text active:scale-95 transition-all disabled:opacity-40 cursor-pointer"
            >
              <Shuffle className="w-4 h-4" />
            </button>

            <button
              onClick={handleToggleDownload}
              disabled={tracks.length === 0 || downloading}
              title={
                isDownloaded
                  ? t('Remove from offline', 'Удалить из оффлайн')
                  : t('Download all Liked Songs for offline', 'Скачать все любимые треки оффлайн')
              }
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

            <button
              onClick={handleSyncSpotify}
              disabled={Boolean(syncingSpotify || (activeJob && (activeJob.status === 'downloading' || activeJob.status === 'pending')))}
              title={t(
                'Sync with Spotify: downloads missing tracks from your Spotify account without deleting any tracks on the site',
                'Синхронизировать со Spotify: догрузит треки из аккаунта Spotify без удаления треков с сайта'
              )}
              className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-full bg-cat-surface0 hover:bg-cat-surface1 text-cat-subtext0 hover:text-cat-mauve active:scale-95 transition-all text-xs font-semibold disabled:opacity-50 cursor-pointer shrink-0"
            >
              {syncingSpotify || (activeJob && (activeJob.status === 'downloading' || activeJob.status === 'pending')) ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-cat-mauve" />
                  <span className="hidden sm:inline">{t('Syncing...', 'Синхронизация...')}</span>
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 text-cat-mauve" />
                  <span className="hidden sm:inline">{t('Sync Spotify', 'Синхронизировать Spotify')}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Live Spotify Download Banner */}
      {activeJob && (activeJob.status === 'downloading' || activeJob.status === 'pending') && (
        <div className="mb-6 p-4 rounded-2xl bg-cat-surface0/60 border border-cat-mauve/30 shadow-lg flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-cat-mauve/20 text-cat-mauve flex items-center justify-center shrink-0">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
            <div className="min-w-0">
              <h4 className="text-sm font-bold text-cat-text">
                {t('Syncing: downloading new Liked Songs', 'Синхронизация: догрузка новых любимых треков')}
              </h4>
              <p className="text-xs text-cat-subtext0 truncate max-w-[240px] sm:max-w-md">
                {activeJob.current_track
                  ? t(`Downloading: ${activeJob.current_track}`, `Скачивается: ${activeJob.current_track}`)
                  : t('Preparing tracks...', 'Подготовка треков...')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 w-full sm:w-auto shrink-0 justify-between sm:justify-end">
            <span className="text-xs font-mono font-bold text-cat-mauve shrink-0">
              {activeJob.downloaded_tracks || 0} / {activeJob.total_tracks || 0}
            </span>
            <div className="w-24 sm:w-32 bg-cat-surface1 h-2 rounded-full overflow-hidden shrink-0">
              <div
                className="bg-cat-mauve h-full rounded-full transition-all duration-300"
                style={{
                  width: `${Math.max(5, Math.min(100, Math.round(((activeJob.downloaded_tracks || 0) / (activeJob.total_tracks || 1)) * 100)))}%`
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Sorting / Table Header */}
      <div className="border-b border-cat-surface0/60 pb-2 mb-2 flex items-center justify-between text-xs font-semibold text-cat-subtext0 px-2 sm:px-3 w-full max-w-full">
        <div className="flex items-center gap-3 sm:gap-4 flex-1 md:w-2/5 md:flex-initial min-w-0">
          <span className="w-6 text-center shrink-0">#</span>
          <span className="truncate">{t('Title', 'Название')}</span>
        </div>
        <div className="hidden md:flex items-center w-1/5 pr-3">
          <span>{t('Artist', 'Исполнитель')}</span>
        </div>
        <div className="hidden lg:flex items-center w-1/5 pr-3">
          <span>{t('Album', 'Альбом')}</span>
        </div>
        <div className="hidden xl:flex items-center w-28 pr-3">
          <span>{t('Date', 'Дата')}</span>
        </div>
        <div className="flex items-center gap-3 sm:gap-6 shrink-0">
          <span>{t('Time', 'Время')}</span>
          <span className="w-7 shrink-0" />
        </div>
      </div>

      {/* Tracklist */}
      <div className="space-y-0.5">
        {loading ? (
          <div className="py-12 text-center text-cat-subtext0 text-sm">
            {t('Loading Liked Songs...', 'Загрузка любимых треков...')}
          </div>
        ) : tracks.length === 0 ? (
          <div className="py-12 text-center text-cat-subtext0 text-sm">
            {t('You do not have any Liked Songs yet', 'У вас пока нет любимых треков')}
          </div>
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
