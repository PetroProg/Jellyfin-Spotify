import React from 'react';
import { Play, Pause, SkipForward, Music2, Radio } from 'lucide-react';
import { usePlayerStore } from '../store/playerStore';
import { useSyncStore } from '../store/syncStore';

export const MiniPlayer: React.FC = () => {
  const { currentTrack, isPlaying, togglePlay, nextTrack, currentTime, duration, setFullPlayerOpen } = usePlayerStore();
  const { isLocalActive, activeDeviceName } = useSyncStore();

  if (!currentTrack) return null;

  const trackDurSec = (currentTrack.duration_ms && currentTrack.duration_ms > 0) ? currentTrack.duration_ms / 1000 : 0;
  const effectiveDuration = Math.max(
    duration > 0 && isFinite(duration) ? duration : 0,
    trackDurSec,
    currentTime
  );
  const progressPercent = effectiveDuration > 0 ? Math.min(100, (currentTime / effectiveDuration) * 100) : 0;

  return (
    <div className="md:hidden fixed bottom-[calc(56px+env(safe-area-inset-bottom))] left-2 right-2 z-30 select-none">
      <div
        onClick={() => setFullPlayerOpen(true)}
        className="bg-cat-surface0/95 backdrop-blur-md rounded-2xl p-2 shadow-2xl border border-cat-surface1/50 flex items-center justify-between cursor-pointer active:scale-[0.99] transition-transform relative overflow-hidden"
      >
        {/* Progress Bar line at bottom */}
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-cat-surface1">
          <div
            className="h-full bg-cat-mauve transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        {/* Track Thumbnail & Info */}
        <div className="flex items-center gap-3 flex-1 min-w-0 pr-2">
          <div className="w-11 h-11 rounded-xl bg-cat-mantle overflow-hidden flex-shrink-0 flex items-center justify-center border border-cat-surface1/40">
            {currentTrack.cover_url ? (
              <img src={currentTrack.cover_url} alt="" className="w-full h-full object-cover" />
            ) : (
              <Music2 className="w-5 h-5 text-cat-mauve" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold text-cat-text truncate leading-tight">
              {currentTrack.title}
            </h4>
            {!isLocalActive && activeDeviceName ? (
              <p className="text-xs text-cat-green flex items-center gap-1 truncate leading-tight mt-0.5">
                <Radio className="w-3 h-3 animate-pulse" />
                <span>Играет на: {activeDeviceName}</span>
              </p>
            ) : (
              <p className="text-xs text-cat-subtext0 truncate leading-tight mt-0.5">
                {currentTrack.artist}
              </p>
            )}
          </div>
        </div>

        {/* Playback Controls */}
        <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={togglePlay}
            className="w-9 h-9 rounded-full bg-cat-mauve text-cat-base flex items-center justify-center hover:opacity-90 active:scale-95 transition-all shadow-md"
          >
            {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
          </button>
          <button
            onClick={nextTrack}
            className="w-9 h-9 text-cat-subtext0 hover:text-cat-text flex items-center justify-center active:scale-95 transition-all"
          >
            <SkipForward className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
