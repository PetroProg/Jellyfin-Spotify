import React, { useEffect, useState } from 'react';
import { Heart, Ban, Music2 } from 'lucide-react';
import { Track } from '../types';
import { usePlayerStore } from '../store/playerStore';
import { apiRequest } from '../api/client';

export const QueuePanel: React.FC = () => {
  const { queue, currentIndex, playTrack, currentTrack } = usePlayerStore();
  const [recommendations, setRecommendations] = useState<any[]>([]);

  useEffect(() => {
    if (currentTrack) {
      apiRequest<{ recommendations: any[] }>(`/recommendations?artists=${encodeURIComponent(currentTrack.artist)}`)
        .then((res) => {
          setRecommendations(res.recommendations || []);
        })
        .catch(() => {});
    }
  }, [currentTrack]);

  const upNext = queue.slice(currentIndex + 1, currentIndex + 6);

  const handleBlacklist = async (rec: any) => {
    try {
      await apiRequest('/blacklist', {
        method: 'POST',
        body: JSON.stringify({ title: rec.title, artist: rec.artist, spotify_id: rec.id })
      });
      setRecommendations(prev => prev.filter(r => r.title !== rec.title));
    } catch (e) {
      console.warn(e);
    }
  };

  return (
    <aside className="hidden xl:flex flex-col w-72 bg-cat-mantle p-4 border-l border-cat-surface0/30 select-none">
      {/* Up Next Section */}
      <h3 className="text-sm font-bold text-cat-text mb-3">В очереди</h3>
      <div className="space-y-2 mb-6">
        {upNext.length === 0 ? (
          <p className="text-xs text-cat-subtext0">Очередь пуста</p>
        ) : (
          upNext.map((track, i) => (
            <div
              key={`${track.id}-${i}`}
              onClick={() => playTrack(track, queue, currentIndex + 1 + i)}
              className="flex items-center gap-3 p-2 rounded-xl hover:bg-cat-surface0 cursor-pointer transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-cat-surface0 overflow-hidden flex-shrink-0 flex items-center justify-center">
                {track.cover_url ? (
                  <img src={track.cover_url} alt="" className="w-full h-full object-cover" />
                ) : (
                  <Music2 className="w-4 h-4 text-cat-subtext0" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-cat-text truncate">{track.title}</p>
                <p className="text-[11px] text-cat-subtext0 truncate">{track.artist}</p>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Discover Similar Section */}
      <h3 className="text-sm font-bold text-cat-text mb-3">Похожая музыка</h3>
      <div className="space-y-2 flex-1 overflow-y-auto custom-scrollbar">
        {recommendations.length === 0 ? (
          <p className="text-xs text-cat-subtext0">Нет рекомендаций</p>
        ) : (
          recommendations.slice(0, 5).map((rec, i) => (
            <div
              key={i}
              className="flex items-center justify-between p-2 rounded-xl hover:bg-cat-surface0 transition-colors"
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
                  title="Никогда не включать"
                  className="p-1 rounded-md text-cat-subtext0 hover:text-cat-red hover:bg-cat-surface1 transition-colors"
                >
                  <Ban className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
};
