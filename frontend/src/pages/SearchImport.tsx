import React, { useState, useEffect } from 'react';
import {
  Search,
  Download,
  Loader2,
  Play,
  Music2,
  ExternalLink,
  ArrowLeft,
  X,
  Trash2,
  Check,
  MoreHorizontal,
  Sparkles,
  Library,
  ListPlus
} from 'lucide-react';
import { DownloadJob, Track, SpotifySearchResult } from '../types';
import { apiRequest } from '../api/client';
import { TrackRow } from '../components/TrackRow';
import { ContextMenu } from '../components/ContextMenu';
import { AddToPlaylistModal } from '../components/AddToPlaylistModal';
import { usePlayerStore } from '../store/playerStore';

interface SearchImportProps {
  onOpenPlaylist: (id: number) => void;
  onBack?: () => void;
}

export const SearchImport: React.FC<SearchImportProps> = ({ onOpenPlaylist, onBack }) => {
  const [spotifyUrl, setSpotifyUrl] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [localResults, setLocalResults] = useState<Track[]>([]);
  const [spotifyResults, setSpotifyResults] = useState<SpotifySearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [downloadingTrackId, setDownloadingTrackId] = useState<string | null>(null);

  // Modals & Menu
  const [menuState, setMenuState] = useState<{ track: Track; pos: { x: number; y: number } } | null>(null);
  const [addToPlaylistTrack, setAddToPlaylistTrack] = useState<Track | null>(null);
  const [addToPlaylistSpotify, setAddToPlaylistSpotify] = useState<SpotifySearchResult | null>(null);

  const { playTrack, addToQueue } = usePlayerStore();

  const loadJobs = async () => {
    try {
      const data = await apiRequest<{ jobs: DownloadJob[] }>('/spotify/jobs');
      setJobs(data.jobs || []);
    } catch (e) {
      console.warn(e);
    }
  };

  const handleDeleteJob = async (jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
    try {
      await apiRequest(`/spotify/jobs/${jobId}`, { method: 'DELETE' });
    } catch (e) {
      console.warn(e);
      loadJobs();
    }
  };

  const handleClearCompleted = async () => {
    setJobs((prev) => prev.filter((j) => j.status !== 'completed' && j.status !== 'failed'));
    try {
      await apiRequest('/spotify/jobs', { method: 'DELETE' });
    } catch (e) {
      console.warn(e);
      loadJobs();
    }
  };

  useEffect(() => {
    loadJobs();
    const interval = setInterval(loadJobs, 2500);
    return () => clearInterval(interval);
  }, []);

  // Debounced search effect (350ms)
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setLocalResults([]);
      setSpotifyResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await apiRequest<{
          localTracks: Track[];
          spotifyTracks: SpotifySearchResult[];
        }>(`/search?q=${encodeURIComponent(q)}`);
        setLocalResults(data.localTracks || []);
        setSpotifyResults(data.spotifyTracks || []);
      } catch (err) {
        console.warn(err);
      } finally {
        setSearching(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!spotifyUrl) return;

    setIsImporting(true);
    try {
      const res = await apiRequest('/spotify/import', {
        method: 'POST',
        body: JSON.stringify({ url: spotifyUrl })
      });
      setSpotifyUrl('');
      loadJobs();
      if (res.message) {
        alert(res.message);
      }
      if (res.playlistId) {
        onOpenPlaylist(res.playlistId);
      }
    } catch (err: any) {
      alert(err.message || 'Ошибка импорта плейлиста');
    } finally {
      setIsImporting(false);
    }
  };

  const handleDownloadSingle = async (st: SpotifySearchResult) => {
    if (downloadingTrackId) return;
    setDownloadingTrackId(st.id);

    try {
      const res = await apiRequest<{ success: boolean; track: Track }>('/tracks/download-single', {
        method: 'POST',
        body: JSON.stringify({ track: st })
      });

      if (res.success && res.track) {
        // Update Spotify results card state
        setSpotifyResults((prev) =>
          prev.map((item) =>
            item.id === st.id
              ? {
                  ...item,
                  is_downloaded: true,
                  local_track_id: res.track.id,
                  local_track: res.track
                }
              : item
          )
        );

        // Prepend to local results
        setLocalResults((prev) => [res.track, ...prev.filter((t) => t.id !== res.track.id)]);

        // Immediately start playing downloaded track
        playTrack(res.track, [res.track], 0);
      }
    } catch (err: any) {
      alert(err.message || 'Ошибка скачивания трека');
    } finally {
      setDownloadingTrackId(null);
    }
  };

  const handleSpotifyTrackDownloaded = (st: SpotifySearchResult, newTrack: Track) => {
    setSpotifyResults((prev) =>
      prev.map((item) =>
        item.id === st.id
          ? {
              ...item,
              is_downloaded: true,
              local_track_id: newTrack.id,
              local_track: newTrack
            }
          : item
      )
    );
    setLocalResults((prev) => [newTrack, ...prev.filter((t) => t.id !== newTrack.id)]);
  };

  const handleBlacklist = async (track: Track) => {
    try {
      await apiRequest('/blacklist', {
        method: 'POST',
        body: JSON.stringify({ title: track.title, artist: track.artist })
      });
      setLocalResults((prev) => prev.filter((t) => t.id !== track.id));
    } catch (e) {
      console.warn(e);
    }
  };

  const formatDuration = (ms: number) => {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const hasSearch = searchQuery.trim().length > 0;

  return (
    <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 pb-28 md:pb-24 select-none custom-scrollbar">
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

      {/* Page Title */}
      <h1 className="text-2xl md:text-3xl font-extrabold text-cat-text mb-6">
        Поиск & Импорт песен
      </h1>

      {/* Search Input Box */}
      <div className="relative mb-8">
        <div className="relative flex items-center">
          <Search className="w-5 h-5 absolute left-4 text-cat-subtext0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Поиск любых песен (в вашей медиатеке и Spotify)..."
            className="w-full bg-cat-mantle border border-cat-surface0/80 rounded-2xl pl-12 pr-12 py-3.5 text-sm text-cat-text placeholder-cat-subtext0/60 focus:outline-none focus:border-cat-mauve shadow-lg transition-all"
          />
          {searching && (
            <Loader2 className="w-4 h-4 animate-spin text-cat-mauve absolute right-11" />
          )}
          {searchQuery && (
            <button
              onClick={() => {
                setSearchQuery('');
                setLocalResults([]);
                setSpotifyResults([]);
              }}
              className="absolute right-3 p-1.5 rounded-lg text-cat-subtext0 hover:text-cat-text cursor-pointer active:scale-90"
              title="Очистить поиск"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Search Results Display */}
      {hasSearch && (
        <div className="space-y-8 mb-10 animate-in fade-in duration-200">
          {searching && localResults.length === 0 && spotifyResults.length === 0 ? (
            <div className="py-12 text-center text-cat-subtext0 text-sm flex items-center justify-center gap-2">
              <Loader2 className="w-5 h-5 animate-spin text-cat-mauve" />
              <span>Поиск «{searchQuery}»...</span>
            </div>
          ) : !searching && localResults.length === 0 && spotifyResults.length === 0 ? (
            <div className="py-10 text-center text-cat-subtext0 text-sm bg-cat-mantle/50 rounded-2xl border border-cat-surface0/40">
              По запросу «<span className="text-cat-text font-semibold">{searchQuery}</span>» ничего не найдено
            </div>
          ) : (
            <>
              {/* Section 1: In Your Library */}
              {localResults.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Library className="w-4 h-4 text-cat-green" />
                    <h3 className="text-sm font-bold uppercase tracking-wider text-cat-text">
                      В вашей медиатеке ({localResults.length})
                    </h3>
                  </div>
                  <div className="space-y-0.5">
                    {localResults.map((track, i) => (
                      <TrackRow
                        key={track.id}
                        track={track}
                        index={i}
                        onPlay={() => playTrack(track, localResults, i)}
                        onOpenMenu={(e, t) => setMenuState({ track: t, pos: { x: e.clientX, y: e.clientY } })}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Section 2: Spotify Results */}
              {spotifyResults.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Sparkles className="w-4 h-4 text-cat-mauve" />
                    <h3 className="text-sm font-bold uppercase tracking-wider text-cat-text">
                      Найдено в Spotify (каталог)
                    </h3>
                  </div>
                  <div className="space-y-2">
                    {spotifyResults.map((st) => (
                      <div
                        key={st.id}
                        className="bg-cat-mantle p-3 rounded-2xl border border-cat-surface0/60 hover:border-cat-surface1 flex items-center justify-between gap-3 group transition-all"
                      >
                        {/* Cover Art & Track Info */}
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="w-12 h-12 rounded-xl bg-cat-surface0 overflow-hidden flex-shrink-0 flex items-center justify-center border border-cat-surface1/30">
                            {st.cover_url ? (
                              <img src={st.cover_url} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <Music2 className="w-6 h-6 text-cat-mauve" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <h4 className="text-sm font-bold text-cat-text truncate">
                              {st.title}
                            </h4>
                            <p className="text-xs text-cat-subtext0 truncate mt-0.5">
                              {st.artist} {st.album ? `• ${st.album}` : ''}
                            </p>
                          </div>
                        </div>

                        {/* Duration & Action Buttons */}
                        <div className="flex items-center gap-2.5 flex-shrink-0">
                          <span className="text-[11px] font-mono text-cat-subtext0 hidden xs:inline">
                            {formatDuration(st.duration_ms)}
                          </span>

                          {st.is_downloaded ? (
                            <div className="flex items-center gap-1.5 sm:gap-2">
                              <span className="text-[11px] px-2.5 py-1 rounded-full bg-cat-green/20 text-cat-green font-semibold flex items-center gap-1">
                                <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                                <span className="hidden sm:inline">В медиатеке</span>
                              </span>
                              <button
                                onClick={() => {
                                  if (st.local_track) {
                                    playTrack(st.local_track, [st.local_track], 0);
                                  }
                                }}
                                title="Слушать"
                                className="p-2 rounded-full bg-cat-mauve text-cat-base hover:opacity-95 active:scale-95 transition-all shadow-md cursor-pointer"
                              >
                                <Play className="w-4 h-4 fill-current ml-0.5" />
                              </button>
                              <button
                                onClick={() => setAddToPlaylistTrack(st.local_track || null)}
                                title="Добавить в плейлист"
                                className="p-2 rounded-xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-subtext0 hover:text-cat-mauve transition-all cursor-pointer active:scale-95"
                              >
                                <ListPlus className="w-4 h-4" />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 sm:gap-2">
                              <button
                                onClick={() => setAddToPlaylistSpotify(st)}
                                disabled={downloadingTrackId === st.id}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cat-surface0 hover:bg-cat-surface1 border border-cat-surface1/40 text-cat-text hover:text-cat-mauve text-xs font-semibold transition-all disabled:opacity-50 cursor-pointer active:scale-95 shadow-xs"
                                title="Добавить в плейлист (трек скачается автоматически)"
                              >
                                <ListPlus className="w-3.5 h-3.5 text-cat-mauve" />
                                <span className="hidden xs:inline">В плейлист</span>
                              </button>
                              <button
                                onClick={() => handleDownloadSingle(st)}
                                disabled={downloadingTrackId === st.id}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cat-mauve/20 hover:bg-cat-mauve text-cat-mauve hover:text-cat-base text-xs font-bold transition-all disabled:opacity-50 cursor-pointer active:scale-95 shadow-xs"
                                title="Скачать на сервер в высоком качестве"
                              >
                                {downloadingTrackId === st.id ? (
                                  <>
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    <span className="hidden xs:inline">Качается...</span>
                                  </>
                                ) : (
                                  <>
                                    <Download className="w-3.5 h-3.5" />
                                    <span>Скачать</span>
                                  </>
                                )}
                              </button>
                            </div>
                          )}

                          {st.local_track && (
                            <button
                              onClick={(e) =>
                                setMenuState({
                                  track: st.local_track!,
                                  pos: { x: e.clientX, y: e.clientY }
                                })
                              }
                              title="Действия с треком"
                              className="p-1.5 rounded-xl hover:bg-cat-surface0 text-cat-subtext0 hover:text-cat-text transition-colors cursor-pointer"
                            >
                              <MoreHorizontal className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Spotify Import Playlist Box */}
      <div className="bg-cat-mantle rounded-3xl p-5 md:p-6 border border-cat-surface0/60 shadow-xl mb-8">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-cat-green/20 text-cat-green flex items-center justify-center">
            <Download className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-cat-text">Импортировать плейлист из Spotify</h2>
            <p className="text-xs text-cat-subtext0">Вставьте публичную ссылку на плейлист (open.spotify.com/playlist/...)</p>
          </div>
        </div>

        <form onSubmit={handleImport} className="flex flex-col sm:flex-row gap-3 mt-4">
          <input
            type="text"
            value={spotifyUrl}
            onChange={(e) => setSpotifyUrl(e.target.value)}
            placeholder="https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"
            className="flex-1 bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-3 text-sm text-cat-text placeholder-cat-subtext0/60 focus:outline-none focus:border-cat-mauve transition-colors"
          />
          <button
            type="submit"
            disabled={isImporting || !spotifyUrl.trim()}
            className="flex items-center justify-center gap-2 px-6 py-3 rounded-2xl bg-cat-mauve text-cat-base font-bold hover:opacity-95 active:scale-95 transition-all shadow-md disabled:opacity-40"
          >
            {isImporting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Импорт...</span>
              </>
            ) : (
              <span>Импортировать</span>
            )}
          </button>
        </form>
      </div>

      {/* Active & Recent Download Jobs */}
      {jobs.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold uppercase tracking-wider text-cat-subtext0">
              Очередь скачивания на сервер
            </h3>
            {jobs.some((j) => j.status === 'completed' || j.status === 'failed') && (
              <button
                onClick={handleClearCompleted}
                className="text-xs text-cat-subtext0 hover:text-cat-mauve transition-colors flex items-center gap-1.5 cursor-pointer py-1 px-2.5 rounded-lg hover:bg-cat-surface0 active:scale-95"
                title="Очистить все завершенные задачи"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Очистить завершенные</span>
              </button>
            )}
          </div>
          <div className="space-y-3">
            {jobs.map((job) => {
              const percent = job.total_tracks > 0 ? Math.round((job.downloaded_tracks / job.total_tracks) * 100) : 0;
              return (
                <div
                  key={job.id}
                  className="bg-cat-mantle p-4 rounded-2xl border border-cat-surface0/60 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 group"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-cat-text truncate">{job.playlist_name}</span>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                        job.status === 'completed'
                          ? 'bg-cat-green/20 text-cat-green'
                          : 'bg-cat-mauve/20 text-cat-mauve'
                      }`}>
                        {job.status === 'completed' ? 'Завершено' : 'Загрузка'}
                      </span>
                    </div>

                    {job.current_track && (
                      <p className="text-xs text-cat-subtext0 mt-1 truncate">
                        Качается: <span className="text-cat-text">{job.current_track}</span>
                      </p>
                    )}

                    {/* Progress Bar */}
                    <div className="w-full bg-cat-surface0 h-1.5 rounded-full overflow-hidden mt-2.5 max-w-md">
                      <div
                        className="bg-cat-mauve h-full transition-all duration-300"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <span className="text-[11px] font-mono text-cat-subtext0 mt-1 block">
                      {job.downloaded_tracks} из {job.total_tracks} треков ({percent}%)
                    </span>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0 self-end sm:self-center">
                    {job.playlist_id && (
                      <button
                        onClick={() => onOpenPlaylist(job.playlist_id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cat-surface0 text-xs font-semibold text-cat-mauve hover:bg-cat-surface1 transition-colors"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        Слушать
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteJob(job.id)}
                      title="Убрать из списка"
                      className="p-1.5 rounded-xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-subtext0 hover:text-cat-red transition-colors cursor-pointer active:scale-95"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Context Menu Modal */}
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

      {/* Add To Playlist Modal */}
      {(addToPlaylistTrack || addToPlaylistSpotify) && (
        <AddToPlaylistModal
          track={addToPlaylistTrack}
          spotifyTrack={addToPlaylistSpotify}
          isOpen={!!(addToPlaylistTrack || addToPlaylistSpotify)}
          onClose={() => {
            setAddToPlaylistTrack(null);
            setAddToPlaylistSpotify(null);
          }}
          onSpotifyTrackDownloaded={handleSpotifyTrackDownloaded}
        />
      )}
    </div>
  );
};
