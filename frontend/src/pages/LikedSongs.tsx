import React, { useState, useEffect, useRef } from 'react';
import { Heart, Play, Shuffle, ChevronUp } from 'lucide-react';
import { Track } from '../types';
import { apiRequest } from '../api/client';
import { TrackRow } from '../components/TrackRow';
import { ContextMenu } from '../components/ContextMenu';
import { AddToPlaylistModal } from '../components/AddToPlaylistModal';
import { usePlayerStore } from '../store/playerStore';

export const LikedSongs: React.FC = () => {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [menuState, setMenuState] = useState<{ track: Track; pos: { x: number; y: number } } | null>(null);
  const [addToPlaylistTrack, setAddToPlaylistTrack] = useState<Track | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleScroll = () => {
      setShowScrollTop(el.scrollTop > 280);
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToTop = () => {
    containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const { playTrack, toggleShuffle, addToQueue, likedTrackIds } = usePlayerStore();

  const loadLikes = async () => {
    try {
      const data = await apiRequest<{ tracks: Track[] }>('/likes');
      setTracks(data.tracks || []);
    } catch (e) {
      console.warn(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLikes();
  }, [likedTrackIds]);

  const handleBlacklist = async (track: Track) => {
    try {
      await apiRequest('/blacklist', {
        method: 'POST',
        body: JSON.stringify({ title: track.title, artist: track.artist })
      });
      setTracks(prev => prev.filter(t => t.id !== track.id));
    } catch (e) {
      console.warn(e);
    }
  };

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto px-4 md:px-8 py-6 pb-28 md:pb-24 select-none custom-scrollbar">
      {/* Header */}
      <div className="flex items-center gap-5 mb-8">
        <div className="w-28 h-28 md:w-36 md:h-36 rounded-3xl bg-gradient-to-br from-cat-mauve to-cat-pink flex items-center justify-center text-cat-base shadow-xl flex-shrink-0">
          <Heart className="w-14 h-14 fill-current" />
        </div>
        <div>
          <span className="text-xs uppercase tracking-wider text-cat-subtext0 font-semibold">Плейлист</span>
          <h1 className="text-2xl md:text-4xl font-extrabold text-cat-text mt-1">Любимые треки</h1>
          <p className="text-xs text-cat-subtext0 mt-2">{tracks.length} треков</p>
          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={() => tracks.length > 0 && playTrack(tracks[0], tracks, 0)}
              disabled={tracks.length === 0}
              className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-cat-mauve text-cat-base font-bold hover:opacity-95 active:scale-95 transition-all disabled:opacity-40"
            >
              <Play className="w-4 h-4 fill-current" />
              Слушать
            </button>
            <button
              onClick={() => {
                if (tracks.length > 0) {
                  playTrack(tracks[0], tracks, 0);
                  toggleShuffle();
                }
              }}
              disabled={tracks.length === 0}
              className="p-2.5 rounded-full bg-cat-surface0 hover:bg-cat-surface1 text-cat-text active:scale-95 transition-all disabled:opacity-40"
            >
              <Shuffle className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Sorting / Table Header */}
      <div className="border-b border-cat-surface0/60 pb-2 mb-2 flex items-center justify-between text-xs font-semibold text-cat-subtext0 px-3">
        <div className="flex items-center gap-4 flex-1 md:w-2/5 md:flex-initial">
          <span className="w-6 text-center">#</span>
          <span>Название</span>
        </div>
        <div className="hidden md:flex items-center w-1/5 pr-3">
          <span>Исполнитель</span>
        </div>
        <div className="hidden lg:flex items-center w-1/5 pr-3">
          <span>Альбом</span>
        </div>
        <div className="hidden xl:flex items-center w-28 pr-3">
          <span>Дата</span>
        </div>
        <div className="flex items-center gap-6">
          <span>Время</span>
          <span className="w-7" />
        </div>
      </div>

      {/* Tracklist */}
      <div className="space-y-0.5">
        {loading ? (
          <div className="py-12 text-center text-cat-subtext0 text-sm">Загрузка любимых треков...</div>
        ) : tracks.length === 0 ? (
          <div className="py-12 text-center text-cat-subtext0 text-sm">У вас пока нет любимых треков</div>
        ) : (
          tracks.map((track, i) => (
            <TrackRow
              key={track.id}
              track={track}
              index={i}
              onPlay={() => playTrack(track, tracks, i)}
              onOpenMenu={(e, t) => setMenuState({ track: t, pos: { x: e.clientX, y: e.clientY } })}
            />
          ))
        )}
      </div>

      {menuState && (
        <ContextMenu
          track={menuState.track}
          position={menuState.pos}
          onClose={() => setMenuState(null)}
          onAddToQueue={(t) => addToQueue(t)}
          onAddToPlaylist={(t) => setAddToPlaylistTrack(t)}
          onBlacklist={handleBlacklist}
        />
      )}

      {addToPlaylistTrack && (
        <AddToPlaylistModal
          track={addToPlaylistTrack}
          isOpen={!!addToPlaylistTrack}
          onClose={() => setAddToPlaylistTrack(null)}
          onUpdated={loadLikes}
        />
      )}

      {/* Floating Scroll to Top Arrow */}
      {showScrollTop && (
        <button
          onClick={scrollToTop}
          title="Наверх"
          className="fixed bottom-24 right-5 md:right-8 z-40 p-3 rounded-full bg-cat-mauve text-cat-base shadow-2xl hover:scale-110 active:scale-95 transition-all duration-200 animate-in fade-in zoom-in-75 cursor-pointer"
        >
          <ChevronUp className="w-5 h-5 stroke-[2.5]" />
        </button>
      )}
    </div>
  );
};
