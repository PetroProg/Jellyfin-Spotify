import React, { useState } from 'react';
import { 
  X, Laptop, Smartphone, Tablet, Radio, Volume2, 
  Pencil, ArrowRightLeft, Loader2
} from 'lucide-react';
import { useSyncStore } from '../store/syncStore';
import { useI18nStore } from '../store/i18nStore';

export const DevicePickerModal: React.FC = () => {
  const { t } = useI18nStore();
  const { 
    isDevicePickerOpen, 
    setDevicePickerOpen, 
    devices, 
    deviceId: myDeviceId,
    deviceName,
    setDeviceName,
    activeDeviceId, 
    activeDeviceName,
    isLocalActive, 
    transferPlayback 
  } = useSyncStore();

  const [editingName, setEditingName] = useState(false);
  const [customName, setCustomName] = useState(deviceName);
  const [switching, setSwitching] = useState<string | null>(null);

  if (!isDevicePickerOpen) return null;

  const handleDeviceClick = (targetId: string) => {
    if (targetId === activeDeviceId && isLocalActive) return;
    setSwitching(targetId);
    transferPlayback(targetId);
    setTimeout(() => {
      setSwitching(null);
    }, 600);
  };

  const handleSaveName = (e: React.FormEvent) => {
    e.preventDefault();
    if (customName.trim()) {
      setDeviceName(customName.trim());
    }
    setEditingName(false);
  };

  const renderDeviceIcon = (type: string, isActive: boolean) => {
    const className = `w-6 h-6 ${isActive ? 'text-cat-green' : 'text-cat-subtext0'}`;
    if (type === 'mobile') return <Smartphone className={className} />;
    if (type === 'tablet') return <Tablet className={className} />;
    return <Laptop className={className} />;
  };

  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-cat-crust/70 backdrop-blur-md animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-md bg-cat-mantle border border-cat-surface0/90 rounded-3xl p-6 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
      >
        {/* Top Glow Accent */}
        <div className={`absolute top-0 left-0 right-0 h-1 ${!isLocalActive ? 'bg-cat-green' : 'bg-cat-mauve'}`} />

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className={`p-2.5 rounded-2xl ${!isLocalActive ? 'bg-cat-green/15 text-cat-green' : 'bg-cat-mauve/15 text-cat-mauve'}`}>
              <Radio className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h3 className="text-base font-bold text-cat-text leading-snug">
                {t('Connected Devices', 'Подключенные устройства')}
              </h3>
              <p className="text-xs text-cat-subtext0">
                {activeDeviceName
                  ? `${t('Currently playing on:', 'Сейчас играет на:')} ${activeDeviceName}`
                  : t('Select audio output device', 'Выберите устройство вывода звука')}
              </p>
            </div>
          </div>
          <button
            onClick={() => setDevicePickerOpen(false)}
            className="p-1.5 rounded-xl hover:bg-cat-surface0 text-cat-subtext0 hover:text-cat-text transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Current Device Name Customization */}
        <div className="mb-4 p-3 rounded-2xl bg-cat-surface0/50 border border-cat-surface1/30 flex items-center justify-between">
          <div className="min-w-0 flex-1 pr-2">
            <span className="text-[10px] uppercase font-bold text-cat-subtext0 tracking-wider block">
              {t('This Device Name', 'Имя этого устройства')}
            </span>
            {editingName ? (
              <form onSubmit={handleSaveName} className="flex items-center gap-2 mt-1">
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  autoFocus
                  className="w-full bg-cat-surface0 border border-cat-mauve/60 rounded-xl px-2.5 py-1 text-xs text-cat-text focus:outline-none"
                />
                <button
                  type="submit"
                  className="px-2.5 py-1 rounded-xl bg-cat-mauve text-cat-base font-bold text-xs"
                >
                  OK
                </button>
              </form>
            ) : (
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs font-semibold text-cat-text truncate">{deviceName}</span>
                <button
                  onClick={() => {
                    setCustomName(deviceName);
                    setEditingName(true);
                  }}
                  className="p-1 text-cat-subtext0 hover:text-cat-mauve transition-colors"
                  title={t('Rename device', 'Изменить имя устройства')}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>

          {!isLocalActive && (
            <button
              onClick={() => handleDeviceClick(myDeviceId)}
              className="px-3 py-1.5 rounded-xl bg-cat-mauve text-cat-base font-bold text-xs hover:opacity-95 active:scale-95 transition-all shadow-sm shrink-0 flex items-center gap-1.5"
            >
              <ArrowRightLeft className="w-3.5 h-3.5" />
              <span>{t('Play Here', 'Играть здесь')}</span>
            </button>
          )}
        </div>

        {/* Device List */}
        <div className="space-y-2 max-h-60 overflow-y-auto custom-scrollbar pr-1">
          {devices.length === 0 ? (
            <div className="py-6 text-center text-cat-subtext0 text-xs">
              {t('No other devices connected right now.', 'Другие устройства пока не подключены.')}
              <br />
              {t('Open Jellyfy on your phone or computer with this account.', 'Откройте Jellyfy на телефоне или компьютере под этим аккаунтом.')}
            </div>
          ) : (
            devices.map((dev) => {
              const isThisDevice = dev.id === myDeviceId;
              const isActiveOutput = dev.id === activeDeviceId;
              const isPending = switching === dev.id;

              return (
                <div
                  key={dev.id}
                  onClick={() => handleDeviceClick(dev.id)}
                  className={`w-full p-3.5 rounded-2xl border transition-all flex items-center justify-between cursor-pointer select-none active:scale-[0.99] ${
                    isActiveOutput
                      ? 'bg-cat-green/10 border-cat-green/40 shadow-sm'
                      : 'bg-cat-surface0/60 hover:bg-cat-surface0 border-cat-surface1/30 hover:border-cat-surface1/60'
                  }`}
                >
                  <div className="flex items-center gap-3.5 min-w-0 flex-1">
                    <div className="shrink-0">
                      {renderDeviceIcon(dev.type, isActiveOutput)}
                    </div>
                    <div className="min-w-0 flex-1 text-left">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-bold truncate ${isActiveOutput ? 'text-cat-green' : 'text-cat-text'}`}>
                          {dev.name}
                        </span>
                        {isThisDevice && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-cat-surface1/60 text-cat-subtext0 shrink-0">
                            {t('This device', 'Это устройство')}
                          </span>
                        )}
                      </div>
                      <p className={`text-xs mt-0.5 ${isActiveOutput ? 'text-cat-green/90 font-medium' : 'text-cat-subtext0'}`}>
                        {isActiveOutput ? t('● Playing now', '● Играет сейчас') : t('Click to switch', 'Нажмите для переключения')}
                      </p>
                    </div>
                  </div>

                  <div className="shrink-0 pl-2">
                    {isPending ? (
                      <Loader2 className="w-5 h-5 animate-spin text-cat-mauve" />
                    ) : isActiveOutput ? (
                      <div className="flex items-center gap-1">
                        <span className="w-1.5 h-3 bg-cat-green rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-4 bg-cat-green rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-2 bg-cat-green rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeviceClick(dev.id);
                        }}
                        className="p-1.5 rounded-xl hover:bg-cat-surface1 text-cat-subtext0 hover:text-cat-mauve transition-colors"
                        title={t('Switch playback here', 'Переключить воспроизведение сюда')}
                      >
                        <Volume2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer info */}
        <div className="mt-4 pt-3 border-t border-cat-surface0/60 flex items-center justify-between text-[11px] text-cat-subtext0">
          <span>{t('Real-time sync', 'Синхронизация в реальном времени')}</span>
          <button
            onClick={() => setDevicePickerOpen(false)}
            className="font-bold text-cat-mauve hover:underline"
          >
            {t('Close', 'Закрыть')}
          </button>
        </div>
      </div>
    </div>
  );
};
