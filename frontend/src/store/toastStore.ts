import { create } from 'zustand';
import { td } from './i18nStore';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  title?: string;
  duration: number;
  createdAt: number;
}

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isDestructive?: boolean;
}

interface ConfirmState extends ConfirmDialogOptions {
  id: number;
  resolve: (value: boolean) => void;
}

interface ToastState {
  toasts: ToastItem[];
  confirmState: ConfirmState | null;
  addToast: (type: ToastType, message: string, title?: string, duration?: number) => string;
  removeToast: (id: string) => void;
  openConfirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  closeConfirm: (result: boolean) => void;
}

let toastSeq = 0;
let confirmSeq = 0;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  confirmState: null,

  addToast: (type, message, title, duration = 4000) => {
    const id = `toast-${Date.now()}-${++toastSeq}`;
    const newToast: ToastItem = {
      id,
      type,
      message: td(message),
      title: title ? td(title) : undefined,
      duration,
      createdAt: Date.now()
    };

    set((state) => ({
      // Keep max 5 toasts visible at once, new ones on top
      toasts: [newToast, ...state.toasts.slice(0, 4)]
    }));

    if (duration > 0) {
      setTimeout(() => {
        get().removeToast(id);
      }, duration);
    }

    return id;
  },

  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id)
    }));
  },

  openConfirm: (options) => {
    return new Promise<boolean>((resolve) => {
      set({
        confirmState: {
          ...options,
          id: ++confirmSeq,
          resolve
        }
      });
    });
  },

  closeConfirm: (result: boolean) => {
    const { confirmState } = get();
    if (confirmState) {
      confirmState.resolve(result);
      set({ confirmState: null });
    }
  }
}));

// Quick convenience helpers
export const toast = {
  success: (message: string, title?: string, duration = 4000) =>
    useToastStore.getState().addToast('success', message, title, duration),
  error: (message: string, title?: string, duration = 5000) =>
    useToastStore.getState().addToast('error', message, title, duration),
  info: (message: string, title?: string, duration = 4000) =>
    useToastStore.getState().addToast('info', message, title, duration),
  warning: (message: string, title?: string, duration = 4500) =>
    useToastStore.getState().addToast('warning', message, title, duration),
};

export const confirmDialog = (options: ConfirmDialogOptions): Promise<boolean> => {
  return useToastStore.getState().openConfirm(options);
};
