import React, { useState, useEffect } from 'react';
import { Loader2, ArrowRight, HardDriveDownload } from 'lucide-react';
import { DownloadJob } from '../types';
import { apiRequest } from '../api/client';
import { useOfflineStore } from '../store/offlineStore';
import { usePlayerStore } from '../store/playerStore';
import { useI18nStore } from '../store/i18nStore';

interface GlobalDownloadBarProps {
  onOpenPlaylist: (id: number) => void;
  onOpenLiked?: () => void;
  currentPlaylistId?: number | null;
  currentTab?: string;
}

export const GlobalDownloadBar: React.FC<GlobalDownloadBarProps> = ({
  onOpenPlaylist,
  onOpenLiked,
}) => {
  const { t, td } = useI18nStore();
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const [backendJobs, setBackendJobs] = useState<DownloadJob[]>([]);
  const offlineProgressMap = useOfflineStore((s) => s.progress);

  const pollJobs = async () => {
    try {
      const data = await apiRequest<{ jobs: DownloadJob[] }>('/spotify/jobs');
      setBackendJobs(data.jobs || []);
    } catch {
      // Ignore background poll errors (e.g. if not logged in or network blip)
    }
  };

  useEffect(() => {
    pollJobs();
    const interval = setInterval(pollJobs, 2500);
    return () => clearInterval(interval);
  }, []);

  const activeBackendJob = backendJobs.find((j) => j.status === 'downloading');

  // Check if any offline download is active
  const activeOfflineEntry = Object.entries(offlineProgressMap).find(
    ([_, p]) => p && p.inProgress
  );

  const hasBackend = !!activeBackendJob;
  const hasOffline = !!activeOfflineEntry;

  if (!hasBackend && !hasOffline) {
    return null;
  }

  // Handle click on the banner to navigate to active download
  const handleNavigate = () => {
    if (hasBackend && activeBackendJob?.playlist_id) {
      onOpenPlaylist(activeBackendJob.playlist_id);
    } else if (hasOffline && activeOfflineEntry) {
      const pId = Number(activeOfflineEntry[0]);
      if (pId === -1) {
        onOpenLiked?.();
      } else {
        onOpenPlaylist(pId);
      }
    }
  };

  const mobileMarginClass = currentTrack
    ? 'mb-[calc(116px+env(safe-area-inset-bottom))] md:mb-0'
    : 'mb-[calc(56px+env(safe-area-inset-bottom))] md:mb-0';

  return (
    <div
      onClick={handleNavigate}
      className={`w-full max-w-full overflow-hidden box-border bg-cat-mantle/95 backdrop-blur-md border-t border-cat-surface1/60 hover:border-cat-mauve/40 transition-all shadow-2xl px-4 py-2 flex flex-col sm:flex-row items-center justify-between gap-2.5 z-30 cursor-pointer select-none ${mobileMarginClass}`}
      title={t('Click to open playlist', 'Нажмите, чтобы открыть плейлист')}
    >
      <div className="flex items-center gap-3 min-w-0 w-full sm:w-auto overflow-hidden">
        <div className="w-7 h-7 rounded-lg bg-cat-mauve/20 text-cat-mauve flex items-center justify-center shrink-0">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>

        <div className="min-w-0 flex-1">
          {hasBackend && activeBackendJob && (
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <span className="text-xs font-bold text-cat-text truncate max-w-[200px] sm:max-w-none">
                ⚡ {t('Server:', 'Сервер:')} «{td(activeBackendJob.playlist_name)}»
              </span>
              <span className="text-[11px] font-mono text-cat-mauve font-semibold shrink-0">
                {activeBackendJob.downloaded_tracks}/{activeBackendJob.total_tracks}
              </span>
              {activeBackendJob.current_track && (
                <span className="text-[11px] text-cat-subtext0 truncate max-w-[160px] md:max-w-[320px] hidden sm:inline">
                  • {activeBackendJob.current_track}
                </span>
              )}
            </div>
          )}

          {hasOffline && activeOfflineEntry && (
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <span className="text-xs font-semibold text-cat-teal truncate flex items-center gap-1 max-w-[220px] sm:max-w-none">
                <HardDriveDownload className="w-3.5 h-3.5 inline shrink-0" />
                {t('Offline saving', 'Оффлайн-сохранение')}{' '}
                {Number(activeOfflineEntry[0]) === -1 ? t('"Liked Songs"', '«Любимые треки»') : ''}
              </span>
              <span className="text-[11px] font-mono text-cat-teal font-semibold shrink-0">
                {activeOfflineEntry[1].done}/{activeOfflineEntry[1].total}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Progress bar and open button */}
      <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end shrink-0 max-w-full overflow-hidden">
        {hasBackend && activeBackendJob && (
          <div className="flex-1 sm:flex-initial sm:w-36 bg-cat-surface0 h-1.5 rounded-full overflow-hidden shrink-0">
            <div
              className="bg-cat-mauve h-full rounded-full transition-all duration-300"
              style={{
                width: `${Math.max(
                  5,
                  Math.min(
                    100,
                    Math.round(
                      (activeBackendJob.downloaded_tracks /
                        (activeBackendJob.total_tracks || 1)) *
                        100
                    )
                  )
                )}%`,
              }}
            />
          </div>
        )}

        {hasOffline && activeOfflineEntry && (
          <div className="flex-1 sm:flex-initial sm:w-32 bg-cat-surface0 h-1.5 rounded-full overflow-hidden shrink-0">
            <div
              className="bg-cat-teal h-full rounded-full transition-all duration-300"
              style={{
                width: `${Math.max(
                  5,
                  Math.min(
                    100,
                    Math.round(
                      (activeOfflineEntry[1].done /
                        (activeOfflineEntry[1].total || 1)) *
                        100
                    )
                  )
                )}%`,
              }}
            />
          </div>
        )}

        <div className="flex items-center gap-1 text-[11px] font-semibold text-cat-mauve hover:text-cat-text transition-colors shrink-0">
          <span>{t('Open', 'Открыть')}</span>
          <ArrowRight className="w-3 h-3" />
        </div>
      </div>
    </div>
  );
};
