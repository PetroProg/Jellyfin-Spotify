import React, { useState, useEffect, useRef } from 'react';
import { Play, Plus, Music2, Download, Heart, ChevronUp, Sparkles, RefreshCw, Loader2 } from 'lucide-react';
import { Playlist } from '../types';
import { useAuthStore } from '../store/authStore';
import { apiRequest } from '../api/client';
import { toast } from '../store/toastStore';

interface HomeProps {
  playlists: Playlist[];
  onSelectPlaylist: (id: number) => void;
  onCreatePlaylist: () => void;
  onOpenImport: () => void;
  onOpenLiked: () => void;
}

const DAILY_MIXES_CACHE_KEY = 'jellyfy_daily_mixes_cache';

const ACCENT_STYLES: Record<string, { badgeBg: string; border: string; glow: string }> = {
  mauve: {
    badgeBg: 'from-cat-mauve to-cat-pink',
    border: 'border-cat-mauve/40',
    glow: 'from-cat-mauve/25 via-cat-mantle to-cat-mantle'
  },
  sapphire: {
    badgeBg: 'from-cat-sapphire to-cat-blue',
    border: 'border-cat-sapphire/40',
    glow: 'from-cat-sapphire/25 via-cat-mantle to-cat-mantle'
  },
  blue: {
    badgeBg: 'from-cat-blue to-cat-lavender',
    border: 'border-cat-blue/40',
    glow: 'from-cat-blue/25 via-cat-mantle to-cat-mantle'
  },
  peach: {
    badgeBg: 'from-cat-peach to-cat-yellow',
    border: 'border-cat-peach/40',
    glow: 'from-cat-peach/25 via-cat-mantle to-cat-mantle'
  },
  red: {
    badgeBg: 'from-cat-red to-cat-peach',
    border: 'border-cat-red/40',
    glow: 'from-cat-red/25 via-cat-mantle to-cat-mantle'
  },
  pink: {
    badgeBg: 'from-cat-pink to-cat-mauve',
    border: 'border-cat-pink/40',
    glow: 'from-cat-pink/25 via-cat-mantle to-cat-mantle'
  },
  teal: {
    badgeBg: 'from-cat-teal to-cat-green',
    border: 'border-cat-teal/40',
    glow: 'from-cat-teal/25 via-cat-mantle to-cat-mantle'
  }
};

