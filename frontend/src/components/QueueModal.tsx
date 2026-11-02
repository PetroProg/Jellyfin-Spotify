import React, { useState, useEffect } from 'react';
import {
  X,
  Music2,
  Trash2,
  ChevronUp,
  ChevronDown,
  GripVertical,
  ListMusic,
  Ban,
  Sparkles,
  Volume2
} from 'lucide-react';
import { usePlayerStore } from '../store/playerStore';
import { useI18nStore } from '../store/i18nStore';
import { apiRequest } from '../api/client';
import { Track } from '../types';

export const QueueModal: React.FC = () => {
  const { t } = useI18nStore();
  const {
    isQueueOpen,
    setQueueOpen,
    queue,
    currentIndex,
    currentTrack,
    isPlaying,
    userQueuedCount,
    playTrack,
    reorderQueue,
    removeFromQueue,
    clearUpcomingQueue
  } = usePlayerStore();

  const [recommendations, setRecommendations] = useState<any[]>([]);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  useEffect(() => {
    if (isQueueOpen && currentTrack) {
      apiRequest<{ recommendations: any[] }>(`/recommendations?artists=${encodeURIComponent(currentTrack.artist)}`)
        .then((res) => {
          setRecommendations(res.recommendations || []);
        })
        .catch(() => {});
    }
  }, [isQueueOpen, currentTrack]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setQueueOpen(false);
    };
    if (isQueueOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isQueueOpen, setQueueOpen]);

  if (!isQueueOpen) return null;

  const upcomingTracks = queue.slice(currentIndex + 1);

  const handleDragStart = (e: React.DragEvent, indexInUpcoming: number) => {
    setDraggedIndex(indexInUpcoming);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(indexInUpcoming));
  };

  const handleDragOver = (e: React.DragEvent, indexInUpcoming: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIndex !== indexInUpcoming) {
      setDragOverIndex(indexInUpcoming);
    }
  };

  const handleDrop = (e: React.DragEvent, targetIndexInUpcoming: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === targetIndexInUpcoming) {
      setDraggedIndex(null);
      setDragOverIndex(null);
      return;
    }

    const fromGlobal = currentIndex + 1 + draggedIndex;
    const toGlobal = currentIndex + 1 + targetIndexInUpcoming;
    reorderQueue(fromGlobal, toGlobal);

    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleMoveUp = (indexInUpcoming: number) => {
    if (indexInUpcoming <= 0) return;
    const fromGlobal = currentIndex + 1 + indexInUpcoming;
    const toGlobal = fromGlobal - 1;
    reorderQueue(fromGlobal, toGlobal);
  };

  const handleMoveDown = (indexInUpcoming: number) => {
    if (indexInUpcoming >= upcomingTracks.length - 1) return;
    const fromGlobal = currentIndex + 1 + indexInUpcoming;
    const toGlobal = fromGlobal + 1;
    reorderQueue(fromGlobal, toGlobal);
  };

  const handleRemove = (indexInUpcoming: number) => {
    const globalIdx = currentIndex + 1 + indexInUpcoming;
    removeFromQueue(globalIdx);
  };

  const handleBlacklist = async (rec: any) => {
    try {
      await apiRequest('/blacklist', {
        method: 'POST',
        body: JSON.stringify({ title: rec.title, artist: rec.artist, spotify_id: rec.id })
      });
      setRecommendations((prev) => prev.filter((r) => r.title !== rec.title));
    } catch (e) {
      console.warn(e);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex justify-end">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity animate-in fade-in"
        onClick={() => setQueueOpen(false)}
      />

      {/* Drawer / Modal Container */}
      <div className="relative w-full max-w-md md:max-w-lg h-full bg-cat-mantle/95 backdrop-blur-xl border-l border-cat-surface0/60 shadow-2xl flex flex-col z-10 select-none animate-in slide-in-from-right duration-200 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(0.5rem,env(safe-area-inset-top))]">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-cat-surface0/50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-cat-peach/10 text-cat-peach">
              <ListMusic className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-cat-text flex items-center gap-2">
                {t('Play Queue', 'Очередь воспроизведения')}
                {upcomingTracks.length > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-cat-surface0 text-cat-subtext0 font-medium">
                    {upcomingTracks.length}
                  </span>
                )}
              </h2>
              <p className="text-xs text-cat-subtext0">
                {t('Drag or use arrows to reorder songs', 'Перетаскивайте или перемещайте стрелками')}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {upcomingTracks.length > 0 && (
              <button
                onClick={clearUpcomingQueue}
                className="px-3 py-1.5 text-xs font-semibold rounded-xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-subtext0 hover:text-cat-red transition-colors"
                title={t('Clear Queue', 'Очистить очередь')}
              >
                {t('Clear', 'Очистить')}
              </button>
            )}
            <button
              onClick={() => setQueueOpen(false)}
              className="p-2 rounded-xl hover:bg-cat-surface0 text-cat-subtext0 hover:text-cat-text transition-colors"
              title={t('Close', 'Закрыть')}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content Scroll Area */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-6">
          {/* Now Playing Card */}
          {currentTrack && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold text-cat-subtext0 uppercase tracking-wider px-1">
                <span>{t('Now Playing', 'Сейчас играет')}</span>
                {isPlaying && (
                  <span className="flex items-center gap-1.5 text-cat-green lowercase">
                    <span className="w-2 h-2 rounded-full bg-cat-green animate-pulse" />
                    {t('Playing', 'воспроизводится')}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3.5 p-3 rounded-2xl bg-cat-surface0/60 border border-cat-peach/20 shadow-sm">
                <div className="w-12 h-12 rounded-xl bg-cat-surface1 overflow-hidden flex-shrink-0 flex items-center justify-center relative shadow-md">
                  {currentTrack.cover_url ? (
                    <img src={currentTrack.cover_url} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <Music2 className="w-6 h-6 text-cat-subtext0" />
                  )}
                  {isPlaying && (
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                      <Volume2 className="w-5 h-5 text-cat-peach animate-pulse" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-cat-text truncate">{currentTrack.title}</p>
                  <p className="text-xs text-cat-subtext0 truncate">{currentTrack.artist}</p>
                  {currentTrack.album && (
                    <p className="text-[11px] text-cat-subtext1/60 truncate">{currentTrack.album}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Up Next Section */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-xs font-semibold text-cat-subtext0 uppercase tracking-wider px-1">
              <span>{t('Next in Queue', 'Далее в очереди')}</span>
              <span>{upcomingTracks.length} {t('tracks', 'треков')}</span>
            </div>

            {upcomingTracks.length === 0 ? (
              <div className="p-8 text-center rounded-2xl bg-cat-surface0/30 border border-cat-surface0/40 space-y-2">
                <div className="w-12 h-12 rounded-full bg-cat-surface0 mx-auto flex items-center justify-center text-cat-subtext0">
                  <ListMusic className="w-6 h-6" />
                </div>
                <p className="text-sm font-semibold text-cat-text">
                  {t('Queue is empty', 'Очередь воспроизведения пуста')}
                </p>
                <p className="text-xs text-cat-subtext0 max-w-xs mx-auto">
                  {t(
                    'Click "Add to queue" on any song to play it next, or start a playlist.',
                    'Нажмите «В очередь» на любой песне, чтобы поставить её следующей, или включите плейлист.'
                  )}
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {upcomingTracks.map((track, i) => {
                  const isUserQueued = i < userQueuedCount;
                  const isDragged = draggedIndex === i;
                  const isDragOver = dragOverIndex === i;

                  return (
                    <div
                      key={`${track.id || track.spotify_id || track.title}-${i}`}
                      draggable
                      onDragStart={(e) => handleDragStart(e, i)}
                      onDragOver={(e) => handleDragOver(e, i)}
                      onDrop={(e) => handleDrop(e, i)}
                      onDragEnd={handleDragEnd}
                      className={`group flex items-center gap-2 p-2 sm:p-2.5 rounded-xl transition-all duration-150 border ${
                        isDragged
                          ? 'opacity-40 bg-cat-surface0 border-cat-peach/40'
                          : isDragOver
                          ? 'border-cat-peach bg-cat-surface0/90 shadow-md scale-[1.01]'
                          : 'border-transparent bg-cat-surface0/30 hover:bg-cat-surface0/70'
                      }`}
                    >
                      {/* Drag Handle */}
                      <div
                        className="cursor-grab active:cursor-grabbing p-1 text-cat-subtext0 hover:text-cat-text transition-colors flex-shrink-0"
                        title={t('Drag to reorder', 'Потяните для изменения порядка')}
                      >
                        <GripVertical className="w-4 h-4" />
                      </div>

                      {/* Track Index Badge */}
                      <span className="text-[11px] font-mono text-cat-subtext0/70 w-5 text-center flex-shrink-0">
                        {i + 1}
                      </span>

                      {/* Cover Thumbnail & Play on Click */}
                      <div
                        onClick={() => playTrack(track, queue, currentIndex + 1 + i)}
                        className="w-10 h-10 rounded-lg bg-cat-surface0 overflow-hidden flex-shrink-0 flex items-center justify-center cursor-pointer hover:opacity-80 transition-opacity"
                        title={t('Play now', 'Включить сейчас')}
                      >
                        {track.cover_url ? (
                          <img src={track.cover_url} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <Music2 className="w-4 h-4 text-cat-subtext0" />
                        )}
                      </div>

                      {/* Track Details */}
                      <div
                        onClick={() => playTrack(track, queue, currentIndex + 1 + i)}
                        className="min-w-0 flex-1 cursor-pointer"
                        title={t('Play now', 'Включить сейчас')}
                      >
                        <div className="flex items-center gap-1.5">
                          <p className="text-xs sm:text-sm font-semibold text-cat-text truncate">
                            {track.title}
                          </p>
                          {isUserQueued && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-cat-peach/15 text-cat-peach font-medium flex-shrink-0">
                              {t('Queued', 'В очереди')}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] sm:text-xs text-cat-subtext0 truncate">{track.artist}</p>
                      </div>

                      {/* Reorder Buttons & Actions */}
                      <div className="flex items-center gap-0.5 flex-shrink-0">
                        <button
                          disabled={i === 0}
                          onClick={() => handleMoveUp(i)}
                          className={`p-1 rounded-lg transition-colors ${
                            i === 0
                              ? 'text-cat-surface1 cursor-not-allowed'
                              : 'text-cat-subtext0 hover:text-cat-text hover:bg-cat-surface1'
                          }`}
                          title={t('Move Up', 'Переместить выше')}
                        >
                          <ChevronUp className="w-4 h-4" />
                        </button>

                        <button
                          disabled={i === upcomingTracks.length - 1}
                          onClick={() => handleMoveDown(i)}
                          className={`p-1 rounded-lg transition-colors ${
                            i === upcomingTracks.length - 1
                              ? 'text-cat-surface1 cursor-not-allowed'
                              : 'text-cat-subtext0 hover:text-cat-text hover:bg-cat-surface1'
                          }`}
                          title={t('Move Down', 'Переместить ниже')}
                        >
                          <ChevronDown className="w-4 h-4" />
                        </button>

                        <button
                          onClick={() => handleRemove(i)}
                          className="p-1 rounded-lg text-cat-subtext0 hover:text-cat-red hover:bg-cat-surface1 transition-colors"
                          title={t('Remove from queue', 'Удалить из очереди')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recommendations / Similar Section */}
          {recommendations.length > 0 && (
            <div className="space-y-2.5 pt-4 border-t border-cat-surface0/50">
              <div className="flex items-center justify-between text-xs font-semibold text-cat-subtext0 uppercase tracking-wider px-1">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-cat-peach" />
                  {t('Similar Music', 'Похожая музыка')}
                </span>
              </div>

              <div className="space-y-1.5">
                {recommendations.slice(0, 5).map((rec, i) => (
                  <div
                    key={rec.id || i}
                    className="flex items-center justify-between p-2 rounded-xl bg-cat-surface0/20 hover:bg-cat-surface0/60 transition-colors"
                  >
                    <div
                      className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer"
                      onClick={() => playTrack(rec)}
                    >
                      <div className="w-9 h-9 rounded-lg bg-cat-surface0 overflow-hidden flex-shrink-0 flex items-center justify-center">
                        {rec.cover_url ? (
                          <img src={rec.cover_url} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <Music2 className="w-4 h-4 text-cat-subtext0" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-cat-text truncate">{rec.title}</p>
                        <p className="text-[11px] text-cat-subtext0 truncate">{rec.artist}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => handleBlacklist(rec)}
                        title={t('Never Play This', 'Никогда не включать')}
                        className="p-1 rounded-md text-cat-subtext0 hover:text-cat-red hover:bg-cat-surface1 transition-colors"
                      >
                        <Ban className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
