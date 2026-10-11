import React, { useState } from 'react';
import { Music2, Loader2, ArrowRight } from 'lucide-react';
import { apiRequest } from '../api/client';
import { useAuthStore } from '../store/authStore';

interface LoginProps {
  onGoToRegister: () => void;
}

export const Login: React.FC<LoginProps> = ({ onGoToRegister }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const { login } = useAuthStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;

    setLoading(true);
    setError('');

    try {
      const data = await apiRequest<{ token: string; user: any }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      login(data.token, data.user);
    } catch (err: any) {
      setError(err.message || 'Ошибка входа');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-cat-base flex items-center justify-center p-4 select-none">
      <div className="w-full max-w-sm bg-cat-mantle rounded-3xl p-8 border border-cat-surface0/60 shadow-2xl">
        {/* Brand Icon */}
        <div className="w-14 h-14 rounded-2xl bg-cat-mauve/20 text-cat-mauve flex items-center justify-center mx-auto mb-4">
          <Music2 className="w-7 h-7" />
        </div>

        <h1 className="text-2xl font-extrabold text-cat-text text-center mb-1">
          Вход в Spotify
        </h1>
        <p className="text-xs text-cat-subtext0 text-center mb-6">
          Введите учетные данные для доступа
        </p>

        {error && (
          <div className="p-3 mb-4 rounded-2xl bg-cat-red/20 border border-cat-red/40 text-cat-red text-xs text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-cat-subtext0 uppercase tracking-wider block mb-1">
              Логин
            </label>
            <input
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve"
              placeholder="username"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-cat-subtext0 uppercase tracking-wider block mb-1">
              Пароль
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-2xl bg-cat-mauve text-cat-base font-bold text-sm hover:opacity-95 active:scale-95 transition-all shadow-md flex items-center justify-center gap-2 disabled:opacity-40"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>Войти</span>}
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-cat-surface0/60 text-center">
          <button
            onClick={onGoToRegister}
            className="text-xs text-cat-subtext0 hover:text-cat-mauve inline-flex items-center gap-1 transition-colors"
          >
            Создать новый аккаунт <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
};
