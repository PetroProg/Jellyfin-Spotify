import React, { useState, useEffect, useRef } from 'react';
import {
  User,
  Lock,
  Trash2,
  HardDrive,
  Ban,
  LogOut,
  Check,
  AlertTriangle,
  Eye,
  EyeOff,
  ArrowLeft,
  Radio,
  ExternalLink,
  Copy,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  Heart,
  Download,
  Globe,
  Moon,
  Clock,
  Sparkles,
  Upload,
  Database,
  Sliders
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import { useOfflineStore } from '../store/offlineStore';
import { apiRequest } from '../api/client';
import { getOfflineStorageUsage, clearAllOfflineCache } from '../utils/offline';
import { BlacklistItem, DownloadJob, Playlist } from '../types';
import { toast, confirmDialog } from '../store/toastStore';
import { useI18nStore } from '../store/i18nStore';

interface SettingsProps {
  onBack?: () => void;
}

interface SpotifyOAuthStatus {
  hasCredentials: boolean;
  isConnected: boolean;
  updatedAt: string | null;
  clientId: string;
  redirectUri: string;
}

interface DailyMixSchedule {
  enabled: boolean;
  hour: number;
  timezone: string;
  currentTime: string;
  currentDate: string;
  isGeneratedToday: boolean;
  isDownloading: boolean;
  mixCount: number;
  totalTracks: number;
  isOnline: boolean;
  isPlaying: boolean;
}

export const Settings: React.FC<SettingsProps> = ({ onBack }) => {
  const { user, logout, updateDisplayName } = useAuthStore();
  const { lang, setLang, t } = useI18nStore();
  const [displayName, setDisplayName] = useState(user?.display_name || '');
  const [nameSaved, setNameSaved] = useState(false);

  // Password Change
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showCurrentPass, setShowCurrentPass] = useState(false);
  const [showNewPass, setShowNewPass] = useState(false);
  const [passMsg, setPassMsg] = useState('');
  const [passError, setPassError] = useState('');

  // Offline Cache
  const [cacheSize, setCacheSize] = useState(() => t('Calculating...', 'Вычисление...'));
  const [clearingCache, setClearingCache] = useState(false);

  // Blacklist
  const [blacklist, setBlacklist] = useState<BlacklistItem[]>([]);

  // Spotify OAuth State
  const [spotifyStatus, setSpotifyStatus] = useState<SpotifyOAuthStatus | null>(null);
  const [spotifyClientId, setSpotifyClientId] = useState('');
  const [spotifyClientSecret, setSpotifyClientSecret] = useState('');
  const [showSpotifySecret, setShowSpotifySecret] = useState(false);
  const [savingSpotifyKeys, setSavingSpotifyKeys] = useState(false);
  const [connectingSpotify, setConnectingSpotify] = useState(false);
  const [showSpotifyGuide, setShowSpotifyGuide] = useState(false);
  const [copiedUri, setCopiedUri] = useState(false);
  const [importingLiked, setImportingLiked] = useState(false);
  const [importingPlaylists, setImportingPlaylists] = useState(false);
  const [likedJob, setLikedJob] = useState<DownloadJob | null>(null);

  // Daily Mix Schedule State
  const [mixSchedule, setMixSchedule] = useState<DailyMixSchedule | null>(null);
  const [loadingSchedule, setLoadingSchedule] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [manualGenerating, setManualGenerating] = useState(false);

  // Account Deletion Modal
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Crossfade & Library Backup/Restore
  const { crossfade, setCrossfade } = usePlayerStore();
  const [exportingBackup, setExportingBackup] = useState(false);
  const [importingBackup, setImportingBackup] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExportBackup = async () => {
    try {
      setExportingBackup(true);
      const data = await apiRequest<any>('/user/library/backup');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const dateStr = new Date().toISOString().split('T')[0];
      a.download = `jellyfy-backup-${user?.username || 'user'}-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(t('Library backup successfully exported!', 'Резервная копия медиатеки успешно экспортирована!'));
    } catch (err: any) {
      toast.error(err.message || t('Failed to export backup', 'Не удалось экспортировать резервную копию'));
    } finally {
      setExportingBackup(false);
    }
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    try {
      const text = await file.text();
      const json = JSON.parse(text);

      if (!json || (!Array.isArray(json.playlists) && !Array.isArray(json.likedTracks))) {
        toast.error(t('Invalid backup file format', 'Неверный формат файла резервной копии'));
        return;
      }

      const confirmed = await confirmDialog({
        title: t('Restore Library?', 'Восстановить медиатеку?'),
        message: t(
          `File contains ${json.likedTracks?.length || 0} liked tracks and ${json.playlists?.length || 0} playlists. Do you want to restore them to your account?`,
          `В файле обнаружено ${json.likedTracks?.length || 0} любимых треков и ${json.playlists?.length || 0} плейлистов. Восстановить их в ваш аккаунт?`
        ),
        confirmText: t('Restore', 'Восстановить'),
        cancelText: t('Cancel', 'Отмена'),
      });

      if (!confirmed) return;

      setImportingBackup(true);
      const result = await apiRequest<any>('/user/library/restore', {
        method: 'POST',
        body: JSON.stringify(json),
      });

      toast.success(
        t(
          `Restored: ${result.restoredLikes || 0} likes, ${result.restoredPlaylists || 0} playlists (${result.restoredTracks || 0} tracks)`,
          `Восстановлено: ${result.restoredLikes || 0} лайков, ${result.restoredPlaylists || 0} плейлистов (${result.restoredTracks || 0} треков)`
        )
      );
      usePlayerStore.getState().loadLikes();
    } catch (err: any) {
      toast.error(err.message || t('Error importing backup', 'Ошибка при восстановлении из резервной копии'));
    } finally {
      setImportingBackup(false);
    }
  };

  const loadSpotifyStatus = async () => {
    try {
      const data = await apiRequest<SpotifyOAuthStatus>('/spotify/status');
      setSpotifyStatus(data);
      if (data.clientId && !spotifyClientId) {
        setSpotifyClientId(data.clientId);
      }
    } catch (e) {
      console.warn('Could not fetch Spotify status:', e);
    }
  };

  const loadMixSchedule = async () => {
    try {
      setLoadingSchedule(true);
      const data = await apiRequest<DailyMixSchedule>('/daily-mixes/schedule');
      setMixSchedule(data);
    } catch (e) {
      console.warn('Could not fetch Daily Mix schedule:', e);
    } finally {
      setLoadingSchedule(false);
    }
  };

  const handleUpdateSchedule = async (updates: Partial<{ enabled: boolean; hour: number }>) => {
    try {
      setSavingSchedule(true);
      const updated = await apiRequest<DailyMixSchedule>('/daily-mixes/schedule', {
        method: 'PUT',
        body: JSON.stringify(updates)
      });
      setMixSchedule(updated);
      toast.success(t('Schedule settings updated', 'Настройки расписания обновлены'));
    } catch (e: any) {
      toast.error(e.message || t('Failed to update schedule', 'Ошибка обновления расписания'));
    } finally {
      setSavingSchedule(false);
    }
  };

  const handleManualGenerateMixes = async () => {
    try {
      setManualGenerating(true);
      await apiRequest('/daily-mixes/refresh', { method: 'POST' });
      toast.success(
        t('Daily mixes generated! Downloads started in background.', 'Миксы дня созданы! Скачивание запущено в фоне.')
      );
      await loadMixSchedule();
    } catch (e: any) {
      toast.error(e.message || t('Failed to generate daily mixes', 'Ошибка генерации миксов'));
    } finally {
      setManualGenerating(false);
    }
  };

  useEffect(() => {
    getOfflineStorageUsage().then(setCacheSize);
    loadBlacklist();
    loadSpotifyStatus();
    loadMixSchedule();

    const params = new URLSearchParams(window.location.search);
    const spSuccess = params.get('spotify_connected');
    const spError = params.get('spotify_error');

    if (spSuccess === '1') {
      toast.success(
        t(
          'Spotify account connected! The 100-track limit is now removed.',
          'Аккаунт Spotify успешно подключен! Лимит на 100 треков снят.'
        ),
        t('Spotify Connected', 'Spotify подключен')
      );
      window.history.replaceState({}, '', window.location.pathname);
      loadSpotifyStatus();
    } else if (spError) {
      toast.error(spError, t('Spotify Authorization Error', 'Ошибка авторизации Spotify'));
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [lang]);

  useEffect(() => {
    if (!spotifyStatus?.isConnected) return;

    const pollLikedJob = async () => {
      try {
        const data = await apiRequest<{ jobs: DownloadJob[] }>('/spotify/jobs');
        const active = (data.jobs || []).find(
          (j) =>
            (j.playlist_name === 'Любимые треки' || j.playlist_id === null) &&
            (j.status === 'downloading' || j.status === 'pending')
        );
        setLikedJob(active || null);
      } catch (_) {}
    };

    pollLikedJob();
    const timer = setInterval(pollLikedJob, 2500);
    return () => clearInterval(timer);
  }, [spotifyStatus?.isConnected]);

  const scrollToTop = () => {
    containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const loadBlacklist = async () => {
    try {
      const data = await apiRequest<{ blacklist: BlacklistItem[] }>('/blacklist');
      setBlacklist(data.blacklist || []);
    } catch (e) {
      console.warn(e);
    }
  };

  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiRequest<{ display_name: string }>('/user/profile', {
        method: 'PUT',
        body: JSON.stringify({ display_name: displayName })
      });
      updateDisplayName(res.display_name);
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2500);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPassMsg('');
    setPassError('');
    try {
      const res = await apiRequest<{ message: string }>('/user/password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword, newPassword })
      });
      setPassMsg(res.message ? t('Password updated successfully', res.message) : t('Password updated', 'Пароль обновлен'));
      setCurrentPassword('');
      setNewPassword('');
    } catch (e: any) {
      setPassError(e.message);
    }
  };

  const handleClearCache = async () => {
    const ok = await confirmDialog({
      title: t('Clear offline cache?', 'Очистить оффлайн-кеш?'),
      message: t(
        'All tracks downloaded for offline playback on this device will be removed. Server files will remain untouched.',
        'Все скачанные для работы без интернета треки будут удалены с этого устройства. На сервере файлы останутся нетронутыми.'
      ),
      confirmText: t('Clear Cache', 'Очистить кеш'),
      cancelText: t('Cancel', 'Отмена'),
      isDestructive: true
    });
    if (!ok) return;

    setClearingCache(true);
    try {
      await clearAllOfflineCache();
      useOfflineStore.getState().loadDownloaded();
      const updated = await getOfflineStorageUsage();
      setCacheSize(updated);
      toast.info(t('Offline cache cleared', 'Оффлайн-кеш успешно очищен'));
    } finally {
      setClearingCache(false);
    }
  };

  const handleRemoveBlacklist = async (id: number) => {
    try {
      await apiRequest(`/blacklist/${id}`, { method: 'DELETE' });
      setBlacklist((prev) => prev.filter((item) => item.id !== id));
    } catch (e) {
      console.warn(e);
    }
  };

  const handleSaveSpotifyCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!spotifyClientId.trim() || !spotifyClientSecret.trim()) {
      toast.warning(t('Please enter both Client ID and Client Secret', 'Пожалуйста, введите Client ID и Client Secret'));
      return;
    }

    setSavingSpotifyKeys(true);
    try {
      const res = await apiRequest<{ message: string }>('/spotify/credentials', {
        method: 'POST',
        body: JSON.stringify({
          clientId: spotifyClientId.trim(),
          clientSecret: spotifyClientSecret.trim()
        })
      });
      toast.success(
        t('Spotify keys saved! Now click "Connect Spotify".', 'Ключи Spotify сохранены! Теперь нажмите «Подключить аккаунт Spotify».')
      );
      setSpotifyClientSecret('');
      await loadSpotifyStatus();
    } catch (err: any) {
      toast.error(err.message || t('Failed to save Spotify keys', 'Ошибка сохранения ключей Spotify'));
    } finally {
      setSavingSpotifyKeys(false);
    }
  };

  const handleConnectSpotify = async () => {
    setConnectingSpotify(true);
    try {
      const res = await apiRequest<{ url: string }>('/spotify/auth-url');
      if (res.url) {
        window.location.href = res.url;
      }
    } catch (err: any) {
      toast.error(err.message || t('Failed to get Spotify authorization URL', 'Не удалось получить ссылку авторизации Spotify'));
      setConnectingSpotify(false);
    }
  };

  const handleDisconnectSpotify = async () => {
    const ok = await confirmDialog({
      title: t('Disconnect Spotify?', 'Отключить Spotify?'),
      message: t(
        'Are you sure you want to unlink your Spotify account? Importing playlists with more than 100 tracks will become unavailable again until reconnected.',
        'Вы уверены, что хотите отвязать аккаунт Spotify? Импорт плейлистов свыше 100 треков снова станет недоступен до повторного подключения.'
      ),
      confirmText: t('Disconnect', 'Отключить'),
      cancelText: t('Cancel', 'Отмена'),
      isDestructive: true
    });
    if (!ok) return;

    try {
      await apiRequest('/spotify/disconnect', { method: 'POST' });
      toast.info(t('Spotify account disconnected', 'Аккаунт Spotify отключен'));
      await loadSpotifyStatus();
    } catch (err: any) {
      toast.error(err.message || t('Failed to disconnect Spotify', 'Ошибка отключения Spotify'));
    }
  };

  const handleImportLikedSongs = async () => {
    if (importingLiked) return;
    setImportingLiked(true);
    try {
      const res = await apiRequest<{ message: string; totalTracks: number; alreadyLikedCount: number }>(
        '/spotify/import-liked',
        { method: 'POST' }
      );
      toast.success(
        res.message || t('Started syncing Liked Songs!', 'Синхронизация любимых треков запущена!'),
        t('Liked Songs', 'Любимые треки')
      );
      const jobsData = await apiRequest<{ jobs: DownloadJob[] }>('/spotify/jobs');
      const active = (jobsData.jobs || []).find(
        (j) =>
          (j.playlist_name === 'Любимые треки' || j.playlist_id === null) &&
          (j.status === 'downloading' || j.status === 'pending')
      );
      setLikedJob(active || null);
    } catch (err: any) {
      toast.error(err.message || t('Failed to import Liked Songs', 'Ошибка импорта любимых треков'));
    } finally {
      setImportingLiked(false);
    }
  };

  const handleImportUserPlaylists = async () => {
    if (importingPlaylists) return;
    setImportingPlaylists(true);
    try {
      const res = await apiRequest<{ message: string; totalPlaylists: number; queuedPlaylists: number }>(
        '/spotify/import-user-playlists',
        { method: 'POST' }
      );
      toast.success(
        res.message || t('Started syncing your Spotify playlists!', 'Синхронизация плейлистов запущена!'),
        t('My Playlists', 'Мои плейлисты')
      );
    } catch (err: any) {
      toast.error(err.message || t('Failed to import playlists from Spotify', 'Ошибка импорта плейлистов из Spotify'));
    } finally {
      setImportingPlaylists(false);
    }
  };

  const handleCopyRedirectUri = () => {
    const uri = spotifyStatus?.redirectUri || `${window.location.origin}/api/spotify/callback`;
    navigator.clipboard.writeText(uri);
    setCopiedUri(true);
    toast.info(t('Redirect URI copied to clipboard', 'Redirect URI скопирован в буфер обмена'));
    setTimeout(() => setCopiedUri(false), 2000);
  };

  const handleDeleteAccount = async () => {
    if (!deletePassword) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await apiRequest('/user/account', {
        method: 'DELETE',
        body: JSON.stringify({ password: deletePassword })
      });
      await clearAllOfflineCache();
      logout();
    } catch (e: any) {
      setDeleteError(e.message || t('Failed to delete account', 'Ошибка удаления аккаунта'));
      setDeleting(false);
    }
  };

  const redirectUriDisplay = spotifyStatus?.redirectUri || `${window.location.origin}/api/spotify/callback`;

  return (
    <div
      ref={containerRef}
      onScroll={(e) => setShowScrollTop(e.currentTarget.scrollTop > 200)}
      className="flex-1 w-full max-w-full overflow-y-auto overflow-x-hidden px-4 md:px-8 py-6 pb-28 md:pb-24 select-none max-w-3xl custom-scrollbar"
    >
      {onBack && (
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-cat-surface0/80 hover:bg-cat-surface1 border border-cat-surface1/50 text-sm font-semibold text-cat-subtext0 hover:text-cat-text transition-all duration-200 mb-4 cursor-pointer active:scale-95 group shadow-sm w-fit"
          title={t('Go back', 'Вернуться назад')}
        >
          <ArrowLeft className="w-4 h-4 text-cat-mauve transition-transform group-hover:-translate-x-1" />
          <span>{t('Back', 'Назад')}</span>
        </button>
      )}

      <h1 className="text-2xl md:text-3xl font-extrabold text-cat-text mb-6">
        {t('Settings', 'Настройки')}
      </h1>

      <div className="space-y-6">
        {/* 0. Language Selector Block */}
        <section className="bg-cat-mantle p-6 rounded-3xl border border-cat-surface0/60">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-cat-mauve/20 text-cat-mauve">
                <Globe className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-bold text-base text-cat-text">
                  {t('Interface Language', 'Язык интерфейса')}
                </h2>
                <p className="text-xs text-cat-subtext0">
                  {t('Choose your preferred language across all pages', 'Выберите язык отображения для всех страниц')}
                </p>
              </div>
            </div>

            <div className="flex items-center bg-cat-surface0 p-1 rounded-2xl border border-cat-surface1/40 self-start sm:self-auto">
              <button
                type="button"
                onClick={() => setLang('en')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  lang === 'en'
                    ? 'bg-cat-mauve text-cat-base shadow-md'
                    : 'text-cat-subtext0 hover:text-cat-text'
                }`}
              >
                English
              </button>
              <button
                type="button"
                onClick={() => setLang('ru')}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  lang === 'ru'
                    ? 'bg-cat-mauve text-cat-base shadow-md'
                    : 'text-cat-subtext0 hover:text-cat-text'
                }`}
              >
                Русский
              </button>
            </div>
          </div>
        </section>

        {/* 0.5 Crossfade & Smooth Transitions */}
        <section className="bg-cat-mantle p-6 rounded-3xl border border-cat-surface0/60">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-cat-mauve/20 text-cat-mauve">
                <Sliders className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-bold text-base text-cat-text">
                    {t('Crossfade (Smooth Transitions)', 'Кроссфейд (Плавный переход)')}
                  </h2>
                  <span className="text-xs font-mono font-bold text-cat-mauve">
                    {crossfade === 0 ? t('Off', 'Выкл') : `${crossfade} ${t('sec', 'сек')}`}
                  </span>
                </div>
                <p className="text-xs text-cat-subtext0 mt-0.5">
                  {t(
                    'Smoothly fades out song ends and fades in new tracks, eliminating gaps and clicks',
                    'Плавное затухание в конце и нарастание в начале следующего трека без пауз и щелчков'
                  )}
                </p>
              </div>
            </div>

            <div className="flex items-center bg-cat-surface0 p-1 rounded-2xl border border-cat-surface1/40 flex-wrap gap-1 self-start sm:self-auto">
              {[0, 1, 2, 3, 5, 8].map((sec) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => {
                    setCrossfade(sec);
                    if (sec === 0) {
                      toast.info(t('Crossfade disabled', 'Кроссфейд отключен'));
                    } else {
                      toast.success(t(`Crossfade set to ${sec}s`, `Кроссфейд: ${sec} сек`));
                    }
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                    crossfade === sec
                      ? 'bg-cat-mauve text-cat-base shadow-md'
                      : 'text-cat-subtext0 hover:text-cat-text'
                  }`}
                >
                  {sec === 0 ? t('Off', 'Выкл') : `${sec}s`}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* 1. Profile Name */}
        <section className="bg-cat-mantle p-6 rounded-3xl border border-cat-surface0/60">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 rounded-xl bg-cat-mauve/20 text-cat-mauve">
              <User className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-base text-cat-text">{t('Profile', 'Профиль')}</h2>
              <p className="text-xs text-cat-subtext0">
                {t('Login:', 'Логин:')} {user?.username}
              </p>
            </div>
          </div>

          <form onSubmit={handleSaveName} className="space-y-3">
            <div>
              <label className="text-xs text-cat-subtext0 block mb-1">
                {t('Display Name', 'Отображаемое имя')}
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="flex-1 bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve"
                  placeholder={t('Your name', 'Ваше имя')}
                />
                <button
                  type="submit"
                  className="px-5 py-2.5 rounded-2xl bg-cat-mauve text-cat-base font-bold text-xs hover:opacity-90 active:scale-95 transition-all flex items-center justify-center gap-1.5"
                >
                  {nameSaved ? (
                    <>
                      <Check className="w-4 h-4" /> {t('Saved', 'Сохранено')}
                    </>
                  ) : (
                    t('Save', 'Сохранить')
                  )}
                </button>
              </div>
            </div>
          </form>
        </section>

        {/* 2. Spotify Account Integration */}
        <section className="bg-cat-mantle p-6 rounded-3xl border border-cat-green/30 shadow-lg">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-cat-green/20 text-cat-green">
                <Radio className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="font-bold text-base text-cat-text">
                    {t('Spotify Integration', 'Интеграция со Spotify')}
                  </h2>
                  {spotifyStatus?.isConnected ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-cat-green/20 text-cat-green border border-cat-green/30">
                      <CheckCircle2 className="w-3 h-3" /> {t('Connected (No limits)', 'Подключено (Без лимитов)')}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-cat-surface0 text-cat-subtext0">
                      {t('Guest mode (up to 100 tracks)', 'Гостевой режим (до 100 треков)')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-cat-subtext0 mt-0.5">
                  {t(
                    'Connect your personal Spotify account to import playlists of any size (100+ tracks)',
                    'Привяжите личный аккаунт Spotify для импорта плейлистов любого размера (100+ треков)'
                  )}
                </p>
              </div>
            </div>

            {spotifyStatus?.isConnected ? (
              <div className="flex items-center gap-2 self-start sm:self-center">
                <button
                  onClick={handleConnectSpotify}
                  disabled={connectingSpotify}
                  className="px-3 py-1.5 rounded-xl bg-cat-surface0 hover:bg-cat-surface1 text-xs font-semibold text-cat-text flex items-center gap-1.5 transition-colors cursor-pointer"
                  title={t('Refresh token', 'Переподключить токен')}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${connectingSpotify ? 'animate-spin' : ''}`} />
                  <span>{t('Reconnect', 'Обновить')}</span>
                </button>
                <button
                  onClick={handleDisconnectSpotify}
                  className="px-3 py-1.5 rounded-xl bg-cat-red/15 hover:bg-cat-red/25 text-xs font-semibold text-cat-red transition-colors cursor-pointer"
                >
                  {t('Disconnect', 'Отключить')}
                </button>
              </div>
            ) : (
              spotifyStatus?.hasCredentials && (
                <div className="self-start sm:self-center">
                  <button
                    type="button"
                    onClick={handleConnectSpotify}
                    disabled={connectingSpotify}
                    className="px-4 py-2 rounded-2xl bg-cat-green text-cat-base font-bold text-xs hover:opacity-95 active:scale-95 transition-all shadow-md flex items-center gap-2 cursor-pointer"
                  >
                    {connectingSpotify ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <ExternalLink className="w-4 h-4" />
                    )}
                    <span>{t('Connect Spotify Account', 'Войти в аккаунт Spotify')}</span>
                  </button>
                </div>
              )
            )}
          </div>

          {spotifyStatus?.isConnected && (
            <div className="mb-5 p-4 rounded-2xl bg-gradient-to-br from-cat-mauve/15 via-cat-surface0/50 to-cat-pink/15 border border-cat-mauve/30 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cat-mauve to-cat-pink flex items-center justify-center text-cat-base shadow-md shrink-0 mt-0.5">
                    <Heart className="w-5 h-5 fill-current" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-cat-text">
                      {t('Transfer Liked Songs from Spotify', 'Перенос «Любимых треков» из Spotify')}
                    </h3>
                    <p className="text-xs text-cat-subtext0 mt-0.5 leading-relaxed">
                      {t(
                        'Downloads all liked tracks from your Spotify account and adds them to your "Liked Songs" tab. Existing tracks on the site are never deleted.',
                        'Скачивает все лайкнутые треки из вашего аккаунта Spotify и добавляет их во вкладку «Любимые треки». Треки, которые уже есть на сайте, никогда не удаляются.'
                      )}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleImportLikedSongs}
                  disabled={
                    importingLiked || Boolean(likedJob && (likedJob.status === 'downloading' || likedJob.status === 'pending'))
                  }
                  className="px-4 py-2.5 rounded-2xl bg-cat-mauve text-cat-base font-bold text-xs hover:opacity-95 active:scale-95 transition-all flex items-center justify-center gap-2 shadow-md disabled:opacity-50 cursor-pointer shrink-0"
                >
                  {importingLiked || (likedJob && (likedJob.status === 'downloading' || likedJob.status === 'pending')) ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>{t('Syncing...', 'Синхронизация...')}</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4" />
                      <span>{t('Sync Liked Songs', 'Синхронизировать любимые треки')}</span>
                    </>
                  )}
                </button>
              </div>

              {likedJob && (likedJob.status === 'downloading' || likedJob.status === 'pending') && (
                <div className="pt-2 border-t border-cat-surface1/40">
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="text-cat-subtext0 truncate pr-2">
                      {likedJob.current_track
                        ? t(`Downloading: ${likedJob.current_track}`, `Качается: ${likedJob.current_track}`)
                        : t('Preparing track list...', 'Подготовка списка треков...')}
                    </span>
                    <span className="font-mono font-bold text-cat-mauve shrink-0">
                      {likedJob.downloaded_tracks || 0} / {likedJob.total_tracks || 0}
                    </span>
                  </div>
                  <div className="w-full bg-cat-surface0 h-2 rounded-full overflow-hidden">
                    <div
                      className="bg-gradient-to-r from-cat-mauve to-cat-pink h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${Math.max(
                          4,
                          Math.min(100, Math.round(((likedJob.downloaded_tracks || 0) / (likedJob.total_tracks || 1)) * 100))
                        )}%`
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Sync User Playlists from Spotify */}
              <div className="pt-3 border-t border-cat-surface1/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h4 className="text-xs font-bold text-cat-text">
                    {t('Transfer All My Playlists from Spotify', 'Перенос всех ваших плейлистов из Spotify')}
                  </h4>
                  <p className="text-[11px] text-cat-subtext0 mt-0.5">
                    {t(
                      'Automatically imports all playlists saved in your Spotify library without track limits.',
                      'Автоматически импортирует все плейлисты, сохраненные в вашей медиатеке Spotify, без лимита на количество треков.'
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleImportUserPlaylists}
                  disabled={importingPlaylists}
                  className="px-4 py-2 rounded-2xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-text font-bold text-xs border border-cat-surface1/60 active:scale-95 transition-all flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer shrink-0"
                >
                  {importingPlaylists ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-cat-mauve" />
                      <span>{t('Checking playlists...', 'Проверка плейлистов...')}</span>
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 text-cat-mauve" />
                      <span>{t('Import My Playlists', 'Импортировать мои плейлисты')}</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Setup Guide Collapsible */}
          <div className="mb-4">
            <button
              type="button"
              onClick={() => setShowSpotifyGuide(!showSpotifyGuide)}
              className="w-full flex items-center justify-between px-4 py-2.5 rounded-2xl bg-cat-surface0/60 hover:bg-cat-surface0 border border-cat-surface1/40 text-xs font-semibold text-cat-subtext1 transition-colors cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-cat-mauve" />
                <span>
                  {t(
                    'How to get your Client ID & Client Secret (takes 1 minute)',
                    'Как получить Client ID и Client Secret (занимает 1 минуту)'
                  )}
                </span>
              </span>
              {showSpotifyGuide ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {showSpotifyGuide && (
              <div className="mt-2 p-4 rounded-2xl bg-cat-surface0/40 border border-cat-surface1/30 text-xs text-cat-subtext0 space-y-2.5 leading-relaxed">
                <p>
                  1. {t('Open', 'Откройте')}{' '}
                  <a
                    href="https://developer.spotify.com/dashboard"
                    target="_blank"
                    rel="noreferrer"
                    className="text-cat-mauve font-semibold underline inline-flex items-center gap-1"
                  >
                    Spotify Developer Dashboard <ExternalLink className="w-3 h-3" />
                  </a>{' '}
                  {t('and log in to your Spotify account.', 'и войдите в свой аккаунт Spotify.')}
                </p>
                <p>
                  2. {t('Click', 'Нажмите')} <strong className="text-cat-text">«Create app»</strong>,{' '}
                  {t('enter any name (e.g.', 'укажите любое имя (например,')} <code>Jellyfy</code>
                  {t(') and description.', ') и описание.')}
                </p>
                <div>
                  <p className="mb-1.5">
                    3. {t('In the', 'В поле')} <strong className="text-cat-text">«Redirect URIs»</strong>{' '}
                    {t('paste this exact address and click', 'вставьте этот адрес и нажмите')}{' '}
                    <strong className="text-cat-text">Add</strong>:
                  </p>
                  <div className="flex items-center gap-2 bg-cat-crust/70 px-3 py-2 rounded-xl border border-cat-surface1/40">
                    <code className="text-[11px] text-cat-green font-mono break-all flex-1">
                      {redirectUriDisplay}
                    </code>
                    <button
                      type="button"
                      onClick={handleCopyRedirectUri}
                      className="p-1.5 rounded-lg bg-cat-surface0 hover:bg-cat-surface1 text-cat-text shrink-0 cursor-pointer"
                      title={t('Copy Redirect URI', 'Скопировать Redirect URI')}
                    >
                      {copiedUri ? <Check className="w-3.5 h-3.5 text-cat-green" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                <p>
                  4. {t('Save the app, open its', 'Сохраните приложение, перейдите в его')}{' '}
                  <strong className="text-cat-text">Settings</strong>{' '}
                  {t(
                    'and copy the Client ID and Client Secret into the fields below.',
                    'и скопируйте Client ID и Client Secret в поля ниже.'
                  )}
                </p>
              </div>
            )}
          </div>

          <form onSubmit={handleSaveSpotifyCredentials} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-semibold text-cat-subtext0 uppercase tracking-wider block mb-1">
                  Spotify Client ID
                </label>
                <input
                  type="text"
                  value={spotifyClientId}
                  onChange={(e) => setSpotifyClientId(e.target.value)}
                  placeholder="e.g. 4b9f8c2d..."
                  className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2.5 text-xs font-mono text-cat-text focus:outline-none focus:border-cat-mauve"
                />
              </div>

              <div>
                <label className="text-[11px] font-semibold text-cat-subtext0 uppercase tracking-wider block mb-1">
                  Spotify Client Secret
                </label>
                <div className="relative">
                  <input
                    type={showSpotifySecret ? 'text' : 'password'}
                    value={spotifyClientSecret}
                    onChange={(e) => setSpotifyClientSecret(e.target.value)}
                    placeholder={
                      spotifyStatus?.hasCredentials
                        ? t('•••••••• (Saved)', '•••••••• (Сохранен)')
                        : t('Enter Client Secret', 'Введите Client Secret')
                    }
                    className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl pl-4 pr-10 py-2.5 text-xs font-mono text-cat-text focus:outline-none focus:border-cat-mauve"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSpotifySecret(!showSpotifySecret)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-cat-subtext0 hover:text-cat-text"
                  >
                    {showSpotifySecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={savingSpotifyKeys || !spotifyClientId.trim() || !spotifyClientSecret.trim()}
                className="px-5 py-2.5 rounded-2xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-text font-bold text-xs transition-all disabled:opacity-40 cursor-pointer flex items-center gap-2"
              >
                {savingSpotifyKeys ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                <span>{t('Save Keys', 'Сохранить ключи')}</span>
              </button>

              {spotifyStatus?.hasCredentials && !spotifyStatus?.isConnected && (
                <button
                  type="button"
                  onClick={handleConnectSpotify}
                  disabled={connectingSpotify}
                  className="px-5 py-2.5 rounded-2xl bg-cat-green text-cat-base font-bold text-xs hover:opacity-95 active:scale-95 transition-all shadow-md flex items-center gap-2 cursor-pointer"
                >
                  {connectingSpotify ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <ExternalLink className="w-4 h-4" />
                  )}
                  <span>{t('Connect Spotify Account', 'Подключить аккаунт Spotify')}</span>
                </button>
              )}
            </div>
          </form>
        </section>

        {/* 2.5 Daily Mixes Nightly Auto-Update */}
        <section className="bg-cat-mantle p-6 rounded-3xl border border-cat-mauve/30 shadow-lg">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-cat-mauve/20 text-cat-mauve">
                <Moon className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="font-bold text-base text-cat-text">
                    {t('Daily Mixes (Nightly Update)', 'Миксы дня (Ночное обновление)')}
                  </h2>
                  {mixSchedule?.isDownloading ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-cat-blue/20 text-cat-blue border border-cat-blue/30">
                      <Loader2 className="w-3 h-3 animate-spin" /> {t('Downloading to server...', 'Качается на сервер...')}
                    </span>
                  ) : mixSchedule?.isGeneratedToday ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-cat-green/20 text-cat-green border border-cat-green/30">
                      <CheckCircle2 className="w-3 h-3" /> {t(`Ready for today (${mixSchedule.totalTracks} tracks)`, `Готовы на сегодня (${mixSchedule.totalTracks} треков)`)}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-cat-surface0 text-cat-subtext0">
                      <Clock className="w-3 h-3 text-cat-mauve" /> {t(`Scheduled at 0${mixSchedule?.hour || 3}:00`, `Запланировано на 0${mixSchedule?.hour || 3}:00`)}
                    </span>
                  )}
                </div>
                <p className="text-xs text-cat-subtext0 mt-0.5">
                  {t(
                    'Pre-downloads mixes to the server at 2–3 AM while you sleep, so they play instantly with 0s latency in the morning.',
                    'Предзагружает миксы на сервер в 2–3 ночи пока вы спите, чтобы утром они играли моментально без задержек.'
                  )}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleManualGenerateMixes}
              disabled={manualGenerating || mixSchedule?.isDownloading}
              className="px-3.5 py-2 rounded-2xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-text text-xs font-semibold flex items-center gap-2 border border-cat-surface1/60 active:scale-95 transition-all self-start sm:self-center disabled:opacity-40 cursor-pointer shrink-0"
              title={t('Generate fresh mixes now', 'Обновить миксы прямо сейчас')}
            >
              {manualGenerating || mixSchedule?.isDownloading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-cat-mauve" />
              ) : (
                <Sparkles className="w-3.5 h-3.5 text-cat-mauve" />
              )}
              <span>{t('Refresh Now', 'Обновить сейчас')}</span>
            </button>
          </div>

          <div className="space-y-4 pt-2">
            {/* Toggle enabled / disabled */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-cat-surface0/40 border border-cat-surface1/30">
              <div>
                <h4 className="text-xs font-bold text-cat-text">
                  {t('Enable Nightly Auto-Update', 'Включить ночное автообновление')}
                </h4>
                <p className="text-[11px] text-cat-subtext0 mt-0.5">
                  {t(
                    'Generates new mixes daily during sleep hours without requiring you to wait.',
                    'Ежедневно создает свежие миксы в часы сна, избавляя от ожидания загрузки.'
                  )}
                </p>
              </div>

              <button
                type="button"
                onClick={() => handleUpdateSchedule({ enabled: !mixSchedule?.enabled })}
                disabled={savingSchedule}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  mixSchedule?.enabled ? 'bg-cat-mauve' : 'bg-cat-surface1'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-cat-base shadow ring-0 transition duration-200 ease-in-out ${
                    mixSchedule?.enabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Preferred Nightly Hour */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-cat-surface0/40 border border-cat-surface1/30">
              <div>
                <h4 className="text-xs font-bold text-cat-text">
                  {t('Update Time Window', 'Время ночного обновления')}
                </h4>
                <p className="text-[11px] text-cat-subtext0 mt-0.5">
                  {t(
                    'Generation will start at this hour if you are offline and not listening to music.',
                    'Генерация начнется в этот час, если вы не в сети и не слушаете музыку.'
                  )}
                </p>
              </div>

              <div className="flex items-center gap-1.5 bg-cat-surface0 p-1 rounded-2xl border border-cat-surface1/40">
                {[
                  { hour: 2, label: '02:00' },
                  { hour: 3, label: '03:00' },
                  { hour: 4, label: '04:00' },
                  { hour: 5, label: '05:00' },
                ].map((item) => (
                  <button
                    key={item.hour}
                    type="button"
                    onClick={() => handleUpdateSchedule({ hour: item.hour })}
                    disabled={savingSchedule}
                    className={`px-3 py-1.5 rounded-xl text-xs font-mono font-bold transition-all cursor-pointer ${
                      (mixSchedule?.hour || 3) === item.hour
                        ? 'bg-cat-mauve text-cat-base shadow-sm'
                        : 'text-cat-subtext0 hover:text-cat-text'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Smart Offline Detection & Timezone info */}
            <div className="p-3.5 rounded-2xl bg-cat-surface0/20 border border-cat-surface1/20 flex items-start gap-2.5 text-xs text-cat-subtext0 leading-relaxed">
              <Clock className="w-4 h-4 text-cat-mauve shrink-0 mt-0.5" />
              <div>
                <span>
                  {t('Your local time: ', 'Ваше местное время: ')}
                  <strong className="text-cat-text font-mono">
                    {mixSchedule?.currentTime || '--:--'}
                  </strong>{' '}
                  ({mixSchedule?.timezone || 'Europe/Kyiv'}).{' '}
                  {t(
                    'Update strictly waits until you stop listening and go offline, so your evening listening is never interrupted.',
                    'Обновление строго ждет, пока вы перестанете слушать музыку и выйдете из сети, поэтому вечернее прослушивание никогда не прерывается.'
                  )}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* 3. Change Password */}
        <section className="bg-cat-mantle p-6 rounded-3xl border border-cat-surface0/60">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 rounded-xl bg-cat-peach/20 text-cat-peach">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-base text-cat-text">{t('Security', 'Безопасность')}</h2>
              <p className="text-xs text-cat-subtext0">{t('Change account password', 'Смена пароля аккаунта')}</p>
            </div>
          </div>

          <form onSubmit={handleChangePassword} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="relative">
                <input
                  type={showCurrentPass ? 'text' : 'password'}
                  placeholder={t('Current password', 'Текущий пароль')}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl pl-4 pr-11 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve"
                />
                <button
                  type="button"
                  onClick={() => setShowCurrentPass(!showCurrentPass)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-cat-subtext0 hover:text-cat-text transition-colors"
                  title={showCurrentPass ? t('Hide password', 'Скрыть пароль') : t('Show password', 'Показать пароль')}
                >
                  {showCurrentPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <div className="relative">
                <input
                  type={showNewPass ? 'text' : 'password'}
                  placeholder={t('New password (min. 4 chars)', 'Новый пароль (мин. 4 симв.)')}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl pl-4 pr-11 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPass(!showNewPass)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-cat-subtext0 hover:text-cat-text transition-colors"
                  title={showNewPass ? t('Hide password', 'Скрыть пароль') : t('Show password', 'Показать пароль')}
                >
                  {showNewPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            {passMsg && <p className="text-xs text-cat-green">{passMsg}</p>}
            {passError && <p className="text-xs text-cat-red">{passError}</p>}
            <button
              type="submit"
              disabled={!currentPassword || !newPassword}
              className="px-5 py-2.5 rounded-2xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-text font-bold text-xs transition-all disabled:opacity-40"
            >
              {t('Update Password', 'Обновить пароль')}
            </button>
          </form>
        </section>

        {/* 4. Offline Cache Management */}
        <section className="bg-cat-mantle p-6 rounded-3xl border border-cat-surface0/60 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-cat-green/20 text-cat-green">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-base text-cat-text">
                {t('Offline Storage (PWA)', 'Оффлайн-хранилище (PWA)')}
              </h2>
              <p className="text-xs text-cat-subtext0">
                {t('Used in browser cache:', 'Занято в кеше браузера:')}{' '}
                <span className="text-cat-text font-semibold">{cacheSize}</span>
              </p>
            </div>
          </div>

          <button
            onClick={handleClearCache}
            disabled={clearingCache}
            className="px-4 py-2.5 rounded-2xl bg-cat-surface0 hover:bg-cat-red/20 hover:text-cat-red text-cat-subtext0 font-semibold text-xs transition-colors"
          >
            {clearingCache ? t('Clearing...', 'Очистка...') : t('Clear Offline Cache', 'Очистить оффлайн-кеш')}
          </button>
        </section>

        {/* 4.5 Library Backup & Restore */}
        <section className="bg-cat-mantle p-6 rounded-3xl border border-cat-surface0/60 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-cat-blue/20 text-cat-blue">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-base text-cat-text">
                {t('Library Backup & Restore', 'Резервное копирование медиатеки')}
              </h2>
              <p className="text-xs text-cat-subtext0 mt-0.5">
                {t(
                  'Export your likes, playlists, and blacklist to JSON, or restore them anytime',
                  'Экспортируйте ваши лайки, плейлисты и черный список в JSON или восстановите их'
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleExportBackup}
              disabled={exportingBackup}
              className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-text font-semibold text-xs transition-colors cursor-pointer disabled:opacity-50"
            >
              {exportingBackup ? (
                <Loader2 className="w-4 h-4 animate-spin text-cat-mauve" />
              ) : (
                <Download className="w-4 h-4 text-cat-mauve" />
              )}
              <span>{t('Export to JSON', 'Экспорт в JSON')}</span>
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={importingBackup}
              className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-cat-mauve hover:opacity-95 text-cat-base font-bold text-xs transition-all cursor-pointer shadow-md disabled:opacity-50"
            >
              {importingBackup ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              <span>{t('Restore from File', 'Восстановить из файла')}</span>
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleFileSelected}
              className="hidden"
            />
          </div>
        </section>

        {/* 5. Blacklist Management */}
        <section className="bg-cat-mantle p-6 rounded-3xl border border-cat-surface0/60">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 rounded-xl bg-cat-red/20 text-cat-red">
              <Ban className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-base text-cat-text">
                {t('Blacklisted Tracks', 'Черный список треков')}
              </h2>
              <p className="text-xs text-cat-subtext0">
                {t(
                  'Tracks marked "Never Play" are skipped in recommendations',
                  'Песни со статусом «Никогда не включать» пропускаются в рекомендациях'
                )}
              </p>
            </div>
          </div>

          {blacklist.length === 0 ? (
            <p className="text-xs text-cat-subtext0">{t('Blacklist is empty', 'Черный список пуст')}</p>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto pr-1 custom-scrollbar">
              {blacklist.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between p-3 rounded-2xl bg-cat-surface0/50 text-xs"
                >
                  <div>
                    <span className="font-semibold text-cat-text">{item.title}</span>
                    <span className="text-cat-subtext0"> — {item.artist}</span>
                  </div>
                  <button
                    onClick={() => handleRemoveBlacklist(item.id)}
                    className="text-cat-subtext0 hover:text-cat-mauve font-medium px-2 py-1"
                  >
                    {t('Restore', 'Вернуть')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 6. Account Actions: Logout & Delete Account */}
        <section className="bg-cat-mantle p-6 rounded-3xl border border-cat-red/30 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <button
            onClick={logout}
            className="flex items-center justify-center gap-2 px-5 py-3 rounded-2xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-text font-semibold text-xs transition-colors"
          >
            <LogOut className="w-4 h-4" />
            {t('Sign Out', 'Выйти из аккаунта')}
          </button>

          <button
            onClick={() => setShowDeleteModal(true)}
            className="flex items-center justify-center gap-2 px-5 py-3 rounded-2xl bg-cat-red/20 hover:bg-cat-red text-cat-red hover:text-cat-base font-bold text-xs transition-all"
          >
            <Trash2 className="w-4 h-4" />
            {t('Delete Account Permanently', 'Удалить аккаунт навсегда')}
          </button>
        </section>
      </div>

      {/* Floating Scroll to Top Arrow */}
      {showScrollTop && (
        <button
          onClick={scrollToTop}
          title={t('Back to top', 'Наверх')}
          aria-label={t('Scroll to top', 'Прокрутить наверх')}
          className="fixed bottom-36 md:bottom-28 right-5 md:right-8 z-40 p-3.5 rounded-full bg-cat-mauve text-cat-base shadow-2xl hover:scale-110 active:scale-95 transition-all duration-200 cursor-pointer flex items-center justify-center border-2 border-cat-base animate-in fade-in zoom-in-75"
        >
          <ChevronUp className="w-5 h-5 stroke-[2.5]" />
        </button>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 bg-cat-crust/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-cat-mantle border border-cat-red/40 rounded-3xl p-6 max-w-md w-full shadow-2xl">
            <div className="flex items-center gap-3 text-cat-red mb-3">
              <AlertTriangle className="w-6 h-6 flex-shrink-0" />
              <h3 className="font-bold text-lg">{t('Delete Account?', 'Удаление аккаунта')}</h3>
            </div>
            <p className="text-xs text-cat-subtext0 leading-relaxed mb-4">
              {t(
                'Are you sure? All your playlists, liked songs, and exclusive audio files on the server will be permanently deleted. Enter your password to confirm:',
                'Вы уверены? Все ваши плейлисты, лайки и эксклюзивные аудиофайлы на сервере будут безвозвратно удалены. Введите пароль для подтверждения:'
              )}
            </p>
            {deleteError && <p className="text-xs text-cat-red mb-2">{deleteError}</p>}
            <input
              type="password"
              placeholder={t('Your current password', 'Ваш текущий пароль')}
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              className="w-full bg-cat-surface0 border border-cat-surface1/50 rounded-2xl px-4 py-2.5 text-sm text-cat-text mb-4 focus:outline-none focus:border-cat-red"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setShowDeleteModal(false)}
                className="flex-1 py-2.5 rounded-2xl bg-cat-surface0 text-cat-text text-xs font-semibold hover:bg-cat-surface1"
              >
                {t('Cancel', 'Отмена')}
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deleting || !deletePassword}
                className="flex-1 py-2.5 rounded-2xl bg-cat-red text-cat-base text-xs font-bold hover:opacity-90 disabled:opacity-40"
              >
                {deleting ? t('Deleting...', 'Удаление...') : t('Delete', 'Удалить')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
