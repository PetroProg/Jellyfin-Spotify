import { db } from './db';
import { getOrGenerateDailyMixes, getTodayDateKey, getUserTimezone } from './dailyMix';
import { isUserOnline, isUserPlayingMusic, isAnyUserPlayingMusic } from './sync';
import { upgradeSingleTrackFile, getUpgradeProgress } from './downloader';

let schedulerInterval: NodeJS.Timeout | null = null;
let isJobRunning = false;
let lastNightlyHealerDate: string | null = null;

interface UserNightlyConfig {
  id: number;
  username: string;
  display_name: string;
  timezone: string;
  nightly_mix_enabled: number;
  nightly_mix_hour: number;
}

/**
 * Checks all users and triggers nightly Daily Mix generation and downloads
 * when the user is offline during their local nighttime window (02:00 – 05:00 AM).
 */
export async function checkAndRunNightlyMixes(): Promise<void> {
  if (isJobRunning) return;
  isJobRunning = true;

  try {
    const users = db.prepare(`
      SELECT id, username, display_name,
             COALESCE(timezone, 'Europe/Kyiv') as timezone,
             COALESCE(nightly_mix_enabled, 1) as nightly_mix_enabled,
             COALESCE(nightly_mix_hour, 3) as nightly_mix_hour
      FROM users
    `).all() as UserNightlyConfig[];

    for (const user of users) {
      if (!user.nightly_mix_enabled) {
        continue;
      }

      // Check if user has at least 2 tracks in library to form mixes
      const userTrackCount = (db.prepare(`
        SELECT COUNT(*) as cnt FROM (
          SELECT t.id FROM tracks t
          JOIN playlist_tracks pt ON pt.track_id = t.id
          JOIN playlists p ON p.id = pt.playlist_id AND COALESCE(p.is_daily_mix, 0) = 0
          WHERE p.user_id = ?
          UNION
          SELECT lt.track_id FROM liked_tracks lt WHERE lt.user_id = ?
        )
      `).get(user.id, user.id) as any)?.cnt || 0;

      if (userTrackCount < 2) {
        continue;
      }

      const tz = user.timezone || 'Europe/Kyiv';
      let localDateStr: string;
      let localHour: number;
      let localMinute: number;

      try {
        localDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
        const hourStr = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date());
        const minStr = new Intl.DateTimeFormat('en-US', { minute: 'numeric', timeZone: tz }).format(new Date());
        localHour = parseInt(hourStr, 10);
        localMinute = parseInt(minStr, 10);
      } catch (_) {
        localDateStr = getTodayDateKey(tz);
        localHour = new Date().getUTCHours();
        localMinute = new Date().getUTCMinutes();
      }

      // Check if mixes for this user have already been generated for today's date
      const existingToday = db.prepare(`
        SELECT COUNT(*) as cnt FROM playlists
        WHERE user_id = ? AND is_daily_mix = 1 AND daily_mix_date = ?
      `).get(user.id, localDateStr) as any;

      if ((existingToday?.cnt || 0) > 0) {
        // Already generated for today
        continue;
      }

      // Nightly target window: 02:00 to 05:00 AM local time
      // Default preferred hour is 03:00, but anywhere between 02:00 and 05:00 is acceptable
      const targetHour = user.nightly_mix_hour || 3;
      const isNightTime = localHour >= 2 && localHour <= 5;

      if (!isNightTime) {
        continue;
      }

      // Check user offline status
      const online = isUserOnline(user.id);
      const playing = isUserPlayingMusic(user.id);

      // If user is currently online or listening to music, and we haven't reached the late deadline (05:00),
      // postpone generation so we don't disrupt their active session or compete for bandwidth.
      if ((online || playing) && localHour < 5) {
        console.log(`[Nightly Scheduler] User ${user.username} is currently online/listening at ${localHour}:${String(localMinute).padStart(2, '0')} (${tz}). Postponing mix generation until offline.`);
        continue;
      }

      console.log(`[Nightly Scheduler] Starting nightly generation for ${user.username} (ID: ${user.id}) at ${localHour}:${String(localMinute).padStart(2, '0')} (${tz}) for date ${localDateStr}...`);

      try {
        const mixes = await getOrGenerateDailyMixes(user.id, true, tz);
        console.log(`[Nightly Scheduler] Successfully generated ${mixes.length} Daily Mixes for ${user.username} (${localDateStr}). Background downloads queued for morning readiness.`);
      } catch (err: any) {
        console.error(`[Nightly Scheduler Error for ${user.username}]:`, err.message || err);
      }
    }

    // Run nightly quality healer once per night between 02:00 and 05:00 AM server time when nobody is playing music
    const serverHour = new Date().getHours();
    const todayDate = new Date().toISOString().slice(0, 10);
    if (serverHour >= 2 && serverHour <= 5 && !isAnyUserPlayingMusic() && lastNightlyHealerDate !== todayDate) {
      lastNightlyHealerDate = todayDate;
      await checkAndRunNightlyQualityHealer(15);
    }
  } catch (err: any) {
    console.error('[Nightly Scheduler Error]:', err.message || err);
  } finally {
    isJobRunning = false;
  }
}

/**
 * Automatically heals low-quality/legacy tracks (up to 15 per night) during 02:00-05:00 AM window
 * while no users are listening to music, ensuring 100% studio quality library over time.
 */
