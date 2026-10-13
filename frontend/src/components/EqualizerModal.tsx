import React from 'react';
import { X, SlidersHorizontal, Volume2, Sparkles, RotateCcw } from 'lucide-react';
import { usePlayerStore, EQ_PRESETS } from '../store/playerStore';

const BAND_LABELS = [
  { freq: '60 Hz', name: 'Саб-бас' },
  { freq: '230 Hz', name: 'Бас' },
  { freq: '910 Hz', name: 'Средние' },
  { freq: '3.6 kHz', name: 'Верх. средние' },
  { freq: '14 kHz', name: 'Воздух / ВЧ' },
];

export const EqualizerModal: React.FC = () => {
  const {
    isEqualizerOpen,
    setEqualizerOpen,
    eqBands,
    setEqGain,
    eqPreset,
    setEqPreset,
    isNormalizerEnabled,
    toggleNormalizer,
    resetEqualizer,
  } = usePlayerStore();

  if (!isEqualizerOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-cat-crust/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="bg-cat-mantle border border-cat-surface1/40 rounded-3xl p-5 md:p-6 max-w-md w-full shadow-2xl flex flex-col max-h-[90vh] overflow-y-auto custom-scrollbar">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-cat-surface0/60 mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-cat-mauve/20 text-cat-mauve flex items-center justify-center">
              <SlidersHorizontal className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base text-cat-text">Студийный звук & EQ</h3>
              <p className="text-[11px] text-cat-subtext0">Настройка качества и окраски звука</p>
            </div>
          </div>
          <button
            onClick={() => setEqualizerOpen(false)}
            className="p-1.5 rounded-full text-cat-subtext0 hover:text-cat-text hover:bg-cat-surface0 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Quality Engine Badge */}
        <div className="bg-cat-surface0/50 border border-cat-surface1/30 rounded-2xl p-3 mb-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Sparkles className="w-4 h-4 text-cat-yellow flex-shrink-0" />
            <div>
              <p className="text-xs font-bold text-cat-text">320 kbps Studio Master Engine</p>
              <p className="text-[10px] text-cat-subtext0">Аудиопоток высокой четкости 44.1 kHz</p>
            </div>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cat-green/20 text-cat-green font-semibold">
            Hi-Fi 320k
          </span>
        </div>

        {/* Section 1: Loudness Normalization */}
        <div className="bg-cat-surface0/40 border border-cat-surface1/20 rounded-2xl p-3.5 mb-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Volume2 className="w-5 h-5 text-cat-mauve flex-shrink-0" />
            <div>
              <p className="text-xs font-bold text-cat-text">Нормализация громкости</p>
              <p className="text-[11px] text-cat-subtext0 mt-0.5">
                Выравнивает уровень треков (как в Spotify), делает бас плотнее
              </p>
            </div>
          </div>
          <button
            onClick={toggleNormalizer}
            className={`w-12 h-6.5 rounded-full p-1 transition-colors duration-200 ease-in-out cursor-pointer flex-shrink-0 ${
              isNormalizerEnabled ? 'bg-cat-mauve' : 'bg-cat-surface1'
            }`}
          >
            <div
              className={`w-4.5 h-4.5 bg-cat-base rounded-full shadow-md transform transition-transform duration-200 ease-in-out ${
                isNormalizerEnabled ? 'translate-x-5.5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Section 2: Presets */}
        <div className="mb-5">
          <label className="text-[11px] font-semibold text-cat-subtext0 uppercase tracking-wider block mb-2 px-1">
            Пресеты звучания
          </label>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(EQ_PRESETS).map(([key, p]) => (
              <button
                key={key}
                onClick={() => setEqPreset(key)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                  eqPreset === key
                    ? 'bg-cat-mauve text-cat-base shadow-sm'
                    : 'bg-cat-surface0/60 hover:bg-cat-surface0 text-cat-text hover:text-cat-mauve border border-cat-surface1/30'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Section 3: 5-Band Equalizer Sliders */}
        <div className="mb-5 bg-cat-surface0/30 border border-cat-surface1/20 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3 px-1">
            <label className="text-[11px] font-semibold text-cat-subtext0 uppercase tracking-wider">
              5-полосный эквалайзер (-12 до +12 dB)
            </label>
            <button
              onClick={resetEqualizer}
              className="text-[11px] text-cat-subtext0 hover:text-cat-mauve flex items-center gap-1 cursor-pointer transition-colors"
              title="Сбросить в 0 dB"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Сброс</span>
            </button>
          </div>

          <div className="grid grid-cols-5 gap-2 items-end pt-2 pb-1">
            {BAND_LABELS.map((band, idx) => {
              const val = eqBands[idx] || 0;
              return (
                <div key={band.freq} className="flex flex-col items-center gap-2">
                  <span className="text-[10px] font-mono text-cat-mauve font-bold">
                    {val > 0 ? `+${val}` : val} dB
                  </span>
                  <div className="h-32 flex items-center justify-center">
                    <input
                      type="range"
                      min={-12}
                      max={12}
                      step={1}
                      value={val}
                      onChange={(e) => setEqGain(idx, Number(e.target.value))}
                      className="h-28 w-2 bg-cat-surface1 rounded-lg appearance-none cursor-pointer accent-cat-mauve -rotate-90 origin-center"
                    />
                  </div>
                  <span className="text-[10px] font-mono font-semibold text-cat-text">
                    {band.freq}
                  </span>
                  <span className="text-[9px] text-cat-subtext0 text-center leading-tight">
                    {band.name}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-cat-surface0/60 flex justify-end">
          <button
            onClick={() => setEqualizerOpen(false)}
            className="px-6 py-2.5 rounded-2xl bg-cat-mauve text-cat-base text-xs font-bold hover:opacity-95 active:scale-95 transition-all shadow-md cursor-pointer"
          >
            Применить и закрыть
          </button>
        </div>
      </div>
    </div>
  );
};
