import React, { useState, useEffect } from 'react';
import { Search, Download, Loader2, Play, Music2, ExternalLink } from 'lucide-react';
import { DownloadJob, Track } from '../types';
import { apiRequest } from '../api/client';
import { TrackRow } from '../components/TrackRow';
import { usePlayerStore } from '../store/playerStore';

interface SearchImportProps {
  onOpenPlaylist: (id: number) => void;
}

export const SearchImport: React.FC<SearchImportProps> = ({ onOpenPlaylist }) => {
  const [spotifyUrl, setSpotifyUrl] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [searching, setSearching] = useState(false);

  const { playTrack } = usePlayerStore();

  const loadJobs = async () => {
    try {
      const data = await apiRequest<{ jobs: DownloadJob[] }>('/spotify/jobs');
      setJobs(data.jobs || []);
    } catch (e) {
      console.warn(e);
    }
  };

  useEffect(() => {
    loadJobs();
    const interval = setInterval(loadJobs, 2500);
    return () => clearInterval(interval);
  }, []);

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

  return (
    <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 pb-28 md:pb-24 select-none custom-scrollbar">
      {/* Page Title */}
      <h1 className="text-2xl md:text-3xl font-extrabold text-cat-text mb-6">
        Поиск & Импорт Spotify
      </h1>

      {/* Spotify Import Box */}
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
          <h3 className="text-sm font-bold uppercase tracking-wider text-cat-subtext0 mb-3">
            Очередь скачивания на сервер
          </h3>
          <div className="space-y-3">
            {jobs.map((job) => {
              const percent = job.total_tracks > 0 ? Math.round((job.downloaded_tracks / job.total_tracks) * 100) : 0;
              return (
                <div
                  key={job.id}
                  className="bg-cat-mantle p-4 rounded-2xl border border-cat-surface0/60 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
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

                  {job.playlist_id && (
                    <button
                      onClick={() => onOpenPlaylist(job.playlist_id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cat-surface0 text-xs font-semibold text-cat-mauve hover:bg-cat-surface1 transition-colors flex-shrink-0"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      Слушать
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
