import React, { useState, useEffect } from 'react';
import { Play, Shuffle, Download, Check, Music2, Loader2 } from 'lucide-react';
import { Playlist, Track } from '../types';
import { isPlaylistDownloaded, downloadPlaylistOffline, removePlaylistOffline } from '../utils/offline';

interface PlaylistHeaderProps {
  playlist: Playlist;
  tracks: Track[];
  activeJob?: any;
  onPlayAll: () => void;
  onShuffleAll: () => void;
}

export const PlaylistHeader: React.FC<PlaylistHeaderProps> = ({
  playlist,
  tracks,
  activeJob,
  onPlayAll,
  onShuffleAll,
}) => {
  const [downloaded, setDownloaded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progressText, setProgressText] = useState('');

  useEffect(() => {
    setDownloaded(isPlaylistDownloaded(playlist.id));
  }, [playlist.id]);

  const handleToggleDownload = async () => {
    if (downloading) return;

    if (downloaded) {
      await removePlaylistOffline(playlist.id, tracks);
      setDownloaded(false);
    } else {
      setDownloading(true);
      try {
        await downloadPlaylistOffline(playlist.id, tracks, (done, total) => {
          setProgressText(`${done}/${total}`);
        });
        setDownloaded(true);
      } catch (e: any) {
        alert(e.message || 'Ошибка сохранения оффлайн');
      } finally {
        setDownloading(false);
        setProgressText('');
      }
    }
  };

  return (
    <div className="flex flex-col md:flex-row items-center md:items-end gap-5 mb-6 pt-2 select-none">
      {/* Cover Art */}
      <div className="w-44 h-44 md:w-52 md:h-52 rounded-3xl bg-cat-surface0 shadow-2xl overflow-hidden flex-shrink-0 flex items-center justify-center border border-cat-surface1/30">
        {playlist.cover_url ? (
          <img src={playlist.cover_url} alt="" className="w-full h-full object-cover" />
        ) : (
          <Music2 className="w-20 h-20 text-cat-mauve/40" />
        )}
      </div>

      {/* Info & Action Buttons */}
      <div className="flex-1 text-center md:text-left min-w-0">
        <span className="text-xs uppercase tracking-wider text-cat-subtext0 font-semibold">
          Плейлист
        </span>
        <h1 className="text-2xl md:text-4xl font-extrabold text-cat-text mt-1 truncate">
          {playlist.name}
        </h1>
        {playlist.description && (
          <p className="text-sm text-cat-subtext0 mt-1 line-clamp-2">
            {playlist.description}
          </p>
        )}
        <div className="text-xs text-cat-subtext0 mt-2 flex items-center justify-center md:justify-start gap-2">
          {activeJob && activeJob.status === 'downloading' ? (
            <span className="text-cat-mauve font-semibold flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Загружено {tracks.length} из {activeJob.total_tracks} треков
            </span>
          ) : (
            <span>{tracks.length} треков</span>
          )}
        </div>

        {/* Buttons Row */}
        <div className="flex items-center justify-center md:justify-start gap-3 mt-4">
          <button
            onClick={onPlayAll}
            disabled={tracks.length === 0}
            className="flex items-center gap-2 px-6 py-3 rounded-full bg-cat-mauve text-cat-base font-bold hover:opacity-95 active:scale-95 transition-all shadow-lg shadow-cat-mauve/20 disabled:opacity-40"
          >
            <Play className="w-5 h-5 fill-current" />
            Слушать
          </button>

          <button
            onClick={onShuffleAll}
            disabled={tracks.length === 0}
            title="Перемешать"
            className="p-3 rounded-full bg-cat-surface0 hover:bg-cat-surface1 text-cat-text active:scale-95 transition-all disabled:opacity-40"
          >
            <Shuffle className="w-5 h-5" />
          </button>

          <button
            onClick={handleToggleDownload}
            disabled={tracks.length === 0 || downloading}
            title={downloaded ? 'Удалить из оффлайн' : 'Скачать весь плейлист оффлайн'}
            className={`flex items-center gap-1.5 p-3 rounded-full active:scale-95 transition-all disabled:opacity-40 ${
              downloaded
                ? 'bg-cat-green/20 text-cat-green border border-cat-green/30'
                : 'bg-cat-surface0 hover:bg-cat-surface1 text-cat-subtext0 hover:text-cat-text'
            }`}
          >
            {downloading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin text-cat-mauve" />
                <span className="text-xs font-mono">{progressText}</span>
              </>
            ) : downloaded ? (
              <Check className="w-5 h-5" />
            ) : (
              <Download className="w-5 h-5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
