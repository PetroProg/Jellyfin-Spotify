import React from 'react';
import { useToastStore, ToastItem } from '../store/toastStore';
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';

const ToastCard: React.FC<{ toast: ToastItem; onDismiss: (id: string) => void }> = ({ toast, onDismiss }) => {
  const isSuccess = toast.type === 'success';
  const isError = toast.type === 'error';
  const isWarning = toast.type === 'warning';
  const isInfo = toast.type === 'info';

  const borderColor = isSuccess
    ? 'border-cat-green/35 shadow-cat-green/10'
    : isError
    ? 'border-cat-red/35 shadow-cat-red/10'
    : isWarning
    ? 'border-cat-yellow/35 shadow-cat-yellow/10'
    : 'border-cat-mauve/35 shadow-cat-mauve/10';

  const iconBg = isSuccess
    ? 'bg-cat-green/15 text-cat-green'
    : isError
    ? 'bg-cat-red/15 text-cat-red'
    : isWarning
    ? 'bg-cat-yellow/15 text-cat-yellow'
    : 'bg-cat-mauve/15 text-cat-mauve';

  const barBg = isSuccess
    ? 'bg-cat-green'
    : isError
    ? 'bg-cat-red'
    : isWarning
    ? 'bg-cat-yellow'
    : 'bg-cat-mauve';

  return (
    <div
      role="alert"
      className={`pointer-events-auto relative w-full overflow-hidden rounded-2xl bg-cat-mantle/95 backdrop-blur-md border ${borderColor} p-3.5 shadow-xl transition-all duration-300 ease-out hover:scale-[1.01]`}
      style={{
        animation: 'slideDownFade 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards'
      }}
    >
      <div className="flex items-start gap-3">
        {/* Type Icon */}
        <div className={`p-2 rounded-xl flex-shrink-0 ${iconBg}`}>
          {isSuccess && <CheckCircle2 className="w-5 h-5" />}
          {isError && <AlertCircle className="w-5 h-5" />}
          {isWarning && <AlertTriangle className="w-5 h-5" />}
          {isInfo && <Info className="w-5 h-5" />}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 pt-0.5">
          {toast.title && (
            <h4 className="text-xs font-bold uppercase tracking-wider text-cat-text mb-0.5">
              {toast.title}
            </h4>
          )}
          <p className="text-sm text-cat-text/90 font-medium leading-snug break-words">
            {toast.message}
          </p>
        </div>

        {/* Dismiss Button */}
        <button
          onClick={() => onDismiss(toast.id)}
          className="p-1 rounded-lg text-cat-subtext0 hover:text-cat-text hover:bg-cat-surface0/60 transition active:scale-95 flex-shrink-0"
          aria-label="Закрыть"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Auto-dismiss progress bar */}
      {toast.duration > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-[2.5px] bg-cat-surface0/40 overflow-hidden">
          <div
            className={`h-full ${barBg} opacity-80`}
            style={{
              animation: `shrinkWidth ${toast.duration}ms linear forwards`
            }}
          />
        </div>
      )}
    </div>
  );
};

export const ToastContainer: React.FC = () => {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed top-4 right-4 left-4 sm:left-auto sm:w-96 z-[99999] pointer-events-none flex flex-col gap-2.5 max-w-sm ml-auto"
    >
      {toasts.map((item) => (
        <ToastCard key={item.id} toast={item} onDismiss={removeToast} />
      ))}
    </div>
  );
};
