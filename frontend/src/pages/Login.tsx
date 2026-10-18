import React, { useState } from 'react';
import { Music2, Loader2, ArrowRight, Eye, EyeOff, Globe } from 'lucide-react';
import { apiRequest } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { useI18nStore } from '../store/i18nStore';

interface LoginProps {
  onGoToRegister: () => void;
}

export const Login: React.FC<LoginProps> = ({ onGoToRegister }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const { login } = useAuthStore();
  const { lang, setLang, t } = useI18nStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;

    setLoading(true);
    setError('');

    try {
      const data = await apiRequest<{ token: string; user: any }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: username.trim(), password })
      });
      login(data.token, data.user);
    } catch (err: any) {
      setError(err.message || t('Sign in failed', 'Ошибка входа'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-cat-base flex items-center justify-center p-4 select-none">
      <div className="relative w-full max-w-sm bg-cat-mantle rounded-3xl p-8 border border-cat-surface0/60 shadow-2xl">
        {/* Language Switcher Pill */}
        <div className="absolute top-4 right-4 flex items-center bg-cat-surface0/80 p-0.5 rounded-xl border border-cat-surface1/40 text-[11px] font-bold">
          <button
            type="button"
            onClick={() => setLang('en')}
            className={`px-2 py-1 rounded-lg transition-all cursor-pointer ${
              lang === 'en' ? 'bg-cat-mauve text-cat-base' : 'text-cat-subtext0 hover:text-cat-text'
            }`}
          >
            EN
          </button>
          <button
            type="button"
            onClick={() => setLang('ru')}
            className={`px-2 py-1 rounded-lg transition-all cursor-pointer ${
              lang === 'ru' ? 'bg-cat-mauve text-cat-base' : 'text-cat-subtext0 hover:text-cat-text'
            }`}
          >
            RU
          </button>
        </div>

        {/* Brand Icon */}
        <div className="w-14 h-14 rounded-2xl bg-cat-mauve/20 text-cat-mauve flex items-center justify-center mx-auto mb-4">
          <Music2 className="w-7 h-7" />
        </div>

        <h1 className="text-2xl font-extrabold text-cat-text text-center mb-1">
          {t('Sign in to Jellyfy', 'Вход в Jellyfy')}
        </h1>
        <p className="text-xs text-cat-subtext0 text-center mb-6">
          {t('Enter your credentials to access your library', 'Введите учетные данные для доступа')}
        </p>

        {error && (
          <div className="p-3 mb-4 rounded-2xl bg-cat-red/20 border border-cat-red/40 text-cat-red text-xs text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-cat-subtext0 uppercase tracking-wider block mb-1">
              {t('Email / Username', 'Email / Логин')}
            </label>
            <input
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve"
              placeholder={t('user@example.com or username', 'user@example.com или логин')}
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-cat-subtext0 uppercase tracking-wider block mb-1">
              {t('Password', 'Пароль')}
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl pl-4 pr-11 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-cat-subtext0 hover:text-cat-text transition-colors"
                title={showPassword ? t('Hide password', 'Скрыть пароль') : t('Show password', 'Показать пароль')}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-2xl bg-cat-mauve text-cat-base font-bold text-sm hover:opacity-95 active:scale-95 transition-all shadow-md flex items-center justify-center gap-2 disabled:opacity-40"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>{t('Sign In', 'Войти')}</span>}
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-cat-surface0/60 text-center">
          <button
            onClick={onGoToRegister}
            className="text-xs text-cat-subtext0 hover:text-cat-mauve inline-flex items-center gap-1 transition-colors"
          >
            {t('Create a new account', 'Создать новый аккаунт')} <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
};
