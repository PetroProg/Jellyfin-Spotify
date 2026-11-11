import React, { useState, useEffect, useRef } from 'react';
import { Search, Plus, CheckCircle2, Circle, Loader2, Music2, X, Heart } from 'lucide-react';
import { Track, SpotifySearchResult } from '../types';
import { apiRequest } from '../api/client';
import { toast } from '../store/toastStore';
import { useOfflineStore } from '../store/offlineStore';
import { usePlayerStore } from '../store/playerStore';
import { useI18nStore, formatTrackCount } from '../store/i18nStore';
import {
  shouldTrackBeCachedOffline,
  addTrackToOfflinePlaylist,
  removeTrackFromOfflinePlaylist,
  getAllPlaylistsCache,
  getOfflinePlaylistData,
  updateCachedPlaylistCount,
} from '../utils/offline';

interface PlaylistWithStatus {
  id: number;
  name: string;
  cover_url?: string;
  track_count: number;
  has_track: number; // 1 or 0
}

interface AddToPlaylistModalProps {
  track: Track | null;
  spotifyTrack?: SpotifySearchResult | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdated?: () => void;
  onSpotifyTrackDownloaded?: (spotifyTrack: SpotifySearchResult, localTrack: Track) => void;
}

export const AddToPlaylistModal: React.FC<AddToPlaylistModalProps> = ({
  track,
  spotifyTrack,
  isOpen,
  onClose,
  onUpdated,
  onSpotifyTrackDownloaded,
}) => {
  const { lang, t, td } = useI18nStore();
  const [activeTrack, setActiveTrack] = useState<Track | null>(track);
  const [playlists, setPlaylists] = useState<PlaylistWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const pendingToggles = useRef<Map<number, number>>(new Map());
  const [optimisticSpotifyLiked, setOptimisticSpotifyLiked] = useState<boolean | null>(null);

  const { likedTrackIds, toggleLikeTrack } = usePlayerStore();
  const rawLiked = activeTrack
    ? likedTrackIds.includes(activeTrack.id)
    : (spotifyTrack?.local_track ? likedTrackIds.includes(spotifyTrack.local_track.id) : false);
  const isLiked = optimisticSpotifyLiked !== null ? optimisticSpotifyLiked : rawLiked;

  // New playlist inline creation
  const [creatingNew, setCreatingNew] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [savingNew, setSavingNew] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const current = track || spotifyTrack?.local_track || null;
      setActiveTrack(current);
      setSearch('');
      setCreatingNew(false);
      setNewPlaylistName('');
      pendingToggles.current.clear();
      setOptimisticSpotifyLiked(null);
      loadPlaylists(current?.id || 0);
    }
  }, [isOpen, track?.id, spotifyTrack?.id]);

  const loadPlaylists = async (tId: number = 0) => {
    // 1. Instantly render from local cache if available (0 ms)
    const cached = getAllPlaylistsCache();
    if (cached && cached.length > 0) {
      const offlineList: PlaylistWithStatus[] = cached
        .filter((p) => !p.name.toLowerCase().includes('daily mix') && !(p as any).is_daily_mix)
        .map((p) => {
          const hasFromCache = tId > 0 && getOfflinePlaylistData(p.id)?.tracks?.some((t) => t.id === tId) ? 1 : 0;
          const hasFinal = pendingToggles.current.has(p.id) ? pendingToggles.current.get(p.id)! : hasFromCache;
          return {
            ...p,
            track_count: p.track_count ?? 0,
            has_track: hasFinal,
          };
        });
      setPlaylists(offlineList);
      setLoading(false);
    } else {
      setLoading(true);
    }

    try {
      const data = await apiRequest<{ playlists: PlaylistWithStatus[] }>(`/tracks/${tId || 0}/playlists`, {
        silentOffline: true,
      });
      const filtered = (data.playlists || []).filter(
        (p) =>
          !p.name.toLowerCase().includes('daily mix') &&
          !p.name.toLowerCase().includes('ежедневный микс') &&
          !p.name.toLowerCase().includes('микс дня') &&
          !(p as any).is_daily_mix
      );
      if (filtered.length > 0) {
        // Merge with any user actions taken during this modal session
        const merged = filtered.map((p) => {
          if (pendingToggles.current.has(p.id)) {
            const desiredHasTrack = pendingToggles.current.get(p.id)!;
            const diff = desiredHasTrack - p.has_track;
            return {
              ...p,
              has_track: desiredHasTrack,
              track_count: Math.max(0, p.track_count + diff),
            };
          }
          return p;
        });
        setPlaylists(merged);
      }
    } catch (e) {
      console.warn('[Load playlists error]:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleLikedSongs = async () => {
    try {
      if (activeTrack) {
        const isCurrentLiked = likedTrackIds.includes(activeTrack.id);
        const targetState = !isCurrentLiked;

        // 1. Instant store update (optimistic 0ms update in Zustand and localStorage)
        toggleLikeTrack(activeTrack.id, activeTrack, targetState).catch((err) => {
          console.warn('[Toggle like error]:', err);
        });

        // 2. Instant offline cache update
        if (targetState) {
          const shouldCache = shouldTrackBeCachedOffline(activeTrack.id, -1, [...likedTrackIds, activeTrack.id]);
          if (shouldCache) {
            useOfflineStore.getState().cacheTrack(activeTrack).catch(() => {});
            addTrackToOfflinePlaylist(-1, activeTrack);
            toast.success(t('Track added to Liked Songs and saved offline', 'Трек добавлен в любимые и сохранен оффлайн'));
          } else {
            toast.success(t('Added to Liked Songs', 'Добавлено в любимые треки'));
          }
        } else {
          removeTrackFromOfflinePlaylist(-1, activeTrack.id);
          toast.success(t('Removed from Liked Songs', 'Удалено из любимых треков'));
        }
        onUpdated?.();
      } else if (spotifyTrack) {
        const targetState = !isLiked;
        setOptimisticSpotifyLiked(targetState);

        if (targetState) {
          toast.success(t('Added to Liked Songs (downloading in background)', 'Добавлено в любимые треки (скачивание в фоне)'));
          apiRequest<{ success: boolean; track: Track; liked?: boolean }>('/tracks/download-single', {
            method: 'POST',
            body: JSON.stringify({
              track: spotifyTrack,
              isLikedOnly: true,
            }),
            timeoutMs: 300000,
          }).then(async (res) => {
            if (res.success && res.track) {
              setActiveTrack(res.track);
              const currentLiked = usePlayerStore.getState().likedTrackIds;
              if (!currentLiked.includes(res.track.id)) {
                const nextLiked = [...currentLiked, res.track.id];
                usePlayerStore.setState({ likedTrackIds: nextLiked });
                try {
                  localStorage.setItem('jellyfy_cached_liked_ids', JSON.stringify(nextLiked));
                } catch (_) {}
              }
              onSpotifyTrackDownloaded?.(spotifyTrack, res.track);
              onUpdated?.();

              const shouldCache = shouldTrackBeCachedOffline(res.track.id, -1, [...currentLiked, res.track.id]);
              if (shouldCache) {
                await useOfflineStore.getState().cacheTrack(res.track);
                addTrackToOfflinePlaylist(-1, res.track);
              }
            }
          }).catch((err) => {
            setOptimisticSpotifyLiked(false);
            toast.error(err.message || t('Error updating Liked Songs', 'Ошибка обновления любимых треков'));
          });
        }
      }
    } catch (err: any) {
      toast.error(err.message || t('Error updating Liked Songs', 'Ошибка обновления любимых треков'));
    }
  };

  const handleToggle = (playlist: PlaylistWithStatus) => {
    const displayPlaylistName = td(playlist.name);

    // 1. If active local track is available
    if (activeTrack) {
      const isCurrentlyAdded = playlist.has_track === 1;
      const nextHasTrack = isCurrentlyAdded ? 0 : 1;
      const nextCount = Math.max(0, playlist.track_count + (isCurrentlyAdded ? -1 : 1));

      // Record optimistic intent
      pendingToggles.current.set(playlist.id, nextHasTrack);

      // Instant optimistic UI update (0ms!)
      setPlaylists((prev) =>
        prev.map((p) =>
          p.id === playlist.id
            ? {
                ...p,
                has_track: nextHasTrack,
                track_count: nextCount,
              }
            : p
        )
      );

      // Instant local offline cache update (0ms!)
      if (nextHasTrack === 1) {
        addTrackToOfflinePlaylist(playlist.id, activeTrack);
        updateCachedPlaylistCount(playlist.id, 1);

        const shouldCache = shouldTrackBeCachedOffline(activeTrack.id, playlist.id, likedTrackIds);
        if (shouldCache) {
          useOfflineStore.getState().cacheTrack(activeTrack).catch(() => {});
          toast.success(
            t(
              `Track added to "${displayPlaylistName}" and saved offline`,
              `Трек добавлен в «${displayPlaylistName}» и сохранен оффлайн`
            )
          );
        } else {
          toast.success(
            t(`Track added to "${displayPlaylistName}"`, `Трек добавлен в «${displayPlaylistName}»`)
          );
        }
      } else {
        removeTrackFromOfflinePlaylist(playlist.id, activeTrack.id);
        updateCachedPlaylistCount(playlist.id, -1);
        toast.success(
          t(`Track removed from "${displayPlaylistName}"`, `Трек удален из «${displayPlaylistName}»`)
        );
      }
      onUpdated?.();

      // Background network sync (automatically absorbed into Outbox if slow/offline)
      const syncPromise = nextHasTrack === 1
        ? apiRequest(`/playlists/${playlist.id}/tracks`, {
            method: 'POST',
            body: JSON.stringify({ trackId: activeTrack.id }),
            coalesceKey: `pl_track_${playlist.id}_${activeTrack.id}`,
            actionType: 'ADD_PLAYLIST_TRACK',
            queueIfOffline: true,
          })
        : apiRequest(`/playlists/${playlist.id}/tracks/${activeTrack.id}`, {
            method: 'DELETE',
            coalesceKey: `pl_track_${playlist.id}_${activeTrack.id}`,
            actionType: 'REMOVE_PLAYLIST_TRACK',
            queueIfOffline: true,
          });

      syncPromise.catch((err: any) => {
        console.warn('[Background playlist sync error]:', err);
        // Only rollback on permanent client errors (e.g. 400 blacklisted or 404 deleted)
        if (err?.status && err.status >= 400 && err.status < 500) {
          pendingToggles.current.delete(playlist.id);
          setPlaylists((prev) =>
            prev.map((p) =>
              p.id === playlist.id
                ? {
                    ...p,
                    has_track: isCurrentlyAdded ? 1 : 0,
                    track_count: playlist.track_count,
                  }
                : p
            )
          );
          if (nextHasTrack === 1) {
            removeTrackFromOfflinePlaylist(playlist.id, activeTrack.id);
            updateCachedPlaylistCount(playlist.id, -1);
          } else {
            addTrackToOfflinePlaylist(playlist.id, activeTrack);
            updateCachedPlaylistCount(playlist.id, 1);
          }
          toast.error(err.message || t('Failed to update playlist', 'Не удалось обновить плейлист'));
        }
      });
      return;
    }

    // 2. If Spotify track not yet downloaded
    if (spotifyTrack) {
      const isCurrentlyAdded = playlist.has_track === 1;
      const nextHasTrack = isCurrentlyAdded ? 0 : 1;
      const nextCount = Math.max(0, playlist.track_count + (isCurrentlyAdded ? -1 : 1));

      pendingToggles.current.set(playlist.id, nextHasTrack);

      // Instant optimistic UI update (0ms!)
      setPlaylists((prev) =>
        prev.map((p) =>
          p.id === playlist.id
            ? {
                ...p,
                has_track: nextHasTrack,
                track_count: nextCount,
              }
            : p
        )
      );

      if (nextHasTrack === 1) {
        toast.success(
          t(
            `Track added to "${displayPlaylistName}" (downloading in background)`,
            `Трек добавлен в «${displayPlaylistName}» (скачивание в фоне)`
          )
        );

        apiRequest<{ success: boolean; track: Track }>('/tracks/download-single', {
          method: 'POST',
          body: JSON.stringify({
            track: spotifyTrack,
            playlistId: playlist.id,
          }),
          timeoutMs: 300000,
        }).then((res) => {
          if (res.success && res.track) {
            setActiveTrack(res.track);
            addTrackToOfflinePlaylist(playlist.id, res.track);
            updateCachedPlaylistCount(playlist.id, 1);
            onSpotifyTrackDownloaded?.(spotifyTrack, res.track);
            onUpdated?.();

            const shouldCache = shouldTrackBeCachedOffline(res.track.id, playlist.id, usePlayerStore.getState().likedTrackIds);
            if (shouldCache) {
              useOfflineStore.getState().cacheTrack(res.track).catch(() => {});
            }
          }
        }).catch((err) => {
          console.warn('[Spotify background download error]:', err);
          pendingToggles.current.delete(playlist.id);
          setPlaylists((prev) =>
            prev.map((p) =>
              p.id === playlist.id
                ? { ...p, has_track: 0, track_count: playlist.track_count }
                : p
            )
          );
          toast.error(err.message || t('Error downloading track', 'Ошибка скачивания трека'));
        });
      }
    }
  };

  const handleCreatePlaylist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlaylistName.trim() || savingNew) return;
    setSavingNew(true);

    try {
      const res = await apiRequest<{ id: number; name: string }>('/playlists', {
        method: 'POST',
        body: JSON.stringify({ name: newPlaylistName.trim() }),
      });

      if (res.id) {
        if (activeTrack) {
          // Add current track to newly created playlist
          await apiRequest(`/playlists/${res.id}/tracks`, {
            method: 'POST',
            body: JSON.stringify({ trackId: activeTrack.id }),
          });
          setCreatingNew(false);
          setNewPlaylistName('');
          await loadPlaylists(activeTrack.id);
          onUpdated?.();
        } else if (spotifyTrack) {
          // Download Spotify track directly and attach to the newly created playlist
          const dlRes = await apiRequest<{ success: boolean; track: Track }>('/tracks/download-single', {
            method: 'POST',
            body: JSON.stringify({
              track: spotifyTrack,
              playlistId: res.id,
            }),
            timeoutMs: 300000,
          });
          if (dlRes.success && dlRes.track) {
            setActiveTrack(dlRes.track);
            onSpotifyTrackDownloaded?.(spotifyTrack, dlRes.track);
          }
          setCreatingNew(false);
          setNewPlaylistName('');
          await loadPlaylists(dlRes.track?.id || 0);
          onUpdated?.();
        }
      }
    } catch (err: any) {
      toast.error(err.message || t('Error creating playlist', 'Ошибка создания плейлиста'));
    } finally {
      setSavingNew(false);
    }
  };

  if (!isOpen || (!track && !spotifyTrack)) return null;

  const displayArtist = activeTrack?.artist || spotifyTrack?.artist || '';
  const displayTitle = activeTrack?.title || spotifyTrack?.title || '';

  const filteredPlaylists = playlists.filter((p) => {
    const q = search.toLowerCase().trim();
    return p.name.toLowerCase().includes(q) || td(p.name).toLowerCase().includes(q);
  });

  const savedPlaylists = filteredPlaylists.filter((p) => p.has_track === 1);
  const otherPlaylists = filteredPlaylists.filter((p) => p.has_track === 0);

  const showLikedSongs =
    !search.trim() ||
    'любимые треки'.includes(search.toLowerCase()) ||
    'liked songs'.includes(search.toLowerCase()) ||
    t('Liked Songs', 'Любимые треки').toLowerCase().includes(search.toLowerCase());

  return (
    <div className="fixed inset-0 z-50 bg-cat-crust/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="bg-cat-mantle border border-cat-surface1/40 rounded-3xl p-5 max-w-sm w-full shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-cat-surface0/60">
          <div>
            <h3 className="font-bold text-base text-cat-text">{t('Add to Playlist', 'Добавить в плейлист')}</h3>
            <p className="text-xs text-cat-subtext0 truncate max-w-[240px]">
              {displayArtist} — {displayTitle}
            </p>
            {!activeTrack && spotifyTrack && (
              <span className="text-[10px] text-cat-mauve block mt-0.5 font-medium">
                {t('⚡ Will download automatically when selected', '⚡ Скачается автоматически при выборе')}
              </span>
            )}
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
            placeholder={t('Find a playlist', 'Поиск плейлиста')}
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
                placeholder={t('New playlist name', 'Название нового плейлиста')}
                className="flex-1 bg-cat-surface0 border border-cat-surface1/40 rounded-xl px-3 py-1.5 text-xs text-cat-text focus:outline-none focus:border-cat-mauve"
              />
              <button
                type="submit"
                disabled={savingNew || !newPlaylistName.trim()}
                className="px-3 py-1.5 rounded-xl bg-cat-mauve text-cat-base text-xs font-bold hover:opacity-90 disabled:opacity-40"
              >
                {savingNew ? '...' : t('Create', 'Создать')}
              </button>
              <button
                type="button"
                onClick={() => setCreatingNew(false)}
                className="px-2 py-1.5 text-xs text-cat-subtext0 hover:text-cat-text"
              >
                {t('Cancel', 'Отмена')}
              </button>
            </form>
          ) : (
            <button
              onClick={() => setCreatingNew(true)}
              className="flex items-center gap-2 text-xs font-semibold text-cat-text hover:text-cat-mauve transition-colors py-1.5 px-2 rounded-xl hover:bg-cat-surface0/40 w-full"
            >
              <Plus className="w-4 h-4 text-cat-mauve" />
              <span>{t('New Playlist', 'Создать плейлист')}</span>
            </button>
          )}
        </div>

        {/* Playlists list */}
        <div className="flex-1 overflow-y-auto mt-2 pr-1 space-y-3 custom-scrollbar min-h-[160px]">
          {/* Special Section: Любимые треки */}
          {showLikedSongs && (
            <div className="pb-1 border-b border-cat-surface0/60">
              <button
                onClick={handleToggleLikedSongs}
                className="w-full flex items-center justify-between p-2 rounded-2xl hover:bg-cat-surface0/60 active:scale-[0.99] transition-all text-left group cursor-pointer"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1 pr-2">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cat-red/25 to-cat-pink/15 overflow-hidden flex-shrink-0 flex items-center justify-center border border-cat-red/30 shadow-inner">
                    <Heart className={`w-5 h-5 ${isLiked ? 'fill-cat-red text-cat-red' : 'text-cat-red'}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-cat-text truncate group-hover:text-cat-red transition-colors flex items-center gap-1.5">
                      <span>{t('Liked Songs', 'Любимые треки')}</span>
                      {useOfflineStore.getState().isDownloaded(-1) && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-cat-green/20 text-cat-green font-medium">
                          {t('Offline', 'Оффлайн')}
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] text-cat-subtext0">
                      {isLiked ? t('In your library', 'В вашей медиатеке') : t('Tap to save to favorites', 'Нажмите, чтобы добавить')}
                    </p>
                  </div>
                </div>

                <div className="shrink-0 pl-2">
                  {isLiked ? (
                    <CheckCircle2 className="w-5 h-5 text-cat-red fill-cat-red/20" />
                  ) : (
                    <Circle className="w-5 h-5 text-cat-surface2 group-hover:text-cat-subtext0 transition-colors" />
                  )}
                </div>
              </button>
            </div>
          )}

          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2 text-cat-subtext0 text-xs">
              <Loader2 className="w-5 h-5 animate-spin text-cat-mauve" />
              <span>{t('Loading playlists...', 'Загрузка плейлистов...')}</span>
            </div>
          ) : filteredPlaylists.length === 0 ? (
            <div className="py-10 text-center text-xs text-cat-subtext0">
              {search ? t('No playlists found', 'Плейлисты не найдены') : t('You have not created any playlists yet', 'У вас пока нет созданных плейлистов')}
            </div>
          ) : (
            <>
              {/* Section 1: Сохранено в плейлистах */}
              {savedPlaylists.length > 0 && (
                <div>
                  <h4 className="text-[11px] font-semibold text-cat-subtext0 uppercase tracking-wider px-2 mb-1.5">
                    {t('Saved in', 'Сохранено в плейлистах')}
                  </h4>
                  <div className="space-y-1">
                    {savedPlaylists.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => handleToggle(p)}
                        className="w-full flex items-center justify-between p-2 rounded-2xl hover:bg-cat-surface0/60 active:scale-[0.99] transition-all text-left group cursor-pointer"
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
                              {td(p.name)}
                            </p>
                            <p className="text-[11px] text-cat-subtext0">
                              {formatTrackCount(p.track_count, lang)}
                            </p>
                          </div>
                        </div>

                        <div className="shrink-0 pl-2">
                          <CheckCircle2 className="w-5 h-5 text-cat-green fill-cat-green/20" />
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
                      {t('Recently Updated', 'Недавно обновлено')}
                    </h4>
                  )}
                  <div className="space-y-1">
                    {otherPlaylists.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => handleToggle(p)}
                        className="w-full flex items-center justify-between p-2 rounded-2xl hover:bg-cat-surface0/60 active:scale-[0.99] transition-all text-left group cursor-pointer"
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
                              {td(p.name)}
                            </p>
                            <p className="text-[11px] text-cat-subtext0">
                              {formatTrackCount(p.track_count, lang)}
                            </p>
                          </div>
                        </div>

                        <div className="shrink-0 pl-2">
                          <Circle className="w-5 h-5 text-cat-surface2 group-hover:text-cat-subtext0 transition-colors" />
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
            className="px-5 py-2 rounded-2xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-text text-xs font-bold transition-colors cursor-pointer active:scale-95"
          >
            {t('Done', 'Готово')}
          </button>
        </div>
      </div>
    </div>
  );
};
