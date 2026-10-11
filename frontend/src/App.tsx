import React, { useState, useEffect } from 'react';
import { useAuthStore } from './store/authStore';
import { apiRequest } from './api/client';
import { Playlist } from './types';
import { Sidebar } from './components/Sidebar';
import { BottomNav } from './components/BottomNav';
import { MiniPlayer } from './components/MiniPlayer';
import { FullPlayer } from './components/FullPlayer';
import { DesktopPlayer } from './components/DesktopPlayer';
import { QueuePanel } from './components/QueuePanel';
import { Home } from './pages/Home';
import { PlaylistView } from './pages/PlaylistView';
import { SearchImport } from './pages/SearchImport';
import { LikedSongs } from './pages/LikedSongs';
import { Settings } from './pages/Settings';
import { Login } from './pages/Login';
import { Register } from './pages/Register';

export const App: React.FC = () => {
  const { isAuthenticated, isLoading, fetchMe } = useAuthStore();
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  
  const [currentTab, setCurrentTab] = useState('home');
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<number | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  
  // Create Playlist Modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [newPlaylistDesc, setNewPlaylistDesc] = useState('');

  useEffect(() => {
    fetchMe();
  }, []);

  const loadPlaylists = async () => {
    if (!isAuthenticated) return;
    try {
      const data = await apiRequest<{ playlists: Playlist[] }>('/playlists');
      setPlaylists(data.playlists || []);
    } catch (e) {
      console.warn(e);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      loadPlaylists();
    }
  }, [isAuthenticated]);

  const handleSelectPlaylist = (id: number) => {
    setSelectedPlaylistId(id);
    setCurrentTab('playlist');
  };

  const handleCreatePlaylist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlaylistName.trim()) return;

    try {
      const res = await apiRequest('/playlists', {
        method: 'POST',
        body: JSON.stringify({ name: newPlaylistName, description: newPlaylistDesc })
      });
      setShowCreateModal(false);
      setNewPlaylistName('');
      setNewPlaylistDesc('');
      await loadPlaylists();
      if (res.id) {
        handleSelectPlaylist(res.id);
      }
    } catch (e: any) {
      alert(e.message || 'Ошибка создания плейлиста');
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-cat-base flex items-center justify-center text-cat-subtext0 text-sm">
        Инициализация Jellyfy...
      </div>
    );
  }

  if (!isAuthenticated) {
    return authMode === 'login' ? (
      <Login onGoToRegister={() => setAuthMode('register')} />
    ) : (
      <Register onGoToLogin={() => setAuthMode('login')} />
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-cat-base text-cat-text flex-col">
      <div className="flex flex-1 overflow-hidden">
        {/* Left Desktop Sidebar */}
        <Sidebar
          currentTab={currentTab}
          setCurrentTab={(tab) => {
            setCurrentTab(tab);
            setSelectedPlaylistId(null);
          }}
          playlists={playlists}
          selectedPlaylistId={selectedPlaylistId}
          onSelectPlaylist={handleSelectPlaylist}
          onCreatePlaylist={() => setShowCreateModal(true)}
        />

        {/* Center Main Content Area */}
        <main className="flex-1 flex flex-col min-w-0 bg-cat-base relative overflow-hidden">
          {currentTab === 'home' && (
            <Home
              playlists={playlists}
              onSelectPlaylist={handleSelectPlaylist}
              onCreatePlaylist={() => setShowCreateModal(true)}
              onOpenImport={() => {
                setCurrentTab('search');
                setSelectedPlaylistId(null);
              }}
              onOpenLiked={() => {
                setCurrentTab('liked');
                setSelectedPlaylistId(null);
              }}
            />
          )}

          {currentTab === 'playlist' && selectedPlaylistId && (
            <PlaylistView
              playlistId={selectedPlaylistId}
              onBack={() => {
                setCurrentTab('home');
                setSelectedPlaylistId(null);
              }}
            />
          )}

          {currentTab === 'search' && (
            <SearchImport
              onOpenPlaylist={(id) => {
                handleSelectPlaylist(id);
                loadPlaylists();
              }}
            />
          )}

          {currentTab === 'liked' && <LikedSongs />}

          {currentTab === 'settings' && <Settings />}
        </main>

        {/* Right Desktop Queue & Recommendations Panel */}
        {isQueueOpen && <QueuePanel />}
      </div>

      {/* Desktop Bottom Player */}
      <DesktopPlayer onToggleQueue={() => setIsQueueOpen(!isQueueOpen)} />

      {/* Mobile Floating Mini Player */}
      <MiniPlayer />

      {/* Mobile Bottom Navigation Bar */}
      <BottomNav
        currentTab={currentTab}
        setCurrentTab={setCurrentTab}
        onClearSelectedPlaylist={() => setSelectedPlaylistId(null)}
      />

      {/* Mobile Full-Screen Now Playing Modal */}
      <FullPlayer />

      {/* Create Playlist Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-cat-crust/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-cat-mantle border border-cat-surface0/80 rounded-3xl p-6 max-w-sm w-full shadow-2xl">
            <h3 className="font-bold text-lg text-cat-text mb-4">Новый плейлист</h3>
            <form onSubmit={handleCreatePlaylist} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-cat-subtext0 uppercase tracking-wider block mb-1">
                  Название
                </label>
                <input
                  type="text"
                  required
                  placeholder="Мой любимый микс"
                  value={newPlaylistName}
                  onChange={(e) => setNewPlaylistName(e.target.value)}
                  className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-cat-subtext0 uppercase tracking-wider block mb-1">
                  Описание (необязательно)
                </label>
                <textarea
                  rows={2}
                  placeholder="Описание плейлиста..."
                  value={newPlaylistDesc}
                  onChange={(e) => setNewPlaylistDesc(e.target.value)}
                  className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2 text-sm text-cat-text focus:outline-none focus:border-cat-mauve resize-none"
                />
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 py-2.5 rounded-2xl bg-cat-surface0 text-cat-text text-xs font-semibold hover:bg-cat-surface1"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={!newPlaylistName.trim()}
                  className="flex-1 py-2.5 rounded-2xl bg-cat-mauve text-cat-base text-xs font-bold hover:opacity-90 disabled:opacity-40"
                >
                  Создать
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
export default App;
