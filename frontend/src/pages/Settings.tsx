import React, { useState, useEffect } from 'react';
import { 
  User as UserIcon, Lock, Trash2, Ban, HardDrive, Key, 
  LogOut, Check, AlertTriangle, Loader2, Sparkles 
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { apiRequest } from '../api/client';
import { BlacklistItem } from '../types';
import { getOfflineStorageUsage, clearAllOfflineCache } from '../utils/offline';

export const Settings: React.FC = () => {
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

  // Stats State
  const [stats, setStats] = useState({ users: 0, tracks: 0 });

  useEffect(() => {
    loadSettingsData();
  }, []);

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
    } catch (e) {
      console.warn(e);
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
      setTimeout(() => setNameSuccess(false), 3000);
    } catch (e: any) {
      alert(e.message || 'Ошибка обновления имени');
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
      alert(e.message || 'Ошибка удаления аккаунта');
      setDeleting(false);
    }
  };

  const handleUnblock = async (id: number) => {
    try {
      await apiRequest(`/blacklist/${id}`, { method: 'DELETE' });
      setBlacklist(prev => prev.filter(b => b.id !== id));
    } catch (e: any) {
      alert(e.message);
    }
  };

  const handleClearCache = async () => {
    setClearingCache(true);
    await clearAllOfflineCache();
    const size = await getOfflineStorageUsage();
    setCacheSize(size);
    setClearingCache(false);
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
      alert('Ключи Spotify успешно сохранены!');
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSavingCreds(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 pb-28 md:pb-24 select-none custom-scrollbar">
      <h1 className="text-2xl md:text-3xl font-extrabold text-cat-text mb-6">
        Настройки
      </h1>

      <div className="max-w-3xl space-y-6">
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
