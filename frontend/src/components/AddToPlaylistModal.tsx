import React, { useState, useEffect } from 'react';
import { Search, Plus, CheckCircle2, Circle, Loader2, Music2, X } from 'lucide-react';
import { Track } from '../types';
import { apiRequest } from '../api/client';

interface PlaylistWithStatus {
  id: number;
  name: string;
  cover_url?: string;
  track_count: number;
  has_track: number; // 1 or 0
}

interface AddToPlaylistModalProps {
  track: Track | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdated?: () => void;
}

export const AddToPlaylistModal: React.FC<AddToPlaylistModalProps> = ({
  track,
  isOpen,
  onClose,
  onUpdated,
}) => {
  const [playlists, setPlaylists] = useState<PlaylistWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [togglingId, setTogglingId] = useState<number | null>(null);

  // New playlist inline creation
  const [creatingNew, setCreatingNew] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [savingNew, setSavingNew] = useState(false);

  useEffect(() => {
    if (isOpen && track) {
      loadPlaylists();
      setSearch('');
      setCreatingNew(false);
      setNewPlaylistName('');
    }
  }, [isOpen, track?.id]);

  const loadPlaylists = async () => {
    if (!track) return;
    setLoading(true);
    try {
      const data = await apiRequest<{ playlists: PlaylistWithStatus[] }>(`/tracks/${track.id}/playlists`);
      setPlaylists(data.playlists || []);
    } catch (e) {
      console.warn('[Load playlists error]:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async (playlist: PlaylistWithStatus) => {
    if (!track || togglingId !== null) return;
    setTogglingId(playlist.id);

    const isCurrentlyAdded = playlist.has_track === 1;

    // Optimistic UI update
    setPlaylists((prev) =>
      prev.map((p) =>
        p.id === playlist.id
          ? {
              ...p,
              has_track: isCurrentlyAdded ? 0 : 1,
              track_count: Math.max(0, p.track_count + (isCurrentlyAdded ? -1 : 1)),
            }
          : p
      )
    );

    try {
      if (isCurrentlyAdded) {
        // Remove from playlist
        await apiRequest(`/playlists/${playlist.id}/tracks/${track.id}`, { method: 'DELETE' });
      } else {
        // Add to playlist
        await apiRequest(`/playlists/${playlist.id}/tracks`, {
          method: 'POST',
          body: JSON.stringify({ trackId: track.id }),
        });
      }
      onUpdated?.();
    } catch (err: any) {
      console.warn('[Toggle playlist error]:', err);
      // Revert on error
      await loadPlaylists();
    } finally {
      setTogglingId(null);
    }
  };

  const handleCreatePlaylist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!track || !newPlaylistName.trim() || savingNew) return;
    setSavingNew(true);

    try {
      const res = await apiRequest<{ id: number; name: string }>('/playlists', {
        method: 'POST',
        body: JSON.stringify({ name: newPlaylistName.trim() }),
      });

      if (res.id) {
        // Add current track to newly created playlist
        await apiRequest(`/playlists/${res.id}/tracks`, {
          method: 'POST',
          body: JSON.stringify({ trackId: track.id }),
        });
        setCreatingNew(false);
        setNewPlaylistName('');
        await loadPlaylists();
        onUpdated?.();
      }
    } catch (err: any) {
      alert(err.message || 'Ошибка создания плейлиста');
    } finally {
      setSavingNew(false);
    }
  };

  if (!isOpen || !track) return null;

  const filteredPlaylists = playlists.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase().trim())
  );

  const savedPlaylists = filteredPlaylists.filter((p) => p.has_track === 1);
  const otherPlaylists = filteredPlaylists.filter((p) => p.has_track === 0);

  const formatCount = (cnt: number) => {
    if (cnt % 10 === 1 && cnt % 100 !== 11) return `${cnt} трек`;
    if ([2, 3, 4].includes(cnt % 10) && ![12, 13, 14].includes(cnt % 100)) return `${cnt} трека`;
    return `${cnt} треков`;
  };

  return (
    <div className="fixed inset-0 z-50 bg-cat-crust/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="bg-cat-mantle border border-cat-surface1/40 rounded-3xl p-5 max-w-sm w-full shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-cat-surface0/60">
          <div>
            <h3 className="font-bold text-base text-cat-text">Добавить в плейлист</h3>
            <p className="text-xs text-cat-subtext0 truncate max-w-[240px]">
              {track.artist} — {track.title}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-cat-subtext0 hover:text-cat-text hover:bg-cat-surface0 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search input */}
        <div className="relative mt-3">
          <Search className="w-4 h-4 text-cat-subtext0 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск плейлиста"
            className="w-full bg-cat-surface0/70 border border-cat-surface1/30 rounded-2xl pl-10 pr-3.5 py-2 text-xs text-cat-text placeholder-cat-subtext0 focus:outline-none focus:border-cat-mauve transition-colors"
          />
        </div>

        {/* Create playlist toggle / form */}
        <div className="mt-3">
          {creatingNew ? (
            <form onSubmit={handleCreatePlaylist} className="flex gap-2 items-center">
              <input
                type="text"
                autoFocus
                value={newPlaylistName}
                onChange={(e) => setNewPlaylistName(e.target.value)}
                placeholder="Название нового плейлиста"
                className="flex-1 bg-cat-surface0 border border-cat-surface1/40 rounded-xl px-3 py-1.5 text-xs text-cat-text focus:outline-none focus:border-cat-mauve"
              />
              <button
                type="submit"
                disabled={savingNew || !newPlaylistName.trim()}
                className="px-3 py-1.5 rounded-xl bg-cat-mauve text-cat-base text-xs font-bold hover:opacity-90 disabled:opacity-40"
              >
                {savingNew ? '...' : 'Создать'}
              </button>
              <button
                type="button"
                onClick={() => setCreatingNew(false)}
                className="px-2 py-1.5 text-xs text-cat-subtext0 hover:text-cat-text"
              >
                Отмена
              </button>
            </form>
          ) : (
            <button
              onClick={() => setCreatingNew(true)}
              className="flex items-center gap-2 text-xs font-semibold text-cat-text hover:text-cat-mauve transition-colors py-1.5 px-2 rounded-xl hover:bg-cat-surface0/40 w-full"
            >
              <Plus className="w-4 h-4 text-cat-mauve" />
              <span>Создать плейлист</span>
            </button>
          )}
        </div>

        {/* Playlists list */}
        <div className="flex-1 overflow-y-auto mt-2 pr-1 space-y-4 custom-scrollbar min-h-[160px]">
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2 text-cat-subtext0 text-xs">
              <Loader2 className="w-5 h-5 animate-spin text-cat-mauve" />
              <span>Загрузка плейлистов...</span>
            </div>
          ) : filteredPlaylists.length === 0 ? (
            <div className="py-10 text-center text-xs text-cat-subtext0">
              {search ? 'Плейлисты не найдены' : 'У вас пока нет созданных плейлистов'}
            </div>
          ) : (
            <>
              {/* Section 1: Сохранено в плейлистах */}
              {savedPlaylists.length > 0 && (
                <div>
                  <h4 className="text-[11px] font-semibold text-cat-subtext0 uppercase tracking-wider px-2 mb-1.5">
                    Сохранено в плейлистах
                  </h4>
                  <div className="space-y-1">
                    {savedPlaylists.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => handleToggle(p)}
                        disabled={togglingId === p.id}
                        className="w-full flex items-center justify-between p-2 rounded-2xl hover:bg-cat-surface0/60 active:scale-[0.99] transition-all text-left group"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1 pr-2">
                          <div className="w-10 h-10 rounded-xl bg-cat-surface0 overflow-hidden flex-shrink-0 flex items-center justify-center border border-cat-surface1/30">
                            {p.cover_url ? (
                              <img src={p.cover_url} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <Music2 className="w-4 h-4 text-cat-subtext0" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-cat-text truncate group-hover:text-cat-mauve transition-colors">
                              {p.name}
                            </p>
                            <p className="text-[11px] text-cat-subtext0">
                              {formatCount(p.track_count)}
                            </p>
                          </div>
                        </div>

                        <div className="shrink-0 pl-2">
                          {togglingId === p.id ? (
                            <Loader2 className="w-5 h-5 text-cat-mauve animate-spin" />
                          ) : (
                            <CheckCircle2 className="w-5 h-5 text-cat-green fill-cat-green/20" />
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Section 2: Все остальные плейлисты */}
              {otherPlaylists.length > 0 && (
                <div>
                  {savedPlaylists.length > 0 && (
                    <h4 className="text-[11px] font-semibold text-cat-subtext0 uppercase tracking-wider px-2 mb-1.5 mt-3">
                      Недавно обновлено
                    </h4>
                  )}
                  <div className="space-y-1">
                    {otherPlaylists.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => handleToggle(p)}
                        disabled={togglingId === p.id}
                        className="w-full flex items-center justify-between p-2 rounded-2xl hover:bg-cat-surface0/60 active:scale-[0.99] transition-all text-left group"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1 pr-2">
                          <div className="w-10 h-10 rounded-xl bg-cat-surface0 overflow-hidden flex-shrink-0 flex items-center justify-center border border-cat-surface1/30">
                            {p.cover_url ? (
                              <img src={p.cover_url} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <Music2 className="w-4 h-4 text-cat-subtext0" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-cat-text truncate group-hover:text-cat-mauve transition-colors">
                              {p.name}
                            </p>
                            <p className="text-[11px] text-cat-subtext0">
                              {formatCount(p.track_count)}
                            </p>
                          </div>
                        </div>

                        <div className="shrink-0 pl-2">
                          {togglingId === p.id ? (
                            <Loader2 className="w-5 h-5 text-cat-mauve animate-spin" />
                          ) : (
                            <Circle className="w-5 h-5 text-cat-surface2 group-hover:text-cat-subtext0 transition-colors" />
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-cat-surface0/60 mt-3 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-2xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-text text-xs font-bold transition-colors"
          >
            Готово
          </button>
        </div>
      </div>
    </div>
  );
};