export const Home: React.FC<HomeProps> = ({
  playlists,
  onSelectPlaylist,
  onCreatePlaylist,
  onOpenImport,
  onOpenLiked,
}) => {
  const { user } = useAuthStore();
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [dailyMixes, setDailyMixes] = useState<Playlist[]>(() => {
    try {
      const raw = localStorage.getItem(DAILY_MIXES_CACHE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [loadingMixes, setLoadingMixes] = useState(false);
  const [refreshingMixes, setRefreshingMixes] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const loadDailyMixes = async (silent = false) => {
    try {
      if (!silent && dailyMixes.length === 0) setLoadingMixes(true);
      const data = await apiRequest<{ mixes: Playlist[] }>('/daily-mixes');
      if (data.mixes) {
        setDailyMixes(data.mixes);
        try {
          localStorage.setItem(DAILY_MIXES_CACHE_KEY, JSON.stringify(data.mixes));
        } catch (_) {}
      }
    } catch (err) {
      console.warn('[Home] Could not fetch daily mixes (offline or error):', err);
    } finally {
      setLoadingMixes(false);
    }
  };

  useEffect(() => {
    loadDailyMixes();
  }, []);

  // Poll progress while any Daily Mix is actively downloading its new tracks
  const hasActiveMixDownload = dailyMixes.some(
    (m) => m.activeJob && (m.activeJob.status === 'downloading' || m.activeJob.status === 'pending')
  );

  useEffect(() => {
    if (!hasActiveMixDownload) return;
    const timer = setInterval(() => {
      loadDailyMixes(true);
    }, 3000);
    return () => clearInterval(timer);
  }, [hasActiveMixDownload]);

  const handleRefreshMixes = async () => {
    if (refreshingMixes) return;
    setRefreshingMixes(true);
    try {
      toast.info('Подбираем новые треки по категориям ваших плейлистов...');
      const data = await apiRequest<{ mixes: Playlist[] }>('/daily-mixes/refresh', { method: 'POST' });
      if (data.mixes) {
        setDailyMixes(data.mixes);
        try {
          localStorage.setItem(DAILY_MIXES_CACHE_KEY, JSON.stringify(data.mixes));
        } catch (_) {}
        toast.success('Плейлисты дня обновлены и поставлены на предзагрузку!');
      }
    } catch (err: any) {
      toast.error(err.message || 'Не удалось обновить Плейлисты дня');
    } finally {
      setRefreshingMixes(false);
    }
  };

  const scrollToTop = () => {
    containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div
      ref={containerRef}
      onScroll={(e) => setShowScrollTop(e.currentTarget.scrollTop > 200)}
      className="flex-1 overflow-y-auto px-4 md:px-8 py-6 pb-28 md:pb-24 select-none custom-scrollbar"
    >
      {/* Header Greeting */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold text-cat-text">
            Привет, {user?.display_name || user?.username || 'Музыкант'}! 👋
          </h1>
          <p className="text-xs text-cat-subtext0 mt-1">Твоя личная библиотека музыки в высоком качестве</p>
        </div>

        {/* Quick Action Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={onOpenImport}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-cat-mauve text-cat-base text-xs font-bold hover:opacity-95 active:scale-95 transition-all shadow-md"
          >
            <Download className="w-4 h-4" />
            Импорт Spotify
          </button>
          <button
            onClick={onCreatePlaylist}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-text text-xs font-bold active:scale-95 transition-all"
          >
            <Plus className="w-4 h-4 text-cat-mauve" />
            Новый плейлист
          </button>
        </div>
      </div>

      {/* Featured Banners */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {/* Liked Card */}
        <div
          onClick={onOpenLiked}
          className="bg-gradient-to-br from-cat-mauve/20 to-cat-pink/20 hover:from-cat-mauve/30 hover:to-cat-pink/30 border border-cat-mauve/30 rounded-3xl p-5 cursor-pointer transition-all active:scale-[0.99] flex items-center gap-4"
        >
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-cat-mauve to-cat-pink flex items-center justify-center text-cat-base shadow-lg flex-shrink-0">
            <Heart className="w-7 h-7 fill-current" />
          </div>
          <div>
            <h3 className="font-bold text-base text-cat-text">Любимые треки</h3>
            <p className="text-xs text-cat-subtext0 mt-0.5">Твоя коллекция</p>
          </div>
        </div>

        {/* Spotify Import Card */}
        <div
          onClick={onOpenImport}
          className="bg-gradient-to-br from-cat-green/20 to-cat-teal/20 hover:from-cat-green/30 hover:to-cat-teal/30 border border-cat-green/30 rounded-3xl p-5 cursor-pointer transition-all active:scale-[0.99] flex items-center gap-4"
        >
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-cat-green to-cat-teal flex items-center justify-center text-cat-base shadow-lg flex-shrink-0">
            <Download className="w-7 h-7" />
          </div>
          <div>
            <h3 className="font-bold text-base text-cat-text">Импорт плейлиста</h3>
            <p className="text-xs text-cat-subtext0 mt-0.5">Вставить ссылку Spotify</p>
          </div>
        </div>
      </div>

      {/* Daily Mixes Section ("Сделано для тебя • Плейлисты дня") */}
      {(loadingMixes || dailyMixes.length > 0) && (
        <div className="mb-10">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-cat-mauve" />
              <div>
                <h2 className="text-lg font-bold text-cat-text leading-tight">Плейлисты дня • Для тебя</h2>
                <p className="text-[11px] text-cat-subtext0">
                  Разделены по жанрам твоих плейлистов • 80% новых треков и 20% любимой классики
                </p>
              </div>
            </div>

            <button
              onClick={handleRefreshMixes}
              disabled={refreshingMixes || loadingMixes}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-subtext1 hover:text-cat-text text-xs font-medium transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
              title="Сгенерировать свежие Плейлисты дня"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshingMixes ? 'animate-spin text-cat-mauve' : ''}`} />
              <span className="hidden sm:inline">{refreshingMixes ? 'Генерация...' : 'Обновить миксы'}</span>
            </button>
          </div>

          {loadingMixes && dailyMixes.length === 0 ? (
            <div className="bg-cat-mantle/80 border border-cat-surface0/60 rounded-3xl p-8 flex flex-col items-center justify-center text-center gap-3">
              <Loader2 className="w-8 h-8 text-cat-mauve animate-spin" />
              <div>
                <p className="text-sm font-semibold text-cat-text">Собираем персональные Плейлисты дня...</p>
                <p className="text-xs text-cat-subtext0 mt-1">
                  Анализируем категории ваших плейлистов и подбираем новые треки по каждому жанру
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {dailyMixes.map((mix, index) => {
                const accent = ACCENT_STYLES[mix.accent_color || 'mauve'] || ACCENT_STYLES.mauve;
                const mixNum = mix.daily_mix_number || index + 1;
                const isDownloading =
                  mix.activeJob && (mix.activeJob.status === 'downloading' || mix.activeJob.status === 'pending');

                return (
                  <div
                    key={mix.id}
                    onClick={() => onSelectPlaylist(mix.id)}
                    className={`group bg-gradient-to-b ${accent.glow} hover:bg-cat-surface0/70 p-3 rounded-2xl border ${accent.border} cursor-pointer transition-all active:scale-[0.98] flex flex-col`}
                  >
                    <div className="aspect-square rounded-xl bg-cat-surface0 overflow-hidden mb-3 relative flex items-center justify-center shadow-lg">
                      {mix.cover_url ? (
                        <img
                          src={mix.cover_url}
                          alt=""
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                      ) : (
                        <Sparkles className="w-12 h-12 text-cat-mauve/60" />
                      )}

                      {/* Spotify-style Daily Mix Top Overlay */}
                      <div className="absolute inset-x-0 top-0 p-2.5 flex items-center justify-between bg-gradient-to-b from-cat-crust/85 via-cat-crust/40 to-transparent">
                        <span className="text-[10px] font-extrabold tracking-wider uppercase px-2 py-0.5 rounded-md bg-cat-crust/90 text-cat-text border border-white/10">
                          МИКС ДНЯ #{mixNum}
                        </span>
                      </div>

                      {/* Bottom Category Ribbon */}
                      <div
                        className={`absolute inset-x-0 bottom-0 px-2.5 py-1.5 bg-gradient-to-r ${accent.badgeBg} text-cat-crust font-extrabold text-[10px] tracking-wider uppercase truncate`}
                      >
                        {mix.category_title || mix.category_badge || 'Персональный микс'}
                      </div>

                      {/* Play Button Hover */}
                      <div className="absolute right-2 bottom-8 w-9 h-9 rounded-full bg-cat-mauve text-cat-base flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 transition-opacity translate-y-1 group-hover:translate-y-0 duration-200">
                        <Play className="w-4 h-4 fill-current ml-0.5" />
                      </div>
                    </div>

                    <h3 className="font-bold text-sm text-cat-text truncate">{mix.name}</h3>
                    <p className="text-[11px] text-cat-subtext0 line-clamp-2 mt-0.5 leading-snug flex-1">
                      {mix.seed_artists && mix.seed_artists.length > 0
                        ? `${mix.seed_artists.join(', ')} и новые треки`
                        : mix.description || 'Новые треки в твоем стиле'}
                    </p>

                    <div className="mt-2 pt-1.5 border-t border-cat-surface0/60 flex items-center justify-between text-[11px]">
                      {isDownloading ? (
                        <span className="text-cat-mauve font-medium flex items-center gap-1 truncate">
                          <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
                          Предзагрузка {mix.activeJob?.downloaded_tracks || mix.track_count || 0}/
                          {mix.activeJob?.total_tracks || 25}
                        </span>
                      ) : (
                        <span className="text-cat-subtext0">{mix.track_count || 0} треков • Готов</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Playlists Grid */}
      <div className="mb-8">
        <h2 className="text-lg font-bold text-cat-text mb-4">Твои плейлисты</h2>
        {playlists.length === 0 ? (
          <div className="bg-cat-mantle p-8 rounded-3xl border border-cat-surface0/60 text-center">
            <Music2 className="w-12 h-12 text-cat-subtext0/40 mx-auto mb-3" />
            <p className="text-sm text-cat-subtext0 mb-4">У вас пока нет плейлистов</p>
            <button
              onClick={onOpenImport}
              className="px-5 py-2.5 rounded-full bg-cat-mauve text-cat-base font-bold text-xs"
            >
              Импортировать из Spotify
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {playlists.map((playlist) => (
              <div
                key={playlist.id}
                onClick={() => onSelectPlaylist(playlist.id)}
                className="group bg-cat-mantle hover:bg-cat-surface0/60 p-3 rounded-2xl border border-cat-surface0/50 cursor-pointer transition-all active:scale-[0.98]"
              >
                <div className="aspect-square rounded-xl bg-cat-surface0 overflow-hidden mb-3 relative flex items-center justify-center shadow-md">
                  {playlist.cover_url ? (
                    <img
                      src={playlist.cover_url}
                      alt=""
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  ) : (
                    <Music2 className="w-10 h-10 text-cat-mauve/50" />
                  )}
                  <div className="absolute right-2 bottom-2 w-9 h-9 rounded-full bg-cat-mauve text-cat-base flex items-center justify-center shadow-lg opacity-0 group-hover:opacity-100 transition-opacity translate-y-1 group-hover:translate-y-0 duration-200">
                    <Play className="w-4 h-4 fill-current ml-0.5" />
                  </div>
                </div>
                <h3 className="font-semibold text-sm text-cat-text truncate">{playlist.name}</h3>
                <p className="text-xs text-cat-subtext0 truncate mt-0.5">
                  {playlist.track_count ? `${playlist.track_count} треков` : 'Плейлист'}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

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
