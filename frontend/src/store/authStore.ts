import { create } from 'zustand';
import { User } from '../types';
import { apiRequest, setToken, getToken } from '../api/client';
import { useI18nStore, tr } from './i18nStore';

const CACHED_USER_KEY = 'jellyfy_cached_user';

function getCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(CACHED_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setCachedUser(user: User | null) {
  try {
    if (user) {
      localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(CACHED_USER_KEY);
    }
  } catch {}
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (token: string, user: User) => void;
  logout: () => void;
  updateDisplayName: (displayName: string) => void;
  fetchMe: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => {
  const cachedUser = getCachedUser();
  const token = getToken();

  return {
    user: cachedUser,
    isAuthenticated: Boolean(token),
    isLoading: Boolean(token && !cachedUser),

    login: (token, user) => {
      setToken(token);
      setCachedUser(user);
      useI18nStore.getState().initFirstLoginLang(user?.id);
      set({ user, isAuthenticated: true, isLoading: false });
    },

    logout: () => {
      setToken(null);
      setCachedUser(null);
      set({ user: null, isAuthenticated: false, isLoading: false });
    },

    updateDisplayName: (displayName) => {
      set((state) => {
        const nextUser = state.user ? { ...state.user, display_name: displayName } : null;
        setCachedUser(nextUser);
        return { user: nextUser };
      });
    },

    fetchMe: async () => {
      const currentToken = getToken();
      if (!currentToken) {
        set({ isLoading: false, isAuthenticated: false, user: null });
        return;
      }

      try {
        const data = await apiRequest<{ user: User }>('/auth/me');
        setCachedUser(data.user);
        set({ user: data.user, isAuthenticated: true, isLoading: false });
      } catch (err: any) {
        // Only log out if the backend explicitly rejected the token (HTTP 401)
        if (err?.status === 401 || err?.message?.includes('Сессия истекла') || err?.message?.includes('Session expired')) {
          setToken(null);
          setCachedUser(null);
          set({ user: null, isAuthenticated: false, isLoading: false });
        } else {
          // Network error / offline mode: preserve the active session using the cached user profile
          console.warn('[Auth] Server unreachable or offline, continuing with cached session');
          const fallbackUser =
            getCachedUser() ||
            ({ id: 0, username: 'offline', display_name: tr('User (Offline)', 'Пользователь (Офлайн)') } as User);
          set({ user: fallbackUser, isAuthenticated: true, isLoading: false });
        }
      }
    },
  };
});
