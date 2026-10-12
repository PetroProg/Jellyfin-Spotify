import React, { useState, useRef } from 'react';
import { Play, Plus, Music2, Download, Heart, ChevronUp } from 'lucide-react';
import { Playlist, Track } from '../types';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';

interface HomeProps {
  playlists: Playlist[];
  onSelectPlaylist: (id: number) => void;
  onCreatePlaylist: () => void;
  onOpenImport: () => void;
  onOpenLiked: () => void;
}

export const Home: React.FC<HomeProps> = ({
  playlists,
  onSelectPlaylist,
  onCreatePlaylist,
  onOpenImport,
  onOpenLiked,
}) => {
  const { user } = useAuthStore();
  const { playTrack } = usePlayerStore();
  const [showScrollTop, setShowScrollTop] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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
                    <img src={playlist.cover_url} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
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
