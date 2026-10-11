import React, { useState } from 'react';
import { Music2, Loader2, ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { apiRequest } from '../api/client';
import { useAuthStore } from '../store/authStore';

interface RegisterProps {
  onGoToLogin: () => void;
}

export const Register: React.FC<RegisterProps> = ({ onGoToLogin }) => {
  const [emailOrUser, setEmailOrUser] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const { login } = useAuthStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailOrUser || !password) return;

    if (password !== confirmPassword) {
      setError('Пароли не совпадают. Пожалуйста, проверьте ввод.');
      return;
    }

    if (password.length < 4) {
      setError('Пароль должен содержать минимум 4 символа.');
      return;
    }

    setLoading(true);
    setError('');

    const cleanInput = emailOrUser.trim();
    const isEmail = cleanInput.includes('@');

    try {
      const data = await apiRequest<{ token: string; user: any }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ 
          username: cleanInput, 
          email: isEmail ? cleanInput : undefined,
          password,
          confirm_password: confirmPassword,
          display_name: displayName || (isEmail ? cleanInput.split('@')[0] : cleanInput),
        })
      });
      login(data.token, data.user);
    } catch (err: any) {
      setError(err.message || 'Ошибка регистрации');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-cat-base flex items-center justify-center p-4 select-none">
      <div className="w-full max-w-sm bg-cat-mantle rounded-3xl p-8 border border-cat-surface0/60 shadow-2xl">
        <div className="w-14 h-14 rounded-2xl bg-cat-mauve/20 text-cat-mauve flex items-center justify-center mx-auto mb-4">
          <Music2 className="w-7 h-7" />
        </div>

        <h1 className="text-2xl font-extrabold text-cat-text text-center mb-1">
          Регистрация
        </h1>
        <p className="text-xs text-cat-subtext0 text-center mb-6">
          Создание личного профиля в Jellyfy
        </p>

        {error && (
          <div className="p-3 mb-4 rounded-2xl bg-cat-red/20 border border-cat-red/40 text-cat-red text-xs text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div>
            <label className="text-xs font-semibold text-cat-subtext0 uppercase tracking-wider block mb-1">
              Email / Логин
            </label>
            <input
              type="text"
              required
              value={emailOrUser}
              onChange={(e) => setEmailOrUser(e.target.value)}
              className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve"
              placeholder="user@example.com"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-cat-subtext0 uppercase tracking-wider block mb-1">
              Имя / Никнейм
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl px-4 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve"
              placeholder="Как к вам обращаться"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-cat-subtext0 uppercase tracking-wider block mb-1">
              Пароль
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
                title={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-cat-subtext0 uppercase tracking-wider block mb-1">
              Повторите пароль
            </label>
            <div className="relative">
              <input
                type={showConfirmPassword ? 'text' : 'password'}
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full bg-cat-surface0 border border-cat-surface1/40 rounded-2xl pl-4 pr-11 py-2.5 text-sm text-cat-text focus:outline-none focus:border-cat-mauve"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-cat-subtext0 hover:text-cat-text transition-colors"
                title={showConfirmPassword ? 'Скрыть пароль' : 'Показать пароль'}
              >
                {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-2xl bg-cat-mauve text-cat-base font-bold text-sm hover:opacity-95 active:scale-95 transition-all shadow-md flex items-center justify-center gap-2 disabled:opacity-40 mt-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>Зарегистрироваться</span>}
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-cat-surface0/60 text-center">
          <button
            onClick={onGoToLogin}
            className="text-xs text-cat-subtext0 hover:text-cat-mauve inline-flex items-center gap-1 transition-colors"
          >
            <ArrowLeft className="w-3 h-3" /> Уже есть аккаунт? Войти
          </button>
        </div>
      </div>
    </div>
  );
};
