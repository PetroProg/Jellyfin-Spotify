import React from 'react';
import { Play, Pause, MoreHorizontal, Music2 } from 'lucide-react';
import { Track } from '../types';
import { usePlayerStore } from '../store/playerStore';

interface TrackRowProps {
  track: Track;
  index: number;
  onPlay: () => void;
  onOpenMenu: (e: React.MouseEvent, track: Track) => void;
}

export const TrackRow: React.FC<TrackRowProps> = ({
  track,
  index,
  onPlay,
  onOpenMenu,
}) => {
  const { currentTrack, isPlaying } = usePlayerStore();
  const isCurrent = currentTrack?.id === track.id;

  const formatDuration = (ms: number) => {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  return (
    <div
      onClick={onPlay}
      className={`group flex items-center justify-between px-3 py-2.5 rounded-2xl cursor-pointer transition-all ${
        isCurrent
          ? 'bg-cat-surface0/90 text-cat-mauve'
          : 'hover:bg-cat-surface0/50 text-cat-text'
      }`}
    >
      {/* Left: Index / Play Icon & Title/Artist */}
      <div className="flex items-center gap-3 min-w-0 flex-1 pr-2">
        <div className="w-6 text-center text-xs font-mono text-cat-subtext0 flex-shrink-0">
          {isCurrent && isPlaying ? (
            <div className="flex items-center justify-center gap-0.5 h-3">
              <span className="w-0.5 h-full bg-cat-mauve animate-pulse" />
              <span className="w-0.5 h-2 bg-cat-mauve animate-pulse" />
              <span className="w-0.5 h-3 bg-cat-mauve animate-pulse" />
            </div>
          ) : (
            <span className="group-hover:hidden">{index + 1}</span>
          )}
          <Play className="w-3.5 h-3.5 fill-current hidden group-hover:block mx-auto text-cat-text" />
        </div>

        <div className="w-10 h-10 rounded-xl bg-cat-mantle overflow-hidden flex-shrink-0 flex items-center justify-center border border-cat-surface1/20">
          {track.cover_url ? (
            <img src={track.cover_url} alt="" className="w-full h-full object-cover" />
          ) : (
            <Music2 className="w-4 h-4 text-cat-subtext0" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <h4 className={`text-sm font-medium truncate ${isCurrent ? 'text-cat-mauve font-semibold' : 'text-cat-text'}`}>
            {track.title}
          </h4>
          <p className="text-xs text-cat-subtext0 truncate mt-0.5">
            {track.artist}
          </p>
        </div>
      </div>

      {/* Middle: Album (desktop only) */}
      <div className="hidden lg:block w-1/4 text-xs text-cat-subtext0 truncate pr-4">
        {track.album || '-'}
      </div>

      {/* Right: Duration & 3-Dots Menu */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <span className="text-xs font-mono text-cat-subtext0">
          {formatDuration(track.duration_ms)}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenMenu(e, track);
          }}
          className="p-1.5 rounded-lg text-cat-subtext0 hover:text-cat-text hover:bg-cat-surface1/40 transition-colors"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
