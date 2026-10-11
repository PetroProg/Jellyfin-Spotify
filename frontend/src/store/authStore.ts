import { create } from 'zustand';
import { User } from '../types';
import { apiRequest, setToken, getToken } from '../api/client';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (token: string, user: User) => void;
  logout: () => void;
  updateDisplayName: (displayName: string) => void;
  fetchMe: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: Boolean(getToken()),
  isLoading: true,

  login: (token, user) => {
    setToken(token);
    set({ user, isAuthenticated: true, isLoading: false });
  },

  logout: () => {
    setToken(null);
    set({ user: null, isAuthenticated: false, isLoading: false });
  },

  updateDisplayName: (displayName) => {
    set((state) => ({
      user: state.user ? { ...state.user, display_name: displayName } : null,
    }));
  },

  fetchMe: async () => {
    if (!getToken()) {
      set({ isLoading: false, isAuthenticated: false, user: null });
      return;
    }
    try {
      const data = await apiRequest<{ user: User }>('/auth/me');
      set({ user: data.user, isAuthenticated: true, isLoading: false });
    } catch {
      setToken(null);
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },
}));
