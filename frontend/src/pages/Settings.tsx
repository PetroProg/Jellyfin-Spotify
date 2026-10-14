import React, { useState, useEffect } from 'react';
import { 
  User as UserIcon, Lock, Trash2, Ban, HardDrive, Key, 
  LogOut, Check, AlertTriangle, Loader2, Sparkles, ArrowLeft,
  Copy, ExternalLink, Heart, ShieldCheck, Unlink
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { apiRequest } from '../api/client';
import { BlacklistItem } from '../types';
import { getOfflineStorageUsage, clearAllOfflineCache } from '../utils/offline';
import { toast, confirmDialog } from '../store/toastStore';

interface SettingsProps {
  onBack?: () => void;
}

export const Settings: React.FC<SettingsProps> = ({ onBack }) => {
  const { user, updateDisplayName, logout } = useAuthStore();

  // Profile State
  const [displayName, setDisplayName] = useState(user?.display_name || '');
  const [savingName, setSavingName] = useState(false);
  const [nameSuccess, setNameSuccess] = useState(false);

  // Password State
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState<{ text: string; error?: boolean } | null>(null);

  // Delete Account State
  const [deletePassword, setDeletePassword] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Blacklist State
  const [blacklist, setBlacklist] = useState<BlacklistItem[]>([]);
  const [loadingBlacklist, setLoadingBlacklist] = useState(true);

  // Cache State
  const [cacheSize, setCacheSize] = useState('0 МБ');
  const [clearingCache, setClearingCache] = useState(false);

  // Spotify Credentials State
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [hasSpotifyCreds, setHasSpotifyCreds] = useState(false);
  const [savingCreds, setSavingCreds] = useState(false);

  // Spotify OAuth State
  const [spotifyAuthInfo, setSpotifyAuthInfo] = useState<{
    configured: boolean;
    authUrl?: string;
    redirectUri?: string;
    isConnected: boolean;
    spotifyDisplayName?: string;
    error?: string;
  } | null>(null);
  const [syncingLiked, setSyncingLiked] = useState(false);
  const [syncLikedMsg, setSyncLikedMsg] = useState<string | null>(null);
  const [copiedRedirect, setCopiedRedirect] = useState(false);

  // Stats State
  const [stats, setStats] = useState({ users: 0, tracks: 0 });

  // Audio Quality Upgrade State
  const [upgradeStatus, setUpgradeStatus] = useState<{
    isRunning: boolean;
    total: number;
    current: number;
    currentTrack: string;
    successCount: number;
    upgradedCount?: number;
    skippedCount?: number;
    errorCount: number;
  }>({
    isRunning: false,
    total: 0,
    current: 0,
    currentTrack: '',
    successCount: 0,
    upgradedCount: 0,
    skippedCount: 0,
    errorCount: 0
  });
  const [startingUpgrade, setStartingUpgrade] = useState(false);
  const [upgradeMsg, setUpgradeMsg] = useState<string | null>(null);

  useEffect(() => {
    loadSettingsData();

    // Check for Spotify OAuth query params
    const params = new URLSearchParams(window.location.search);
    if (params.get('spotify_connected')) {
      toast.success('Аккаунт Spotify успешно подключен! Лимит на 100 треков снят.', 'Spotify подключен');
      window.history.replaceState({}, document.title, '/');
    }
    if (params.get('spotify_error')) {
      toast.error('Ошибка подключения Spotify: ' + params.get('spotify_error'), 'Ошибка Spotify');
      window.history.replaceState({}, document.title, '/');
    }
  }, []);

  useEffect(() => {
    let interval: any = null;
    if (upgradeStatus.isRunning) {
      interval = setInterval(async () => {
        try {
          const upData = await apiRequest<any>('/tracks/upgrade-quality/status');
          if (upData) {
            setUpgradeStatus(upData);
            if (!upData.isRunning) {
              clearInterval(interval);
            }
          }
        } catch (_) {}
      }, 2000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [upgradeStatus.isRunning]);

  const loadSettingsData = async () => {
    try {
      // 1. Blacklist
      const blData = await apiRequest<{ blacklist: BlacklistItem[] }>('/blacklist');
      setBlacklist(blData.blacklist || []);
      setLoadingBlacklist(false);

      // 2. Storage
      const size = await getOfflineStorageUsage();
      setCacheSize(size);

      // 3. Settings & Stats
      const stData = await apiRequest<any>('/settings');
      setHasSpotifyCreds(stData.hasSpotifyCredentials);
      setStats(stData.stats || { users: 0, tracks: 0 });

      // 4. Quality Upgrade Status
      try {
        const upData = await apiRequest<any>('/tracks/upgrade-quality/status');
        if (upData) setUpgradeStatus(upData);
      } catch (_) {}

      // 5. Spotify OAuth Info
      try {
        const sAuth = await apiRequest<any>('/spotify/auth-url');
        setSpotifyAuthInfo(sAuth);
      } catch (_) {}
    } catch (e) {
      console.warn(e);
    }
  };

  const handleStartUpgrade = async () => {
    const ok = await confirmDialog({
      title: 'Умное обновление качества медиатеки',
      message: 'Система проверит битрейт и полную длительность каждого трека. Песни, уже скачанные в отличном качестве (320 kbps), будут пропущены. Будут перезагружены только обрезанные треки и треки низкого качества.',
      confirmText: 'Запустить умное обновление',
      cancelText: 'Отмена'
    });
    if (!ok) return;

    setStartingUpgrade(true);
    setUpgradeMsg(null);
    try {
      const res = await apiRequest<any>('/tracks/upgrade-quality', { method: 'POST' });
      setUpgradeMsg(res.message || 'Обновление запущено!');
      toast.success(res.message || 'Обновление качества запущено!');
      const upData = await apiRequest<any>('/tracks/upgrade-quality/status');
      if (upData) setUpgradeStatus(upData);
    } catch (e: any) {
      toast.error(e.message || 'Ошибка запуска обновления качества');
    } finally {
      setStartingUpgrade(false);
    }
  };

  const handleUpdateName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    setSavingName(true);
    setNameSuccess(false);
    try {
      await apiRequest('/auth/profile', {
        method: 'PUT',
        body: JSON.stringify({ display_name: displayName })
      });
      updateDisplayName(displayName);
      setNameSuccess(true);
      toast.success('Имя профиля успешно сохранено');
      setTimeout(() => setNameSuccess(false), 3000);
    } catch (e: any) {
      toast.error(e.message || 'Ошибка обновления имени');
    } finally {
      setSavingName(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPassword || !newPassword) return;
    setSavingPassword(true);
    setPasswordMsg(null);
    try {
      await apiRequest('/auth/password', {
        method: 'PUT',
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
      });
      setPasswordMsg({ text: 'Пароль успешно изменен' });
      setCurrentPassword('');
      setNewPassword('');
    } catch (e: any) {
      setPasswordMsg({ text: e.message || 'Ошибка смены пароля', error: true });
    } finally {
      setSavingPassword(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!deletePassword) return;
    setDeleting(true);
    try {
      await apiRequest('/auth/account', {
        method: 'DELETE',
        body: JSON.stringify({ password: deletePassword })
      });
      logout();
      window.location.href = '/login';
    } catch (e: any) {
      toast.error(e.message || 'Ошибка удаления аккаунта');
      setDeleting(false);
    }
  };

  const handleUnblock = async (id: number) => {
    try {
      await apiRequest(`/blacklist/${id}`, { method: 'DELETE' });
      setBlacklist(prev => prev.filter(b => b.id !== id));
      toast.success('Трек удален из черного списка');
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleClearCache = async () => {
    setClearingCache(true);
    await clearAllOfflineCache();
    const size = await getOfflineStorageUsage();
    setCacheSize(size);
    setClearingCache(false);
    toast.success('Кэш приложения успешно очищен');
  };

  const handleSaveSpotifyKeys = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingCreds(true);
    try {
      await apiRequest('/settings', {
        method: 'POST',
        body: JSON.stringify({ clientId, clientSecret })
      });
      setHasSpotifyCreds(true);
      setClientId('');
      setClientSecret('');
      toast.success('Ключи Spotify успешно сохранены!');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSavingCreds(false);
    }
  };

  const handleDisconnectSpotify = async () => {
    const ok = await confirmDialog({
      title: 'Отключение Spotify',
      message: 'Отключить связанный аккаунт Spotify? Доступ к вашим приватным плейлистам и синхронизации лайков будет приостановлен.',
      confirmText: 'Отключить',
      cancelText: 'Отмена',
      isDestructive: true
    });
    if (!ok) return;

    try {
      await apiRequest('/spotify/disconnect', { method: 'POST' });
      await loadSettingsData();
      toast.info('Аккаунт Spotify отключен');
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleSyncLiked = async () => {
    setSyncingLiked(true);
    setSyncLikedMsg(null);
    try {
      const res = await apiRequest<any>('/spotify/import-liked', { method: 'POST' });
      setSyncLikedMsg(res.message || 'Синхронизация любимых треков начата!');
      toast.success(res.message || 'Синхронизация любимых треков начата!');
    } catch (e: any) {
      toast.error(e.message || 'Ошибка синхронизации любимых треков');
    } finally {
      setSyncingLiked(false);
    }
  };

  const handleCopyRedirect = () => {
    if (spotifyAuthInfo?.redirectUri) {
      navigator.clipboard.writeText(spotifyAuthInfo.redirectUri);
      setCopiedRedirect(true);
      setTimeout(() => setCopiedRedirect(false), 2500);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 pb-28 md:pb-24 select-none custom-scrollbar">
      <div className="max-w-3xl mx-auto space-y-6">
        {onBack && (
          <button
            onClick={onBack}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-cat-surface0/80 hover:bg-cat-surface1 border border-cat-surface1/50 text-sm font-semibold text-cat-subtext0 hover:text-cat-text transition-all duration-200 mb-2 cursor-pointer active:scale-95 group shadow-sm w-fit"
            title="Вернуться назад"
          >
            <ArrowLeft className="w-4 h-4 text-cat-mauve transition-transform group-hover:-translate-x-1" />
            <span>Назад</span>
          </button>
        )}

        <h1 className="text-2xl md:text-3xl font-extrabold text-cat-text">
          Настройки
        </h1>

        {/* Section 1: Blacklist Management */}
        <div className="bg-cat-mantle rounded-3xl p-5 md:p-6 border border-cat-surface0/60 shadow-lg">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-cat-red/20 text-cat-red flex items-center justify-center">
              <Ban className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-cat-text">Черный список («Никогда не включать»)</h2>
              <p className="text-xs text-cat-subtext0">Заблокированные треки исключены из авто-радио и умных рекомендаций</p>
            </div>
          </div>

          {loadingBlacklist ? (
            <p className="text-xs text-cat-subtext0 py-3">Загрузка черного списка...</p>
          ) : blacklist.length === 0 ? (
            <p className="text-xs text-cat-subtext0 py-3">Черный список пуст. Вы не заблокировали ни одного трека.</p>
          ) : (
            <div className="space-y-2 mt-3 max-h-56 overflow-y-auto custom-scrollbar pr-1">
              {blacklist.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between p-3 rounded-2xl bg-cat-surface0/60 border border-cat-surface1/30"
                >
                  <div className="min-w-0 flex-1 pr-3">
                    <p className="text-sm font-semibold text-cat-text truncate">{item.title}</p>
                    <p className="text-xs text-cat-subtext0 truncate">{item.artist}</p>
                  </div>
                  <button
                    onClick={() => handleUnblock(item.id)}
                    className="px-3 py-1.5 rounded-xl bg-cat-surface1 text-xs font-semibold text-cat-text hover:bg-cat-mauve hover:text-cat-base transition-all"
                  >
                    Разблокировать
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Section 2: Profile Settings */}
        <div className="bg-cat-mantle rounded-3xl p-5 md:p-6 border border-cat-surface0/60 shadow-lg">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-cat-mauve/20 text-cat-mauve flex items-center justify-center">
              <UserIcon className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-cat-text">Профиль и аккаунт</h2>
              <p className="text-xs text-cat-subtext0">Логин: @{user?.username}</p>
            </div>
          </div>

          <form onSubmit={handleUpdateName} className="space-y-3 mb-6">
            <label className="text-xs font-semibold text-cat-subtext0 uppercase tracking-wider block">
              Имя / Никнейм
            </label>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="flex-1 min-w-0 w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve transition-colors"
                placeholder="Ваше имя"
              />
              <button
                type="submit"
                disabled={savingName}
                className="w-full sm:w-auto px-5 py-2.5 rounded-2xl bg-cat-mauve text-cat-base text-sm font-bold hover:opacity-95 active:scale-95 transition-all shadow-md flex items-center justify-center gap-2 shrink-0"
              >
                {savingName ? <Loader2 className="w-4 h-4 animate-spin" /> : nameSuccess ? <Check className="w-4 h-4" /> : null}
                Сохранить
              </button>
            </div>
          </form>

          {/* Change Password Form */}
          <form onSubmit={handleChangePassword} className="space-y-3 pt-4 border-t border-cat-surface0/60">
            <label className="text-xs font-semibold text-cat-subtext0 uppercase tracking-wider block">
              Смена пароля
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="password"
                placeholder="Текущий пароль"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve transition-colors"
              />
              <input
                type="password"
                placeholder="Новый пароль"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve transition-colors"
              />
            </div>
            {passwordMsg && (
              <p className={`text-xs ${passwordMsg.error ? 'text-cat-red' : 'text-cat-green'}`}>
                {passwordMsg.text}
              </p>
            )}
            <button
              type="submit"
              disabled={savingPassword || !currentPassword || !newPassword}
              className="px-5 py-2.5 rounded-2xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-text text-sm font-semibold transition-all active:scale-95 disabled:opacity-40"
            >
              Обновить пароль
            </button>
          </form>

          {/* Delete Account */}
          <div className="pt-6 mt-6 border-t border-cat-surface0/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-cat-red">Удаление профиля</p>
              <p className="text-xs text-cat-subtext0">Удаляет ваши плейлисты и историю прослушивания</p>
            </div>
            <button
              onClick={() => setShowDeleteModal(true)}
              className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-cat-red/20 text-cat-red hover:bg-cat-red hover:text-cat-base text-xs font-bold transition-all shrink-0 self-start sm:self-auto"
            >
              <Trash2 className="w-4 h-4" />
              Удалить аккаунт
            </button>
          </div>
        </div>

        {/* Section 3: Offline Storage */}
        <div className="bg-cat-mantle rounded-3xl p-5 md:p-6 border border-cat-surface0/60 shadow-lg">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-cat-peach/20 text-cat-peach flex items-center justify-center">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-cat-text">Оффлайн-хранилище (Кеш на устройстве)</h2>
              <p className="text-xs text-cat-subtext0">Занято скачанной музыкой: <span className="text-cat-peach font-bold">{cacheSize}</span></p>
            </div>
          </div>
          <button
            onClick={handleClearCache}
            disabled={clearingCache}
            className="px-4 py-2 rounded-xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-text text-xs font-semibold transition-all active:scale-95"
          >
            {clearingCache ? 'Очистка...' : 'Очистить оффлайн-кеш'}
          </button>
        </div>

        {/* Section: Studio Audio Quality & Hi-Fi Re-download */}
        <div className="bg-cat-mantle rounded-3xl p-5 md:p-6 border border-cat-surface0/60 shadow-lg">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-cat-mauve/20 text-cat-mauve flex items-center justify-center shrink-0">
                <Sparkles className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-cat-text">Студийное качество звука (320 kbps)</h2>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase bg-cat-green/20 text-cat-green border border-cat-green/30">
                    Hi-Fi Master
                  </span>
                </div>
                <p className="text-xs text-cat-subtext0">
                  Поиск студийных релизов без интро/клиповых эффектов, прямое кодирование 320 kbps MP3 LAME
                </p>
              </div>
            </div>
          </div>

          <div className="bg-cat-surface0/50 rounded-2xl p-4 border border-cat-surface1/30 space-y-3 mb-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div className="p-2.5 rounded-xl bg-cat-surface1/40">
                <span className="font-semibold text-cat-text block mb-0.5">Уровень 1: Источники</span>
                <span className="text-cat-subtext0">Фильтрация клипов и точное совпадение длительности (±2 сек)</span>
              </div>
              <div className="p-2.5 rounded-xl bg-cat-surface1/40">
                <span className="font-semibold text-cat-text block mb-0.5">Уровень 2: 320 kbps</span>
                <span className="text-cat-subtext0">LAME 320k CBR 44.1kHz + обложки Deezer Hi-Res</span>
              </div>
              <div className="p-2.5 rounded-xl bg-cat-surface1/40">
                <span className="font-semibold text-cat-text block mb-0.5">Уровень 3: Web Audio</span>
                <span className="text-cat-subtext0">5-полосный графический эквалайзер и нормализация громкости</span>
              </div>
            </div>

            {upgradeStatus.isRunning ? (
              <div className="space-y-2.5 pt-2">
                <div className="flex items-center justify-between text-xs font-semibold">
                  <span className="text-cat-mauve flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Проверка и выборочная перезагрузка (320 kbps)...
                  </span>
                  <span className="text-cat-subtext0 font-mono">
                    {upgradeStatus.current} / {upgradeStatus.total} ({upgradeStatus.total > 0 ? Math.round((upgradeStatus.current / upgradeStatus.total) * 100) : 0}%)
                  </span>
                </div>

                <div className="w-full h-2.5 bg-cat-surface1 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-cat-mauve to-cat-pink transition-all duration-300 rounded-full"
                    style={{
                      width: `${upgradeStatus.total > 0 ? (upgradeStatus.current / upgradeStatus.total) * 100 : 0}%`
                    }}
                  />
                </div>

                {upgradeStatus.currentTrack && (
                  <p className="text-[11px] text-cat-subtext0 truncate font-mono">
                    Сейчас: <span className="text-cat-text">{upgradeStatus.currentTrack}</span>
                  </p>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                  <span className="text-cat-green">Уже в 320k (пропущено): {upgradeStatus.skippedCount || 0}</span>
                  <span className="text-cat-peach">Перезагружено: {upgradeStatus.upgradedCount || 0}</span>
                  {upgradeStatus.errorCount > 0 && <span className="text-cat-red">Ошибок: {upgradeStatus.errorCount}</span>}
                </div>
              </div>
            ) : (
              upgradeStatus.total > 0 && upgradeStatus.current >= upgradeStatus.total && (
                <div className="space-y-1 text-xs text-cat-green font-medium pt-1">
                  <div className="flex items-center gap-2">
                    <Check className="w-4 h-4" />
                    <span>Все {upgradeStatus.total} треков проверены!</span>
                  </div>
                  <div className="text-[11px] text-cat-subtext0 pl-6 space-y-0.5">
                    <p>• Уже были в высоком качестве (320 kbps): <span className="text-cat-green font-semibold">{upgradeStatus.skippedCount || 0}</span></p>
                    <p>• Перезагружено в высоком качестве: <span className="text-cat-peach font-semibold">{upgradeStatus.upgradedCount || 0}</span></p>
                    {upgradeStatus.errorCount > 0 && (
                      <p>• Ошибок: <span className="text-cat-red font-semibold">{upgradeStatus.errorCount}</span></p>
                    )}
                  </div>
                </div>
              )
            )}
          </div>

          <button
            onClick={handleStartUpgrade}
            disabled={startingUpgrade || upgradeStatus.isRunning}
            className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-2xl bg-cat-mauve text-cat-base text-xs font-bold hover:opacity-95 active:scale-95 transition-all shadow-md disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
          >
            {startingUpgrade || upgradeStatus.isRunning ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Проверка и обновление...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>Перезагрузить треки низкого качества (320 kbps)</span>
              </>
            )}
          </button>
          {upgradeMsg && (
            <p className="text-xs text-cat-green mt-2">{upgradeMsg}</p>
          )}
        </div>

        {/* Section 4: Spotify API Keys */}
        <div className="bg-cat-mantle rounded-3xl p-5 md:p-6 border border-cat-surface0/60 shadow-lg">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-cat-green/20 text-cat-green flex items-center justify-center">
              <Key className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-cat-text">Ключи Spotify Developer API</h2>
              <p className="text-xs text-cat-subtext0">
                {hasSpotifyCreds
                  ? '✅ Ключи настроены: рекомендации работают на максимальной точности'
                  : '⚠️ Ключи не настроены: импорт работает через embed-парсер'}
              </p>
            </div>
          </div>

          <form onSubmit={handleSaveSpotifyKeys} className="space-y-3">
            <input
              type="text"
              placeholder="Spotify Client ID"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve"
            />
            <input
              type="password"
              placeholder="Spotify Client Secret"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve"
            />
            <button
              type="submit"
              disabled={savingCreds || (!clientId && !clientSecret)}
              className="px-5 py-2.5 rounded-2xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-text text-xs font-bold transition-all disabled:opacity-40"
            >
              {savingCreds ? 'Сохранение...' : 'Сохранить ключи'}
            </button>
          </form>
        </div>

        {/* Section 5: Spotify Account Connection (OAuth) */}
        <div className="bg-cat-mantle rounded-3xl p-5 md:p-6 border border-cat-surface0/60 shadow-lg">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-cat-green/20 text-cat-green flex items-center justify-center">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-cat-text">Подключение аккаунта Spotify</h2>
                {spotifyAuthInfo?.isConnected ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-cat-green/20 text-cat-green border border-cat-green/30">
                    Аккаунт привязан
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-cat-yellow/20 text-cat-yellow border border-cat-yellow/30">
                    Не подключен
                  </span>
                )}
              </div>
              <p className="text-xs text-cat-subtext0">
                Снимает ограничение в 100 треков и позволяет импортировать «Любимые треки» (Liked Songs)
              </p>
            </div>
          </div>

          {spotifyAuthInfo?.isConnected ? (
            <div className="space-y-4">
              <div className="p-3.5 rounded-2xl bg-cat-surface0/60 border border-cat-surface1/30 flex items-center justify-between">
                <div>
                  <p className="text-xs text-cat-subtext0">Подключенный профиль Spotify:</p>
                  <p className="text-sm font-bold text-cat-text">{spotifyAuthInfo.spotifyDisplayName || 'Spotify User'}</p>
                </div>
                <button
                  onClick={handleDisconnectSpotify}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cat-red/20 text-cat-red hover:bg-cat-red hover:text-cat-base text-xs font-semibold transition-all active:scale-95 cursor-pointer"
                >
                  <Unlink className="w-3.5 h-3.5" />
                  <span>Отключить</span>
                </button>
              </div>

              <div className="p-4 rounded-2xl bg-cat-surface0/40 border border-cat-surface1/30 space-y-2.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-cat-text">
                  <Heart className="w-4 h-4 text-cat-red fill-cat-red" />
                  <span>Синхронизация раздела «Любимые треки»</span>
                </div>
                <p className="text-xs text-cat-subtext0">
                  Автоматически скачает все треки с лайком из вашего аккаунта Spotify в медиатеку в качестве 320 kbps.
                </p>
                <button
                  onClick={handleSyncLiked}
                  disabled={syncingLiked}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-cat-mauve text-cat-base text-xs font-bold hover:opacity-95 active:scale-95 transition-all shadow-md disabled:opacity-50 cursor-pointer"
                >
                  {syncingLiked ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Синхронизация...</span>
                    </>
                  ) : (
                    <>
                      <Heart className="w-4 h-4 fill-cat-base" />
                      <span>Синхронизировать «Любимые треки»</span>
                    </>
                  )}
                </button>
                {syncLikedMsg && (
                  <p className="text-xs text-cat-green font-medium pt-1">{syncLikedMsg}</p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-cat-subtext0 leading-relaxed">
                По умолчанию Spotify ограничивает гостевой просмотр плейлистов первыми 100 треками. Вход через ваш аккаунт Spotify даёт доступ к полной пагинации (до 10 000 треков) и личным коллекциям.
              </p>

              {spotifyAuthInfo?.authUrl ? (
                <div className="space-y-3">
                  <a
                    href={spotifyAuthInfo.authUrl}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#1DB954] hover:bg-[#1ed760] text-black font-extrabold text-xs transition-all shadow-lg active:scale-95"
                  >
                    <ExternalLink className="w-4 h-4" />
                    <span>Войти через Spotify (Снять лимиты)</span>
                  </a>

                  {spotifyAuthInfo.redirectUri && (
                    <div className="p-3.5 rounded-2xl bg-cat-surface0/60 border border-cat-surface1/30 space-y-2 text-xs">
                      <div className="flex items-center justify-between text-cat-subtext0">
                        <span className="font-semibold text-cat-text">Redirect URI для Spotify Dashboard:</span>
                        <button
                          type="button"
                          onClick={handleCopyRedirect}
                          className="flex items-center gap-1 text-cat-mauve hover:underline font-semibold cursor-pointer"
                        >
                          <Copy className="w-3.5 h-3.5" />
                          <span>{copiedRedirect ? 'Скопировано!' : 'Копировать'}</span>
                        </button>
                      </div>
                      <code className="block bg-cat-mantle px-2.5 py-1.5 rounded-xl font-mono text-[11px] text-cat-text break-all select-all">
                        {spotifyAuthInfo.redirectUri}
                      </code>
                      <div className="pt-2 border-t border-cat-surface1/30 text-[11px] text-cat-subtext0 space-y-1">
                        <p className="text-cat-peach font-bold">⚠️ Если вы видите ошибку «redirect_uri: Not matching configuration»:</p>
                        <ol className="list-decimal list-inside space-y-0.5 text-[11px] text-cat-subtext0">
                          <li>
                            Перейдите в{' '}
                            <a
                              href="https://developer.spotify.com/dashboard"
                              target="_blank"
                              rel="noreferrer"
                              className="text-cat-mauve underline font-semibold"
                            >
                              Spotify Developer Dashboard
                            </a>{' '}
                            и откройте ваше созданное приложение.
                          </li>
                          <li>Нажмите кнопку <b>Settings</b> (вверху справа).</li>
                          <li>В блоке <b>Redirect URIs</b> нажмите <b>Add</b> и вставьте скопированную ссылку выше.</li>
                          <li>Прокрутите страницу в самый низ и нажмите зеленую кнопку <b>Save</b>!</li>
                        </ol>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-cat-yellow">
                  {spotifyAuthInfo?.error || 'Сначала сохраните Client ID и Client Secret выше для включения входа через Spotify'}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Section 6: Logout */}
        <div className="pt-2">
          <button
            onClick={() => {
              logout();
              window.location.href = '/login';
            }}
            className="flex items-center gap-2 px-5 py-3 rounded-2xl bg-cat-surface0 text-cat-subtext0 hover:text-cat-red hover:bg-cat-surface1 text-sm font-semibold transition-all w-full justify-center"
          >
            <LogOut className="w-4 h-4" />
            Выйти из аккаунта
          </button>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 bg-cat-crust/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-cat-mantle border border-cat-red/40 rounded-3xl p-6 max-w-sm w-full shadow-2xl">
            <div className="flex items-center gap-3 text-cat-red mb-3">
              <AlertTriangle className="w-6 h-6" />
              <h3 className="font-bold text-base">Подтвердите удаление</h3>
            </div>
            <p className="text-xs text-cat-subtext0 mb-4">
              Это действие необратимо. Введите ваш текущий пароль для подтверждения удаления профиля.
            </p>
            <input
              type="password"
              placeholder="Введите пароль"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              className="w-full bg-cat-surface0 border border-cat-surface1/50 rounded-2xl px-4 py-2.5 text-sm text-cat-text mb-4 focus:outline-none focus:border-cat-red"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setShowDeleteModal(false)}
                className="flex-1 py-2.5 rounded-2xl bg-cat-surface0 text-cat-text text-xs font-semibold hover:bg-cat-surface1"
              >
                Отмена
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deleting || !deletePassword}
                className="flex-1 py-2.5 rounded-2xl bg-cat-red text-cat-base text-xs font-bold hover:opacity-90 disabled:opacity-40"
              >
                {deleting ? 'Удаление...' : 'Удалить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
