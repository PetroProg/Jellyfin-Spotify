import { db } from './db';

export interface ListeningEventInput {
  clientEventId: string;
  trackId?: number | null;
  title?: string;
  artist?: string;
  durationSec?: number;
  listenedSec: number;
  playedAt?: string | number;
}

export interface UserTopTrack {
  title: string;
  artist: string;
  plays: number;
  listenedSec: number;
}

export interface UserListeningStats {
  userId: number;
  username: string;
  displayName: string;
  totalPlays: number;
  weeklyPlays: number;
  totalListenedSec: number;
  weeklyListenedSec: number;
  lastPlayedAt: string | null;
  topTracks: UserTopTrack[];
}

export interface ListeningReportData {
  generatedAt: string;
  timezone: string;
  periodDays: number;
  summary: {
    totalUsers: number;
    activeUsersThisWeek: number;
    totalPlaysAllUsers: number;
    weeklyPlaysAllUsers: number;
    totalListenedSecAllUsers: number;
    weeklyListenedSecAllUsers: number;
  };
  users: UserListeningStats[];
}

const MAX_TRACK_SECONDS = 7200; // 2 hours upper bound per single play
const MIN_QUALIFIED_SECONDS = 10;
const MAX_PAST_DRIFT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days for offline outbox
const MAX_FUTURE_DRIFT_MS = 5 * 60 * 1000; // 5 minutes clock skew

export function formatUtcSqliteDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function formatDurationRu(totalSec: number): string {
  const safeSec = Math.max(0, Math.floor(Number(totalSec) || 0));
  if (safeSec === 0) return '0 мин';
  if (safeSec < 60) return '< 1 мин';

  const totalMin = Math.round(safeSec / 60);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;

  if (hours === 0) return `${mins} мин`;
  if (mins === 0) return `${hours} ч`;
  return `${hours} ч ${mins} мин`;
}

export function recordListeningEvent(
  userId: number,
  input: ListeningEventInput
): { ok: boolean; listenedSec?: number; error?: string } {
  if (!Number.isInteger(userId) || userId <= 0) {
    return { ok: false, error: 'Некорректный пользователь' };
  }

  const rawEventId = typeof input.clientEventId === 'string' ? input.clientEventId.trim() : '';
  if (rawEventId.length < 4 || rawEventId.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(rawEventId)) {
    return { ok: false, error: 'Некорректный идентификатор события прослушивания' };
  }

  // Verify optional trackId against tracks table to avoid FK violation if track was deleted
  let verifiedTrackId: number | null = null;
  let dbTrack: { title?: string; artist?: string; duration_ms?: number } | undefined;

  if (input.trackId !== undefined && input.trackId !== null) {
    const parsedTrackId = Number(input.trackId);
    if (Number.isInteger(parsedTrackId) && parsedTrackId > 0) {
      dbTrack = db
        .prepare('SELECT title, artist, duration_ms FROM tracks WHERE id = ?')
        .get(parsedTrackId) as { title?: string; artist?: string; duration_ms?: number } | undefined;
      if (dbTrack) {
        verifiedTrackId = parsedTrackId;
      }
    }
  }

  const title = String(input.title || dbTrack?.title || '').trim().slice(0, 200);
  const artist = String(input.artist || dbTrack?.artist || '').trim().slice(0, 200);
  if (!title || !artist) {
    return { ok: false, error: 'Название трека и исполнитель обязательны' };
  }

  const fallbackDurationSec = dbTrack?.duration_ms ? Math.round(dbTrack.duration_ms / 1000) : 0;
  const rawDuration = Number(input.durationSec);
  const durationSec = Number.isFinite(rawDuration) && rawDuration > 0
    ? Math.min(MAX_TRACK_SECONDS, Math.round(rawDuration))
    : Math.min(MAX_TRACK_SECONDS, Math.max(0, fallbackDurationSec));

  const rawListened = Number(input.listenedSec);
  if (!Number.isFinite(rawListened) || rawListened < MIN_QUALIFIED_SECONDS) {
    return { ok: false, error: 'Слишком короткое время прослушивания' };
  }

  const maxAllowedListened = durationSec > 0
    ? Math.min(MAX_TRACK_SECONDS, Math.max(durationSec + 10, 30))
    : MAX_TRACK_SECONDS;
  const listenedSec = Math.max(
    MIN_QUALIFIED_SECONDS,
    Math.min(maxAllowedListened, Math.round(rawListened))
  );

  // Validate optional offline playedAt timestamp
  const nowMs = Date.now();
  let playedAtDate = new Date(nowMs);
  if (input.playedAt !== undefined && input.playedAt !== null && input.playedAt !== '') {
    const parsedMs = typeof input.playedAt === 'number'
      ? input.playedAt
      : Date.parse(String(input.playedAt));
    if (
      Number.isFinite(parsedMs) &&
      parsedMs >= nowMs - MAX_PAST_DRIFT_MS &&
      parsedMs <= nowMs + MAX_FUTURE_DRIFT_MS
    ) {
      playedAtDate = new Date(parsedMs);
    }
  }

  const playedAtSqlite = formatUtcSqliteDate(playedAtDate);

  db.prepare(`
    INSERT INTO listening_logs (
      user_id,
      track_id,
      track_title,
      track_artist,
      duration_sec,
      listened_sec,
      client_event_id,
      played_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, client_event_id) DO UPDATE SET
      listened_sec = MAX(listening_logs.listened_sec, excluded.listened_sec),
      duration_sec = CASE
        WHEN listening_logs.duration_sec <= 0 AND excluded.duration_sec > 0 THEN excluded.duration_sec
        ELSE listening_logs.duration_sec
      END
  `).run(
    userId,
    verifiedTrackId,
    title,
    artist,
    durationSec,
    listenedSec,
    rawEventId,
    playedAtSqlite
  );

  return { ok: true, listenedSec };
}

