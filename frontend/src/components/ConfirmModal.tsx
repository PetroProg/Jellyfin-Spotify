import React, { useEffect } from 'react';
import { useToastStore } from '../store/toastStore';
import { AlertTriangle, HelpCircle, X } from 'lucide-react';

export const ConfirmModal: React.FC = () => {
  const { confirmState, closeConfirm } = useToastStore();

  useEffect(() => {
    if (!confirmState) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeConfirm(false);
      } else if (e.key === 'Enter') {
        closeConfirm(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [confirmState, closeConfirm]);

  if (!confirmState) return null;

  const isDestructive = !!confirmState.isDestructive;

  return (
    <div className="fixed inset-0 z-[99998] flex items-center justify-center p-4 bg-cat-crust/70 backdrop-blur-md animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-md bg-cat-mantle border border-cat-surface0/90 rounded-3xl p-6 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        {/* Top Glow Accent */}
        <div
          className={`absolute top-0 left-0 right-0 h-1 ${
            isDestructive ? 'bg-cat-red' : 'bg-cat-mauve'
          }`}
        />

        <div className="flex items-start gap-4">
          <div
            className={`p-3 rounded-2xl flex-shrink-0 ${
              isDestructive
                ? 'bg-cat-red/15 text-cat-red'
                : 'bg-cat-mauve/15 text-cat-mauve'
            }`}
          >
            {isDestructive ? (
              <AlertTriangle className="w-6 h-6" />
            ) : (
              <HelpCircle className="w-6 h-6" />
            )}
          </div>

          <div className="flex-1 min-w-0 pt-0.5">
            <h3
              id="confirm-dialog-title"
              className="text-base font-bold text-cat-text leading-snug"
            >
              {confirmState.title}
            </h3>
            <p className="mt-2 text-sm text-cat-subtext0 leading-relaxed whitespace-pre-wrap">
              {confirmState.message}
            </p>
          </div>

          <button
            onClick={() => closeConfirm(false)}
            className="p-1 rounded-xl text-cat-overlay0 hover:text-cat-text hover:bg-cat-surface0 transition active:scale-95"
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 mt-6 pt-2">
          <button
            type="button"
            onClick={() => closeConfirm(false)}
            className="px-4 py-2.5 rounded-xl bg-cat-surface0 hover:bg-cat-surface1 text-cat-subtext1 hover:text-cat-text text-sm font-semibold transition active:scale-95 cursor-pointer"
          >
            {confirmState.cancelText || 'Отмена'}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => closeConfirm(true)}
            className={`px-5 py-2.5 rounded-xl text-sm font-bold shadow-lg transition active:scale-95 cursor-pointer ${
              isDestructive
                ? 'bg-cat-red hover:bg-cat-red/90 text-cat-base shadow-cat-red/20'
                : 'bg-cat-mauve hover:bg-cat-mauve/90 text-cat-base shadow-cat-mauve/20'
            }`}
          >
            {confirmState.confirmText || 'Подтвердить'}
          </button>
        </div>
      </div>
    </div>
  );
};
