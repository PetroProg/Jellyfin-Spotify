import React from 'react';
import { Play, MoreHorizontal, Music2, Heart } from 'lucide-react';
import { Track } from '../types';
import { usePlayerStore } from '../store/playerStore';
import { useI18nStore } from '../store/i18nStore';

interface TrackRowProps {
  track: Track;
  index: number;
  playlistName?: string;
  onPlay: () => void;
  onOpenMenu: (e: React.MouseEvent, track: Track) => void;
}

export const TrackRow: React.FC<TrackRowProps> = ({
  track,
  index,
  onPlay,
  onOpenMenu,
}) => {
  const { currentTrack, isPlaying, likedTrackIds, toggleLikeTrack } = usePlayerStore();
  const { lang, t } = useI18nStore();
  const isCurrent = currentTrack?.id === track.id;
  const isLiked = likedTrackIds.includes(track.id);

  const formatDuration = (ms: number) => {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr.includes('T') ? dateStr : `${dateStr.replace(' ', 'T')}Z`);
      if (isNaN(d.getTime())) return '-';
      return d.toLocaleDateString(lang === 'en' ? 'en-US' : 'ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return '-';
    }
  };

  const displayAlbum = track.album || '-';

  return (
    <div
      onClick={onPlay}
      className={`group flex items-center justify-between px-3 py-2.5 rounded-2xl cursor-pointer transition-all ${
        isCurrent
          ? 'bg-cat-surface0/90 text-cat-mauve'
          : 'hover:bg-cat-surface0/50 text-cat-text'
      }`}
    >
      {/* Col 1: Index / Play Icon & Cover & Title (+ mobile artist) */}
      <div className="flex items-center gap-3 min-w-0 flex-1 md:w-2/5 md:flex-initial pr-2">
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
          <p className="text-xs text-cat-subtext0 truncate mt-0.5 md:hidden">
            {track.artist}
          </p>
        </div>
      </div>

      {/* Col 2: Artist (desktop md+) */}
      <div className="hidden md:block w-1/5 text-xs text-cat-subtext0 hover:text-cat-text truncate pr-3 transition-colors">
        {track.artist}
      </div>

      {/* Col 3: Album (desktop lg+) */}
      <div className="hidden lg:block w-1/5 text-xs text-cat-subtext0 truncate pr-3">
        {displayAlbum}
      </div>

      {/* Col 4: Date Added (desktop xl+) */}
      <div className="hidden xl:block w-28 text-xs text-cat-subtext0/80 truncate pr-3 font-sans">
        {formatDate(track.added_at)}
      </div>

      {/* Col 5: Duration & Heart & 3-Dots Menu */}
      <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleLikeTrack(track.id, track);
          }}
          title={isLiked ? t('Remove from Liked', 'Удалить из любимых') : t('Save to Liked Songs', 'В любимые треки')}
          className={`p-1.5 rounded-lg transition-all cursor-pointer active:scale-95 ${
            isLiked
              ? 'text-cat-red hover:opacity-80'
              : 'text-cat-subtext0/60 hover:text-cat-red opacity-0 group-hover:opacity-100 hover:bg-cat-surface1/40'
          }`}
        >
          <Heart className={`w-4 h-4 ${isLiked ? 'fill-current' : ''}`} />
        </button>

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