export function getListeningReportData(
  periodDays = 7,
  timezone = 'Europe/Zurich'
): ListeningReportData {
  const safePeriodDays = Math.max(1, Math.min(365, Math.floor(Number(periodDays) || 7)));
  const cutoffDate = new Date(Date.now() - safePeriodDays * 24 * 60 * 60 * 1000);
  const cutoffSqlite = formatUtcSqliteDate(cutoffDate);

  const userRows = db.prepare(`
    SELECT
      u.id AS user_id,
      u.username AS username,
      u.display_name AS display_name,
      COUNT(l.id) AS total_plays,
      COALESCE(SUM(CASE WHEN l.played_at >= ? THEN 1 ELSE 0 END), 0) AS weekly_plays,
      COALESCE(SUM(l.listened_sec), 0) AS total_listened_sec,
      COALESCE(SUM(CASE WHEN l.played_at >= ? THEN l.listened_sec ELSE 0 END), 0) AS weekly_listened_sec,
      MAX(l.played_at) AS last_played_at
    FROM users u
    LEFT JOIN listening_logs l ON l.user_id = u.id
    GROUP BY u.id, u.username, u.display_name
    ORDER BY total_plays DESC, weekly_plays DESC, LOWER(u.username) ASC
  `).all(cutoffSqlite, cutoffSqlite) as Array<{
    user_id: number;
    username: string;
    display_name: string;
    total_plays: number;
    weekly_plays: number;
    total_listened_sec: number;
    weekly_listened_sec: number;
    last_played_at: string | null;
  }>;

  const topTrackRows = db.prepare(`
    WITH ranked AS (
      SELECT
        user_id,
        MAX(track_title) AS track_title,
        MAX(track_artist) AS track_artist,
        COUNT(*) AS plays,
        COALESCE(SUM(listened_sec), 0) AS listened_sec,
        ROW_NUMBER() OVER (
          PARTITION BY user_id
          ORDER BY COUNT(*) DESC, COALESCE(SUM(listened_sec), 0) DESC, MAX(played_at) DESC
        ) AS rn
      FROM listening_logs
      GROUP BY user_id, LOWER(track_title), LOWER(track_artist)
    )
    SELECT user_id, track_title, track_artist, plays, listened_sec
    FROM ranked
    WHERE rn <= 3
    ORDER BY user_id ASC, rn ASC
  `).all() as Array<{
    user_id: number;
    track_title: string;
    track_artist: string;
    plays: number;
    listened_sec: number;
  }>;

  const topTracksByUser = new Map<number, UserTopTrack[]>();
  for (const row of topTrackRows) {
    let list = topTracksByUser.get(row.user_id);
    if (!list) {
      list = [];
      topTracksByUser.set(row.user_id, list);
    }
    list.push({
      title: row.track_title,
      artist: row.track_artist,
      plays: Number(row.plays) || 0,
      listenedSec: Number(row.listened_sec) || 0,
    });
  }

  let activeUsersThisWeek = 0;
  let totalPlaysAllUsers = 0;
  let weeklyPlaysAllUsers = 0;
  let totalListenedSecAllUsers = 0;
  let weeklyListenedSecAllUsers = 0;

  const users: UserListeningStats[] = userRows.map((row) => {
    const totalPlays = Number(row.total_plays) || 0;
    const weeklyPlays = Number(row.weekly_plays) || 0;
    const totalListenedSec = Number(row.total_listened_sec) || 0;
    const weeklyListenedSec = Number(row.weekly_listened_sec) || 0;

    if (weeklyPlays > 0) activeUsersThisWeek++;
    totalPlaysAllUsers += totalPlays;
    weeklyPlaysAllUsers += weeklyPlays;
    totalListenedSecAllUsers += totalListenedSec;
    weeklyListenedSecAllUsers += weeklyListenedSec;

    return {
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      totalPlays,
      weeklyPlays,
      totalListenedSec,
      weeklyListenedSec,
      lastPlayedAt: row.last_played_at || null,
      topTracks: topTracksByUser.get(row.user_id) || [],
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    timezone,
    periodDays: safePeriodDays,
    summary: {
      totalUsers: users.length,
      activeUsersThisWeek,
      totalPlaysAllUsers,
      weeklyPlaysAllUsers,
      totalListenedSecAllUsers,
      weeklyListenedSecAllUsers,
    },
    users,
  };
}
