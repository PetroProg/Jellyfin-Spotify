import React, { useState, useEffect } from 'react';
import { 
  Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, 
  Volume2, VolumeX, Heart, Music2, Sparkles, ListMusic, FolderPlus,
  SlidersHorizontal, Ban, Radio
} from 'lucide-react';
import { usePlayerStore } from '../store/playerStore';
import { useSyncStore } from '../store/syncStore';
import { apiRequest } from '../api/client';
import { AddToPlaylistModal } from './AddToPlaylistModal';
import { EqualizerModal } from './EqualizerModal';
import { toast } from '../store/toastStore';

interface DesktopPlayerProps {
  onToggleQueue?: () => void;
}

export const DesktopPlayer: React.FC<DesktopPlayerProps> = ({ onToggleQueue }) => {
  const {
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    togglePlay,
    nextTrack,
    prevTrack,
    seek,
    volume,
    setVolume,
    shuffle,
    toggleShuffle,
    smartShuffle,
    toggleSmartShuffle,
    repeat,
    toggleRepeat,
    likedTrackIds,
    toggleLikeTrack,
    loadLikes,
    setEqualizerOpen,
    blacklistTrack,
  } = usePlayerStore();

  const { isLocalActive, activeDeviceName, setDevicePickerOpen } = useSyncStore();

  const [prevVolume, setPrevVolume] = useState(1);
  const [isAddToPlaylistOpen, setIsAddToPlaylistOpen] = useState(false);
  const [blacklisting, setBlacklisting] = useState(false);

  const isLiked = currentTrack ? likedTrackIds.includes(currentTrack.id) : false;

  useEffect(() => {
    loadLikes();
  }, []);

  const toggleMute = () => {
    if (volume > 0) {
      setPrevVolume(volume);
      setVolume(0);
    } else {
      setVolume(prevVolume || 0.8);
    }
  };

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

  if (!currentTrack) return null;

  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds) || !isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const trackDurSec = (currentTrack.duration_ms && currentTrack.duration_ms > 0) ? currentTrack.duration_ms / 1000 : 0;
  const effectiveDuration = Math.max(
    duration > 0 && isFinite(duration) ? duration : 0,
    trackDurSec,
    currentTime
  );

  return (
    <div className="hidden md:flex items-center justify-between h-20 bg-cat-mantle border-t border-cat-surface0/40 px-5 select-none z-30">
      {/* Left: Track Info */}
      <div className="flex items-center gap-3 w-1/4 min-w-[240px]">
        <div className="w-12 h-12 rounded-xl bg-cat-surface0 overflow-hidden flex-shrink-0 flex items-center justify-center border border-cat-surface1/30">
          {currentTrack.cover_url ? (
            <img src={currentTrack.cover_url} alt="" className="w-full h-full object-cover" />
          ) : (
            <Music2 className="w-6 h-6 text-cat-mauve" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-cat-text truncate">{currentTrack.title}</h4>
          <p className="text-xs text-cat-subtext0 truncate mt-0.5">{currentTrack.artist}</p>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setIsAddToPlaylistOpen(true)}
            title="Добавить в плейлист"
            className="p-1.5 rounded-full text-cat-subtext0 hover:text-cat-text transition-transform active:scale-125 cursor-pointer"
          >
            <FolderPlus className="w-5 h-5" />
          </button>
          <button
            onClick={handleToggleLike}
            title={isLiked ? "Удалить из любимых" : "В любимые треки"}
            className={`p-1.5 rounded-full transition-transform active:scale-125 cursor-pointer ${
              isLiked ? 'text-cat-red' : 'text-cat-subtext0 hover:text-cat-text'
            }`}
          >
            <Heart className={`w-5 h-5 ${isLiked ? 'fill-current' : ''}`} />
          </button>
          <button
            onClick={handleBlacklistCurrent}
            disabled={blacklisting}
            title="Никогда не включать"
            className="p-1.5 rounded-full text-cat-subtext0 hover:text-cat-red transition-transform active:scale-125 cursor-pointer disabled:opacity-40"
          >
            <Ban className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Center: Controls & Timeline */}
      <div className="flex flex-col items-center max-w-[600px] w-2/4 px-4">
        <div className="flex items-center gap-4 mb-1.5">
          <button
            onClick={toggleShuffle}
            title="Перемешать"
            className={`p-1.5 rounded-lg transition-colors ${
              shuffle ? 'text-cat-mauve' : 'text-cat-subtext0 hover:text-cat-text'
            }`}
          >
            <Shuffle className="w-4 h-4" />
          </button>
          <button
            onClick={prevTrack}
            className="p-1.5 text-cat-subtext0 hover:text-cat-text transition-colors"
          >
            <SkipBack className="w-5 h-5 fill-current" />
          </button>
          <button
            onClick={togglePlay}
            className="w-9 h-9 rounded-full bg-cat-mauve text-cat-base flex items-center justify-center hover:opacity-95 active:scale-95 transition-all shadow-md"
          >
            {isPlaying ? (
              <Pause className="w-4 h-4 fill-current" />
            ) : (
              <Play className="w-4 h-4 fill-current ml-0.5" />
            )}
          </button>
          <button
            onClick={nextTrack}
            className="p-1.5 text-cat-subtext0 hover:text-cat-text transition-colors"
          >
            <SkipForward className="w-5 h-5 fill-current" />
          </button>
          <button
            onClick={toggleRepeat}
            title="Повтор"
            className={`p-1.5 rounded-lg transition-colors ${
              repeat !== 'off' ? 'text-cat-mauve' : 'text-cat-subtext0 hover:text-cat-text'
            }`}
          >
            {repeat === 'one' ? <Repeat1 className="w-4 h-4" /> : <Repeat className="w-4 h-4" />}
          </button>
        </div>

        {/* Timeline Bar */}
        <div className="flex items-center gap-2 w-full text-xs font-mono text-cat-subtext0">
          <span>{formatTime(currentTime)}</span>
          <input
            type="range"
            min={0}
            max={effectiveDuration || 100}
            value={Math.min(currentTime, effectiveDuration || currentTime)}
            onChange={(e) => seek(Number(e.target.value))}
            className="flex-1 h-1 bg-cat-surface1 rounded-lg appearance-none cursor-pointer accent-cat-mauve"
          />
          <span>{formatTime(effectiveDuration)}</span>
        </div>

        {/* Remote Playback Device Indicator */}
        {!isLocalActive && activeDeviceName && (
          <button
            onClick={() => setDevicePickerOpen(true)}
            className="mt-1 flex items-center gap-1.5 text-[11px] font-semibold text-cat-green hover:underline cursor-pointer"
            title="Нажмите для смены устройства"
          >
            <Radio className="w-3.5 h-3.5 animate-pulse" />
            <span>Играет на: {activeDeviceName}</span>
          </button>
        )}
      </div>

      {/* Right: Extra Controls */}
      <div className="flex items-center justify-end gap-3 w-1/4 min-w-[200px] text-cat-subtext0">
        <button
          onClick={toggleSmartShuffle}
          title={smartShuffle ? 'Smart Shuffle активен' : 'Включить Smart Shuffle'}
          className={`p-1.5 rounded-lg transition-colors ${
            smartShuffle ? 'text-cat-mauve' : 'hover:text-cat-text'
          }`}
        >
          <Sparkles className="w-4 h-4" />
        </button>

        <button
          onClick={() => setEqualizerOpen(true)}
          title="Студийный звук & Эквалайзер"
          className="p-1.5 rounded-lg hover:text-cat-mauve text-cat-subtext0 transition-colors cursor-pointer active:scale-95"
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>

        {/* Device Picker Button */}
        <button
          onClick={() => setDevicePickerOpen(true)}
          title={!isLocalActive ? `Играет на: ${activeDeviceName}` : 'Подключенные устройства'}
          className={`p-1.5 rounded-lg transition-colors cursor-pointer active:scale-95 ${
            !isLocalActive ? 'text-cat-green bg-cat-green/15' : 'hover:text-cat-mauve text-cat-subtext0'
          }`}
        >
          <Radio className="w-4 h-4" />
        </button>

        {onToggleQueue && (
          <button
            onClick={onToggleQueue}
            title="Очередь воспроизведения"
            className="p-1.5 rounded-lg hover:text-cat-text transition-colors"
          >
            <ListMusic className="w-4 h-4" />
          </button>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={toggleMute}
            title={volume === 0 ? 'Включить звук' : 'Без звука'}
            className="hover:text-cat-text transition-colors p-0.5 rounded"
          >
            {volume === 0 ? <VolumeX className="w-4 h-4 text-cat-red" /> : <Volume2 className="w-4 h-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="w-20 h-1 bg-cat-surface1 rounded-lg appearance-none cursor-pointer accent-cat-peach"
          />
        </div>
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
