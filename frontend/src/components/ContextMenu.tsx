import React, { useEffect, useRef } from 'react';
import { ListPlus, Ban, FolderPlus, Trash2, Heart } from 'lucide-react';
import { Track } from '../types';
import { usePlayerStore } from '../store/playerStore';
import { useI18nStore } from '../store/i18nStore';

interface ContextMenuProps {
  track: Track;
  position: { x: number; y: number };
  isLikedOverride?: boolean;
  onClose: () => void;
  onAddToQueue: (track: Track) => void;
  onAddToPlaylist?: (track: Track) => void;
  onRemoveFromPlaylist?: (track: Track) => void;
  onBlacklist: (track: Track) => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  track,
  position,
  isLikedOverride,
  onClose,
  onAddToQueue,
  onAddToPlaylist,
  onRemoveFromPlaylist,
  onBlacklist,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const { likedTrackIds, toggleLikeTrack } = usePlayerStore();
  const { t } = useI18nStore();
  const isLiked = isLikedOverride !== undefined ? isLikedOverride : likedTrackIds.includes(track.id);

  useEffect(() => {
    const handleOutsideInteraction = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleScrollOrMove = () => {
      onClose();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    // Close on click or tap outside
    document.addEventListener('mousedown', handleOutsideInteraction);
    document.addEventListener('touchstart', handleOutsideInteraction, { passive: true });

    // Close on any scroll anywhere in the window or scrollable containers
    window.addEventListener('scroll', handleScrollOrMove, { capture: true, passive: true });
    window.addEventListener('touchmove', handleScrollOrMove, { capture: true, passive: true });
    window.addEventListener('wheel', handleScrollOrMove, { passive: true });
    window.addEventListener('resize', handleScrollOrMove, { passive: true });
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleOutsideInteraction);
      document.removeEventListener('touchstart', handleOutsideInteraction);
      window.removeEventListener('scroll', handleScrollOrMove, { capture: true });
      window.removeEventListener('touchmove', handleScrollOrMove, { capture: true });
      window.removeEventListener('wheel', handleScrollOrMove);
      window.removeEventListener('resize', handleScrollOrMove);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Adjust position so it doesn't overflow screen
  const safeX = Math.max(10, Math.min(position.x, window.innerWidth - 220));
  const safeY = Math.max(10, Math.min(position.y, window.innerHeight - 260));

  return (
    <>
      {/* Invisible backdrop to dismiss menu on tap anywhere outside */}
      <div
        className="fixed inset-0 z-40 bg-transparent"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onTouchStart={(e) => {
          e.stopPropagation();
          onClose();
        }}
      />

      <div
        ref={menuRef}
        style={{ top: `${safeY}px`, left: `${safeX}px` }}
        className="fixed z-50 w-52 bg-cat-mantle/95 backdrop-blur-md rounded-2xl p-1.5 shadow-2xl border border-cat-surface0/80 text-sm select-none animate-in fade-in zoom-in-95 duration-150"
      >
        <div className="px-3 py-1.5 border-b border-cat-surface0/40 mb-1">
          <p className="font-semibold text-cat-text truncate text-xs">{track.title}</p>
          <p className="text-cat-subtext0 truncate text-[11px]">{track.artist}</p>
        </div>

        <button
          onClick={() => {
            onAddToQueue(track);
            onClose();
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-cat-text hover:bg-cat-surface0 text-left transition-colors"
        >
          <ListPlus className="w-4 h-4 text-cat-mauve" />
          {t('Add to Queue', 'В очередь')}
        </button>

        <button
          onClick={() => {
            toggleLikeTrack(track.id, track, !isLiked);
            onClose();
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-cat-text hover:bg-cat-surface0 text-left transition-colors"
        >
          <Heart className={`w-4 h-4 ${isLiked ? 'fill-current text-cat-red' : 'text-cat-subtext0'}`} />
          {isLiked ? t('Remove from Liked', 'Удалить из любимых') : t('Save to Liked Songs', 'В любимые треки')}
        </button>

        {onAddToPlaylist && (
          <button
            onClick={() => {
              onAddToPlaylist(track);
              onClose();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-cat-text hover:bg-cat-surface0 text-left transition-colors"
          >
            <FolderPlus className="w-4 h-4 text-cat-peach" />
            {t('Add to Playlist', 'Добавить в плейлист')}
          </button>
        )}

        {onRemoveFromPlaylist && (
          <button
            onClick={() => {
              onRemoveFromPlaylist(track);
              onClose();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-cat-red hover:bg-cat-surface0 text-left transition-colors"
          >
            <Trash2 className="w-4 h-4 text-cat-red" />
            {t('Remove from Playlist', 'Удалить из плейлиста')}
          </button>
        )}

        <button
          onClick={() => {
            onBlacklist(track);
            onClose();
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-cat-red/80 hover:text-cat-red hover:bg-cat-surface0 text-left transition-colors"
        >
          <Ban className="w-4 h-4" />
          {t('Never Play This', 'Никогда не включать')}
        </button>
      </div>
    </>
  );
};
