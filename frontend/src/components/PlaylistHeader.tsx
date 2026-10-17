import React, { useState, useEffect } from 'react';
import { Play, Shuffle, Download, Check, Music2, Loader2, Camera, Trash2, Pencil, BookmarkPlus } from 'lucide-react';
import { Playlist, Track } from '../types';
import { useOfflineStore } from '../store/offlineStore';
import { apiRequest } from '../api/client';
import { toast, confirmDialog } from '../store/toastStore';

interface PlaylistHeaderProps {
  playlist: Playlist;
  tracks: Track[];
  activeJob?: any;
  onPlayAll: () => void;
  onShuffleAll: () => void;
  onCoverChange?: (newUrl: string) => void;
  onRename?: (newName: string, newDesc?: string) => void;
  onDelete?: () => void;
}

export const PlaylistHeader: React.FC<PlaylistHeaderProps> = ({
  playlist,
  tracks,
  activeJob,
  onPlayAll,
  onShuffleAll,
  onCoverChange,
  onRename,
  onDelete,
}) => {
  const isDownloaded = useOfflineStore((s) => s.downloadedIds.includes(playlist.id));
  const offlineProgress = useOfflineStore((s) => s.progress[playlist.id]);
  const startDownload = useOfflineStore((s) => s.startDownload);
  const removeDownload = useOfflineStore((s) => s.removeDownload);

  const downloading = !!offlineProgress?.inProgress;
  const progressText = offlineProgress ? `${offlineProgress.done}/${offlineProgress.total}` : '';
  const [uploadingCover, setUploadingCover] = useState(false);
  const [deletingPlaylist, setDeletingPlaylist] = useState(false);
  const [savingMix, setSavingMix] = useState(false);

  // Rename Playlist State
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameName, setRenameName] = useState(playlist.name);
  const [renameDesc, setRenameDesc] = useState(playlist.description || '');
  const [savingRename, setSavingRename] = useState(false);

  const isDailyMix = Boolean(playlist.is_daily_mix);
  const isLikedPlaylist =
    playlist.name.toLowerCase() === 'любимые треки' ||
    playlist.name.toLowerCase() === 'liked songs';

  useEffect(() => {
    setRenameName(playlist.name);
    setRenameDesc(playlist.description || '');
  }, [playlist.id, playlist.name, playlist.description]);

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (savingRename) return;

    const trimmedName = renameName.trim();
    if (!trimmedName) {
      toast.error('Название плейлиста не может быть пустым');
      return;
    }

    if (trimmedName.toLowerCase() === 'любимые треки' || trimmedName.toLowerCase() === 'liked songs') {
      toast.error('Имя «Любимые треки» зарезервировано для системного раздела');
      return;
    }

    setSavingRename(true);
    try {
      await apiRequest<{ success: boolean; playlist: Playlist }>(`/playlists/${playlist.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: trimmedName,
          description: renameDesc.trim()
        })
      });

      playlist.name = trimmedName;
      playlist.description = renameDesc.trim();
      onRename?.(trimmedName, renameDesc.trim());
      setShowRenameModal(false);
      toast.success('Плейлист переименован');
    } catch (err: any) {
      toast.error(err.message || 'Ошибка переименования плейлиста');
    } finally {
      setSavingRename(false);
    }
  };

  const handleDeletePlaylist = async () => {
    if (deletingPlaylist) return;

    const ok = await confirmDialog({
      title: 'Удалить плейлист?',
      message: `Вы уверены, что хотите безвозвратно удалить плейлист «${playlist.name}»? Это действие нельзя отменить.`,
      confirmText: 'Удалить плейлист',
      cancelText: 'Отмена',
      isDestructive: true
    });
    if (!ok) return;

    setDeletingPlaylist(true);
    try {
      if (isDownloaded) {
        try {
          await removeDownload(playlist.id, tracks);
        } catch (_) {}
      }
      await apiRequest(`/playlists/${playlist.id}`, { method: 'DELETE' });
      toast.success(`Плейлист «${playlist.name}» успешно удален`);
      onDelete?.();
    } catch (e: any) {
      toast.error(e.message || 'Ошибка удаления плейлиста');
      setDeletingPlaylist(false);
    }
  };

  const handleCoverFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.warning('Пожалуйста, выберите файл изображения (JPG, PNG, WebP)');
      return;
    }

    setUploadingCover(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64 = reader.result as string;
        const res = await apiRequest<{ success: boolean; cover_url: string }>(`/playlists/${playlist.id}/cover`, {
          method: 'PUT',
          body: JSON.stringify({ image_base64: base64 })
        });
        if (res.cover_url) {
          playlist.cover_url = res.cover_url;
          onCoverChange?.(res.cover_url);
          toast.success('Обложка плейлиста обновлена!');
        }
      } catch (err: any) {
        toast.error(err.message || 'Ошибка загрузки обложки');
      } finally {
        setUploadingCover(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleToggleDownload = async () => {
    if (downloading) return;

    if (isDownloaded) {
      const ok = await confirmDialog({
        title: 'Удалить оффлайн-треки?',
        message: `Вы уверены, что хотите удалить все скачанные треки плейлиста «${playlist.name}» из памяти устройства?`,
        confirmText: 'Удалить',
        cancelText: 'Отмена',
        isDestructive: true
      });
      if (!ok) return;

      try {
        await removeDownload(playlist.id, tracks);
        toast.info(`Скачанные треки плейлиста «${playlist.name}» удалены из памяти`);
      } catch (e: any) {
        toast.error(e.message || 'Ошибка удаления из оффлайн');
      }
    } else {
      try {
        await startDownload(playlist.id, tracks, playlist);
        toast.success(`Скачивание треков плейлиста «${playlist.name}» начато`);
      } catch (e: any) {
        toast.error(e.message || 'Ошибка сохранения оффлайн');
      }
    }
  };

  return (
    <div className="w-full max-w-full flex flex-col md:flex-row items-center md:items-end gap-5 mb-6 pt-2 select-none overflow-hidden">
      {/* Cover Art */}
      <div className="relative group w-44 h-44 md:w-52 md:h-52 rounded-3xl bg-cat-surface0 shadow-2xl overflow-hidden flex-shrink-0 flex items-center justify-center border border-cat-surface1/30">
        {playlist.cover_url ? (
          <img src={playlist.cover_url} alt="" className="w-full h-full object-cover" />
        ) : (
          <Music2 className="w-20 h-20 text-cat-mauve/40" />
        )}

        {/* Change Cover Hover/Click Overlay */}
        <label
          htmlFor={`playlist-cover-input-${playlist.id}`}
          className={`absolute inset-0 bg-cat-crust/70 backdrop-blur-xs flex flex-col items-center justify-center gap-1.5 text-cat-text cursor-pointer transition-all duration-200 ${
            uploadingCover ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          title="Сменить обложку плейлиста"
        >
          {uploadingCover ? (
            <Loader2 className="w-7 h-7 text-cat-mauve animate-spin" />
          ) : (
            <>
              <Camera className="w-7 h-7 text-cat-mauve drop-shadow" />
              <span className="text-xs font-bold drop-shadow">Сменить обложку</span>
            </>
          )}
        </label>
        <input
          id={`playlist-cover-input-${playlist.id}`}
          type="file"
          accept="image/*"
          disabled={uploadingCover}
          className="hidden"
          onChange={handleCoverFileChange}
        />
      </div>

      {/* Info & Action Buttons */}
      <div className="w-full max-w-full flex-1 text-center md:text-left min-w-0 px-2 sm:px-0">
        <span className="text-xs uppercase tracking-wider text-cat-subtext0 font-semibold block truncate">
          {isDailyMix ? 'Персональный Плейлист дня' : 'Плейлист'}
        </span>
        <h1 className="text-xl sm:text-2xl md:text-4xl font-extrabold text-cat-text mt-1 break-words line-clamp-2 md:line-clamp-none leading-tight">
          {playlist.name}
        </h1>
        {playlist.description && (
          <p className="text-xs sm:text-sm text-cat-subtext0 mt-1.5 line-clamp-3 md:line-clamp-none break-words">
            {playlist.description}
          </p>
        )}
        <div className="text-xs text-cat-subtext0 mt-2 flex items-center justify-center md:justify-start gap-2 flex-wrap">
          {activeJob && activeJob.status === 'downloading' ? (
            <span className="text-cat-mauve font-semibold flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Загружено {tracks.length} из {activeJob.total_tracks} треков
            </span>
          ) : (
            <span>{tracks.length} треков</span>
          )}
        </div>

        {/* Buttons Row */}
        <div className="flex items-center justify-center md:justify-start gap-3 mt-4 flex-wrap w-full max-w-full">
          <button
            onClick={onPlayAll}
            disabled={tracks.length === 0}
            className="flex items-center gap-2 px-6 py-3 rounded-full bg-cat-mauve text-cat-base font-bold hover:opacity-95 active:scale-95 transition-all shadow-lg shadow-cat-mauve/20 disabled:opacity-40"
          >
            <Play className="w-5 h-5 fill-current" />
            Слушать
          </button>

          <button
            onClick={onShuffleAll}
            disabled={tracks.length === 0}
            title="Перемешать"
            className="p-3 rounded-full bg-cat-surface0 hover:bg-cat-surface1 text-cat-text active:scale-95 transition-all disabled:opacity-40 cursor-pointer"
          >
            <Shuffle className="w-5 h-5" />
          </button>

          <button
            onClick={handleToggleDownload}
            disabled={tracks.length === 0 || downloading}
            title={isDownloaded ? 'Удалить из оффлайн' : 'Скачать весь плейлист оффлайн'}
            className={`flex items-center gap-1.5 p-3 rounded-full active:scale-95 transition-all disabled:opacity-40 cursor-pointer shrink-0 ${
              isDownloaded
                ? 'bg-cat-green/20 text-cat-green border border-cat-green/30'
                : 'bg-cat-surface0 hover:bg-cat-surface1 text-cat-subtext0 hover:text-cat-text'
            }`}
          >
            {downloading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin text-cat-mauve" />
                <span className="text-xs font-mono">{progressText}</span>
              </>
            ) : isDownloaded ? (
              <Check className="w-5 h-5" />
            ) : (
              <Download className="w-5 h-5" />
            )}
          </button>

          {isDailyMix && (
            <button
              onClick={async () => {
                if (savingMix) return;
                setSavingMix(true);
                try {
                  const res = await apiRequest<{ id: number; name: string }>(`/daily-mixes/${playlist.id}/save`, {
                    method: 'POST',
                  });
                  toast.success(`Сохранено в медиатеку как «${res.name}»`);
                  onRename?.(res.name);
                } catch (err: any) {
                  toast.error(err.message || 'Ошибка сохранения микса');
                } finally {
                  setSavingMix(false);
                }
              }}
              disabled={savingMix || tracks.length === 0}
              title="Сохранить этот Микс дня как постоянный плейлист"
              className="flex items-center gap-1.5 px-4 py-3 rounded-full bg-cat-surface0 hover:bg-cat-surface1 text-cat-text text-xs font-semibold active:scale-95 transition-all disabled:opacity-40 cursor-pointer shrink-0"
            >
              {savingMix ? (
                <Loader2 className="w-4 h-4 animate-spin text-cat-mauve" />
              ) : (
                <BookmarkPlus className="w-4 h-4 text-cat-mauve" />
              )}
              <span>Сохранить в медиатеку</span>
            </button>
          )}

          {/* Rename Playlist Button */}
          {!isLikedPlaylist && !isDailyMix && (
            <button
              onClick={() => {
                setRenameName(playlist.name);
                setRenameDesc(playlist.description || '');
                setShowRenameModal(true);
              }}
              title="Переименовать плейлист"
              className="p-3 rounded-full bg-cat-surface0 hover:bg-cat-surface1 text-cat-subtext0 hover:text-cat-mauve active:scale-95 transition-all cursor-pointer shrink-0"
            >
              <Pencil className="w-5 h-5" />
            </button>
          )}

          {/* Delete Playlist Button */}
          {onDelete && !isDailyMix && (
            <button
              onClick={handleDeletePlaylist}
              disabled={deletingPlaylist}
              title="Удалить плейлист"
              className="p-3 rounded-full bg-cat-surface0 hover:bg-cat-red/20 text-cat-subtext0 hover:text-cat-red active:scale-95 transition-all disabled:opacity-40 cursor-pointer shrink-0"
            >
              {deletingPlaylist ? (
                <Loader2 className="w-5 h-5 animate-spin text-cat-red" />
              ) : (
                <Trash2 className="w-5 h-5" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Rename Playlist Modal */}
      {showRenameModal && (
        <div className="fixed inset-0 z-50 bg-cat-crust/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-cat-mantle border border-cat-surface0/80 rounded-3xl p-6 max-w-sm w-full shadow-2xl animate-in zoom-in-95 duration-200">
            <h3 className="font-bold text-lg text-cat-text mb-4">Переименовать плейлист</h3>
            <form onSubmit={handleRenameSubmit} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-cat-subtext0 uppercase tracking-wider block mb-1">
                  Название
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  placeholder="Новое название плейлиста"
                  value={renameName}
                  onChange={(e) => setRenameName(e.target.value)}
                  className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-cat-subtext0 uppercase tracking-wider block mb-1">
                  Описание (необязательно)
                </label>
                <textarea
                  rows={2}
                  placeholder="Описание плейлиста..."
                  value={renameDesc}
                  onChange={(e) => setRenameDesc(e.target.value)}
                  className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve resize-none"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowRenameModal(false)}
                  disabled={savingRename}
                  className="flex-1 py-2.5 rounded-2xl bg-cat-surface0 hover:bg-cat-surface1 text-sm font-semibold text-cat-subtext0 hover:text-cat-text transition-colors"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={savingRename || !renameName.trim()}
                  className="flex-1 py-2.5 rounded-2xl bg-cat-mauve hover:opacity-90 active:scale-95 text-sm font-bold text-cat-base transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {savingRename && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>Сохранить</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
