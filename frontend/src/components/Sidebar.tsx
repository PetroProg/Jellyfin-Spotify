import React from 'react';
import { Home, Search, Heart, Settings, Plus, Music2 } from 'lucide-react';
import { Playlist } from '../types';

interface SidebarProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  playlists: Playlist[];
  selectedPlaylistId: number | null;
  onSelectPlaylist: (id: number) => void;
  onCreatePlaylist: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  setCurrentTab,
  playlists,
  selectedPlaylistId,
  onSelectPlaylist,
  onCreatePlaylist,
}) => {
  return (
    <aside className="hidden md:flex flex-col w-64 bg-cat-mantle p-4 border-r border-cat-surface0/30 select-none">
      {/* Brand Header */}
      <div className="flex items-center gap-3 px-2 mb-6 cursor-pointer" onClick={() => setCurrentTab('home')}>
        <img src="/favicon.svg" alt="Jellyfy" className="w-9 h-9 rounded-full shadow-md" />
        <div>
          <h1 className="font-bold text-lg text-cat-text tracking-wide">Jellyfy</h1>
          <span className="text-xs text-cat-subtext0">Catppuccin Edition</span>
        </div>
      </div>

      {/* Main Navigation */}
      <nav className="flex flex-col gap-1 mb-6">
        <button
          onClick={() => { setCurrentTab('home'); }}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-xl font-medium text-sm transition-all ${
            currentTab === 'home' && selectedPlaylistId === null
              ? 'bg-cat-surface0 text-cat-mauve font-semibold'
              : 'text-cat-subtext0 hover:text-cat-text hover:bg-cat-surface0/50'
          }`}
        >
          <Home className="w-5 h-5" />
          Главная
        </button>

        <button
          onClick={() => { setCurrentTab('search'); }}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-xl font-medium text-sm transition-all ${
            currentTab === 'search'
              ? 'bg-cat-surface0 text-cat-mauve font-semibold'
              : 'text-cat-subtext0 hover:text-cat-text hover:bg-cat-surface0/50'
          }`}
        >
          <Search className="w-5 h-5" />
          Поиск & Импорт
        </button>

        <button
          onClick={() => { setCurrentTab('liked'); }}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-xl font-medium text-sm transition-all ${
            currentTab === 'liked'
              ? 'bg-cat-surface0 text-cat-mauve font-semibold'
              : 'text-cat-subtext0 hover:text-cat-text hover:bg-cat-surface0/50'
          }`}
        >
          <Heart className="w-5 h-5" />
          Любимые треки
        </button>

        <button
          onClick={() => { setCurrentTab('settings'); }}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-xl font-medium text-sm transition-all ${
            currentTab === 'settings'
              ? 'bg-cat-surface0 text-cat-mauve font-semibold'
              : 'text-cat-subtext0 hover:text-cat-text hover:bg-cat-surface0/50'
          }`}
        >
          <Settings className="w-5 h-5" />
          Настройки
        </button>
      </nav>

      {/* Playlists Header */}
      <div className="flex items-center justify-between px-3 mb-2 text-xs font-semibold text-cat-subtext0 uppercase tracking-wider">
        <span>Плейлисты</span>
        <button
          onClick={onCreatePlaylist}
          title="Создать плейлист"
          className="p-1 rounded-lg hover:bg-cat-surface0 text-cat-subtext0 hover:text-cat-mauve transition-colors"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Playlist Scroll List */}
      <div className="flex-1 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
        {playlists.map((p) => {
          const isSelected = selectedPlaylistId === p.id && currentTab === 'playlist';
          return (
            <button
              key={p.id}
              onClick={() => onSelectPlaylist(p.id)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-all text-left truncate ${
                isSelected
                  ? 'bg-cat-surface0 text-cat-mauve font-medium'
                  : 'text-cat-subtext0 hover:text-cat-text hover:bg-cat-surface0/40'
              }`}
            >
              <div className="w-7 h-7 rounded-lg bg-cat-surface0 flex-shrink-0 flex items-center justify-center text-cat-subtext0 text-xs overflow-hidden">
                {p.cover_url ? (
                  <img src={p.cover_url} alt="" className="w-full h-full object-cover" />
                ) : (
                  <Music2 className="w-3.5 h-3.5" />
                )}
              </div>
              <span className="truncate">{p.name}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
};
