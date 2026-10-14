import React, { useState, useEffect } from 'react';
import { 
  ChevronDown, Heart, Shuffle, SkipBack, Play, Pause, 
  SkipForward, Repeat, Repeat1, Music2, Sparkles, FolderPlus,
  SlidersHorizontal, Ban
} from 'lucide-react';
import { usePlayerStore } from '../store/playerStore';
import { apiRequest } from '../api/client';
import { AddToPlaylistModal } from './AddToPlaylistModal';
import { EqualizerModal } from './EqualizerModal';
import { toast } from '../store/toastStore';

export const FullPlayer: React.FC = () => {
  const {
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    togglePlay,
    nextTrack,
    prevTrack,
    seek,
    shuffle,
    toggleShuffle,
    smartShuffle,
    toggleSmartShuffle,
    repeat,
    toggleRepeat,
    isFullPlayerOpen,
    setFullPlayerOpen,
    likedTrackIds,
    toggleLikeTrack,
    loadLikes,
    setEqualizerOpen,
    blacklistTrack,
  } = usePlayerStore();

  const [isAddToPlaylistOpen, setIsAddToPlaylistOpen] = useState(false);
  const [blacklisting, setBlacklisting] = useState(false);

  const isLiked = currentTrack ? likedTrackIds.includes(currentTrack.id) : false;

  useEffect(() => {
    loadLikes();
  }, []);

  const handleToggleLike = async () => {
    if (!currentTrack) return;
    try {
      await toggleLikeTrack(currentTrack.id);
    } catch (e) {
      console.warn(e);
    }
  };

  const handleBlacklistCurrent = async () => {
    if (!currentTrack || blacklisting) return;
    setBlacklisting(true);
    try {
      const trackToBlacklist = currentTrack;
      await blacklistTrack(trackToBlacklist);
      toast.info(`«${trackToBlacklist.title}» добавлена в «Никогда не включать» и удалена из плейлистов`);
    } catch (e: any) {
      toast.error(e.message || 'Ошибка добавления в черный список');
    } finally {
      setBlacklisting(false);
    }
  };

  if (!isFullPlayerOpen || !currentTrack) return null;

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const handleClose = () => {
    if (window.history.state?.isFullPlayer) {
      window.history.back();
    } else {
      setFullPlayerOpen(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-cat-base flex flex-col justify-between px-6 py-6 pb-[env(safe-area-inset-bottom)] select-none animate-in fade-in slide-in-from-bottom duration-300">
      {/* Top Bar with Chevron Down */}
      <div className="flex items-center justify-between pt-2">
        <button
          onClick={handleClose}
          className="p-2 -ml-2 text-cat-subtext0 hover:text-cat-text active:scale-95 transition-all cursor-pointer"
        >
          <ChevronDown className="w-7 h-7" />
        </button>
        <div className="text-center">
          <span className="text-[11px] uppercase tracking-wider text-cat-subtext0 font-semibold block">
            Сейчас играет
          </span>
          <span className="text-xs text-cat-text font-medium truncate max-w-[200px] block">
            {currentTrack.album || 'Из медиатеки'}
          </span>
        </div>
        <div className="flex items-center gap-1 -mr-2">
          <button
            onClick={() => setEqualizerOpen(true)}
            title="Студийный звук & Эквалайзер"
            className="p-2 text-cat-subtext0 hover:text-cat-mauve active:scale-95 transition-all cursor-pointer"
          >
            <SlidersHorizontal className="w-5 h-5" />
          </button>
          <button
            onClick={toggleSmartShuffle}
            title="Smart Shuffle (Умные рекомендации)"
            className={`p-2 rounded-xl transition-all ${
              smartShuffle ? 'text-cat-mauve' : 'text-cat-subtext0/50'
            }`}
          >
            <Sparkles className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Large Center Artwork */}
      <div className="flex-1 flex items-center justify-center my-4">
        <div className="w-full max-w-[340px] aspect-square rounded-3xl overflow-hidden shadow-2xl shadow-cat-crust/80 border border-cat-surface0/60 flex items-center justify-center bg-cat-mantle">
          {currentTrack.cover_url ? (
            <img src={currentTrack.cover_url} alt="" className="w-full h-full object-cover" />
          ) : (
            <Music2 className="w-24 h-24 text-cat-mauve/40" />
          )}
        </div>
      </div>

      {/* Track Title, Artist & Like Button */}
      <div className="flex items-center justify-between mb-4">
        <div className="min-w-0 flex-1 pr-4">
          <h2 className="text-2xl font-bold text-cat-text truncate leading-tight">
            {currentTrack.title}
          </h2>
          <p className="text-base text-cat-subtext0 truncate mt-1">
            {currentTrack.artist}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setIsAddToPlaylistOpen(true)}
            title="Добавить в плейлист"
            className="p-2 rounded-full text-cat-subtext0 hover:text-cat-text transition-transform active:scale-125"
          >
            <FolderPlus className="w-7 h-7" />
          </button>
          <button
            onClick={handleToggleLike}
            title={isLiked ? "Удалить из любимых" : "В любимые треки"}
            className={`p-2 rounded-full transition-transform active:scale-125 ${
              isLiked ? 'text-cat-red' : 'text-cat-subtext0 hover:text-cat-text'
            }`}
          >
            <Heart className={`w-7 h-7 ${isLiked ? 'fill-current' : ''}`} />
          </button>
          <button
            onClick={handleBlacklistCurrent}
            disabled={blacklisting}
            title="Никогда не включать"
            className="p-2 rounded-full text-cat-subtext0 hover:text-cat-red transition-transform active:scale-125 disabled:opacity-40"
          >
            <Ban className="w-7 h-7" />
          </button>
        </div>
      </div>

      {/* Timeline Scrubber */}
      <div className="space-y-1.5 mb-4">
        <input
          type="range"
          min={0}
          max={duration || 100}
          value={currentTime}
          onChange={(e) => seek(Number(e.target.value))}
          className="w-full h-1.5 bg-cat-surface1 rounded-lg appearance-none cursor-pointer accent-cat-mauve"
        />
        <div className="flex justify-between text-xs text-cat-subtext0 font-mono">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Playback Controls (Shuffle, Prev, Big Play, Next, Repeat) */}
      <div className="flex items-center justify-between px-2 mb-6">
        <button
          onClick={toggleShuffle}
          className={`p-2 transition-all active:scale-95 ${
            shuffle ? 'text-cat-mauve' : 'text-cat-subtext0 hover:text-cat-text'
          }`}
        >
          <Shuffle className="w-6 h-6" />
        </button>

        <button
          onClick={prevTrack}
          className="p-2 text-cat-subtext0 hover:text-cat-text active:scale-95 transition-all"
        >
          <SkipBack className="w-8 h-8 fill-current" />
        </button>

        <button
          onClick={togglePlay}
          className="w-18 h-18 w-[72px] h-[72px] rounded-full bg-cat-mauve text-cat-base flex items-center justify-center hover:opacity-95 active:scale-95 transition-all shadow-xl shadow-cat-mauve/25"
        >
          {isPlaying ? (
            <Pause className="w-8 h-8 fill-current" />
          ) : (
            <Play className="w-8 h-8 fill-current ml-1" />
          )}
        </button>

        <button
          onClick={nextTrack}
          className="p-2 text-cat-subtext0 hover:text-cat-text active:scale-95 transition-all"
        >
          <SkipForward className="w-8 h-8 fill-current" />
        </button>

        <button
          onClick={toggleRepeat}
          className={`p-2 transition-all active:scale-95 ${
            repeat !== 'off' ? 'text-cat-mauve' : 'text-cat-subtext0 hover:text-cat-text'
          }`}
        >
          {repeat === 'one' ? <Repeat1 className="w-6 h-6" /> : <Repeat className="w-6 h-6" />}
        </button>
      </div>

      <AddToPlaylistModal
        track={currentTrack}
        isOpen={isAddToPlaylistOpen}
        onClose={() => setIsAddToPlaylistOpen(false)}
      />

      <EqualizerModal />
    </div>
  );
};