export async function checkAndRunNightlyQualityHealer(maxTracksPerNight = 15): Promise<number> {
  if (isAnyUserPlayingMusic()) {
    return 0;
  }
  const currentProgress = getUpgradeProgress();
  if (currentProgress.isRunning) {
    return 0;
  }

  const candidates = db.prepare(`
    SELECT t.id, t.title, t.artist, t.album, t.duration_ms, t.file_path, t.cover_url, t.spotify_id, t.bitrate
    FROM tracks t
    WHERE t.file_path LIKE '%.m4a' OR (t.bitrate IS NOT NULL AND t.bitrate < 250)
    ORDER BY
      CASE WHEN EXISTS (SELECT 1 FROM liked_tracks lt WHERE lt.track_id = t.id)
             OR EXISTS (SELECT 1 FROM playlist_tracks pt WHERE pt.track_id = t.id)
           THEN 0 ELSE 1 END ASC,
      t.id DESC
    LIMIT ?
  `).all(maxTracksPerNight) as any[];

  if (candidates.length === 0) {
    return 0;
  }

  console.log(`[Nightly Quality Healer] Starting nightly healing for ${candidates.length} low-quality/legacy tracks...`);
  let healed = 0;
  for (const tr of candidates) {
    if (isAnyUserPlayingMusic()) {
      console.log('[Nightly Quality Healer] User started listening. Pausing healing until next idle window.');
      break;
    }
    const ok = await upgradeSingleTrackFile(tr);
    if (ok) healed++;
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`[Nightly Quality Healer] Finished tonight: healed ${healed}/${candidates.length} tracks to 320 kbps studio quality.`);
  return healed;
}

/**
 * Initializes the background scheduler service.
 * Runs check every 5 minutes.
 */
export function startNightlyScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
  }

  // Initial check 10 seconds after server startup
  setTimeout(() => {
    checkAndRunNightlyMixes().catch(err => console.error('[Nightly Scheduler Initial Check Error]:', err));
  }, 10000);

  // Periodic check every 5 minutes
  schedulerInterval = setInterval(() => {
    checkAndRunNightlyMixes().catch(err => console.error('[Nightly Scheduler Periodic Check Error]:', err));
  }, 5 * 60 * 1000);

  console.log('[Nightly Scheduler] Daily Mix background auto-update service initialized (runs 02:00–05:00 AM when offline).');
}

/**
 * Returns current schedule status and today's readiness for a given user.
 */
export function getNightlySchedulerStatus(userId: number) {
  const user = db.prepare(`
    SELECT id, username,
           COALESCE(timezone, 'Europe/Kyiv') as timezone,
           COALESCE(nightly_mix_enabled, 1) as nightly_mix_enabled,
           COALESCE(nightly_mix_hour, 3) as nightly_mix_hour
    FROM users WHERE id = ?
  `).get(userId) as any;

  if (!user) return null;

  const tz = user.timezone || 'Europe/Kyiv';
  let localDate = getTodayDateKey(tz);
  let localHourStr = '00';
  let localMinuteStr = '00';

  try {
    localDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    localHourStr = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date());
    localMinuteStr = new Intl.DateTimeFormat('en-US', { minute: 'numeric', timeZone: tz }).format(new Date());
  } catch (_) {}

  // Check today's mixes
  const todayMixes = db.prepare(`
    SELECT p.id, p.name,
           (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) as track_count
    FROM playlists p
    WHERE p.user_id = ? AND p.is_daily_mix = 1 AND p.daily_mix_date = ?
  `).all(userId, localDate) as any[];

  const isGeneratedToday = todayMixes.length > 0;
  const totalTracks = todayMixes.reduce((acc, m) => acc + (m.track_count || 0), 0);

  // Check if any download job is actively running for daily mixes
  const activeJobs = db.prepare(`
    SELECT COUNT(*) as count FROM download_jobs dj
    JOIN playlists p ON p.id = dj.playlist_id
    WHERE p.user_id = ? AND p.is_daily_mix = 1 AND dj.status IN ('pending', 'downloading')
  `).get(userId) as any;

  const isDownloading = (activeJobs?.count || 0) > 0;
  const online = isUserOnline(userId);
  const playing = isUserPlayingMusic(userId);

  return {
    enabled: Boolean(user.nightly_mix_enabled),
    hour: user.nightly_mix_hour,
    timezone: tz,
    currentTime: `${localHourStr.padStart(2, '0')}:${localMinuteStr.padStart(2, '0')}`,
    currentDate: localDate,
    isGeneratedToday,
    isDownloading,
    mixCount: todayMixes.length,
    totalTracks,
    isOnline: online,
    isPlaying: playing,
  };
}

/**
 * Updates schedule settings for a user.
 */
export function updateNightlySchedule(userId: number, opts: { enabled?: boolean; hour?: number; timezone?: string }) {
  if (opts.enabled !== undefined) {
    db.prepare('UPDATE users SET nightly_mix_enabled = ? WHERE id = ?').run(opts.enabled ? 1 : 0, userId);
  }
  if (opts.hour !== undefined) {
    const rawH = Number(opts.hour);
    if (Number.isFinite(rawH)) {
      const clampedHour = Math.max(0, Math.min(23, Math.floor(rawH)));
      db.prepare('UPDATE users SET nightly_mix_hour = ? WHERE id = ?').run(clampedHour, userId);
    }
  }
  if (opts.timezone && typeof opts.timezone === 'string') {
    const tz = opts.timezone.trim();
    if (tz.length > 0 && tz.length <= 64) {
      try {
        // Validate timezone
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(tz, userId);
      } catch (_) {}
    }
  }
  return getNightlySchedulerStatus(userId);
}
