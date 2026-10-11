import React, { useEffect, useRef } from 'react';
import { ListPlus, Ban, FolderPlus, Trash2 } from 'lucide-react';
import { Track } from '../types';

interface ContextMenuProps {
  track: Track;
  position: { x: number; y: number };
  onClose: () => void;
  onAddToQueue: (track: Track) => void;
  onAddToPlaylist?: (track: Track) => void;
  onRemoveFromPlaylist?: (track: Track) => void;
  onBlacklist: (track: Track) => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  track,
  position,
  onClose,
  onAddToQueue,
  onAddToPlaylist,
  onRemoveFromPlaylist,
  onBlacklist,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Adjust position so it doesn't overflow screen
  const safeX = Math.min(position.x, window.innerWidth - 220);
  const safeY = Math.min(position.y, window.innerHeight - 180);

  return (
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
        В очередь
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
          Добавить в плейлист
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
          Удалить из плейлиста
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
        Никогда не включать
      </button>
    </div>
  );
};
