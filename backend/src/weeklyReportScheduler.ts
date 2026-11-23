import { db } from './db';
import { getListeningReportData } from './listeningStats';
import { getMaskedRecipient, isEmailConfigured, sendWeeklyListeningReport } from './email';

export interface WeeklyReportScheduleConfig {
  enabled: boolean;
  timezone: string;
  dayOfWeek: number; // 0 = Sunday .. 6 = Saturday
  hour: number; // 0..23
  minute: number; // 0..59
}

export interface LocalScheduleParts {
  dateStr: string; // YYYY-MM-DD
  dayOfWeek: number; // 0 = Sun .. 6 = Sat
  hour: number;
  minute: number;
}

const SETTING_LAST_SENT_DATE = 'weekly_report_last_sent_date';
const SETTING_LAST_SENT_AT = 'weekly_report_last_sent_at';
const SETTING_LAST_ERROR = 'weekly_report_last_error';

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const DAY_NAMES_RU = [
  'Воскресенье',
  'Понедельник',
  'Вторник',
  'Среда',
  'Четверг',
  'Пятница',
  'Суббота',
];

const RETRY_COOLDOWN_MS = 15 * 60 * 1000; // 15 min between retry attempts
const MAX_DAILY_RETRIES = 5;

let schedulerInterval: NodeJS.Timeout | null = null;
let isSendingReport = false;
let lastFailureAtMs = 0;
let failureDateStr = '';
let failureCountToday = 0;

function getAppSetting(key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  } catch (_) {
    return null;
  }
}

function setAppSetting(key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function getWeeklyReportConfig(): WeeklyReportScheduleConfig {
  const enabledRaw = (process.env.WEEKLY_REPORT_ENABLED || 'true').trim().toLowerCase();
  const enabled = enabledRaw !== 'false' && enabledRaw !== '0' && enabledRaw !== 'no';

  let timezone = (process.env.WEEKLY_REPORT_TIMEZONE || 'Europe/Zurich').trim() || 'Europe/Zurich';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch (_) {
    timezone = 'Europe/Zurich';
  }

  const rawDay = parseInt(process.env.WEEKLY_REPORT_DAY || '0', 10);
  const dayOfWeek = Number.isFinite(rawDay) && rawDay >= 0 && rawDay <= 6 ? rawDay : 0;

  const rawHour = parseInt(process.env.WEEKLY_REPORT_HOUR || '12', 10);
  const hour = Number.isFinite(rawHour) && rawHour >= 0 && rawHour <= 23 ? rawHour : 12;

  const rawMin = parseInt(process.env.WEEKLY_REPORT_MINUTE || '0', 10);
  const minute = Number.isFinite(rawMin) && rawMin >= 0 && rawMin <= 59 ? rawMin : 0;

  return { enabled, timezone, dayOfWeek, hour, minute };
}

export function getLocalScheduleParts(date: Date, timeZone: string): LocalScheduleParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '';

  const year = get('year');
  const month = get('month');
  const day = get('day');
  const weekdayStr = get('weekday');
  const hourNum = parseInt(get('hour'), 10);
  const minuteNum = parseInt(get('minute'), 10);

  return {
    dateStr: `${year}-${month}-${day}`,
    dayOfWeek: WEEKDAY_MAP[weekdayStr] ?? 0,
    hour: Number.isFinite(hourNum) ? hourNum % 24 : 0,
    minute: Number.isFinite(minuteNum) ? minuteNum : 0,
  };
}

export function shouldSendWeeklyReportNow(
  local: LocalScheduleParts,
  config: WeeklyReportScheduleConfig,
  lastSentDate: string | null
): boolean {
  if (!config.enabled) return false;
  if (local.dayOfWeek !== config.dayOfWeek) return false;
  if (lastSentDate === local.dateStr) return false;

  const reachedTargetTime =
    local.hour > config.hour ||
    (local.hour === config.hour && local.minute >= config.minute);

  return reachedTargetTime;
}

export async function triggerWeeklyReportNow(opts?: {
  markScheduledSent?: boolean;
}): Promise<{ success: true; sentAt: string; userCount: number; totalPlays: number }> {
  if (isSendingReport) {
    throw new Error('Отправка отчёта уже выполняется, подождите завершения');
  }

  isSendingReport = true;
  try {
    const config = getWeeklyReportConfig();
    const report = getListeningReportData(7, config.timezone);
    await sendWeeklyListeningReport(report);

    const now = new Date();
    const sentAtIso = now.toISOString();
    setAppSetting(SETTING_LAST_SENT_AT, sentAtIso);
    setAppSetting(SETTING_LAST_ERROR, '');

    if (opts?.markScheduledSent) {
      const local = getLocalScheduleParts(now, config.timezone);
      setAppSetting(SETTING_LAST_SENT_DATE, local.dateStr);
    }

    console.log(
      `[Weekly Report] Report sent successfully (users: ${report.summary.totalUsers}, totalPlays: ${report.summary.totalPlaysAllUsers}, scheduled: ${Boolean(opts?.markScheduledSent)}).`
    );

    return {
      success: true,
      sentAt: sentAtIso,
      userCount: report.summary.totalUsers,
      totalPlays: report.summary.totalPlaysAllUsers,
    };
  } catch (err: any) {
    const safeMsg = String(err?.message || 'Ошибка отправки письма').slice(0, 300);
    setAppSetting(SETTING_LAST_ERROR, safeMsg);
    throw err;
  } finally {
    isSendingReport = false;
  }
}

export async function checkAndSendWeeklyReport(): Promise<void> {
  if (isSendingReport) return;

  const config = getWeeklyReportConfig();
  if (!config.enabled) return;

  const now = new Date();
  const local = getLocalScheduleParts(now, config.timezone);
  const lastSentDate = getAppSetting(SETTING_LAST_SENT_DATE);

  if (!shouldSendWeeklyReportNow(local, config, lastSentDate)) {
    return;
  }

  if (!isEmailConfigured()) {
    // Do not spam logs every minute when SMTP is intentionally not configured yet
    if (failureDateStr !== local.dateStr) {
      failureDateStr = local.dateStr;
      console.warn('[Weekly Report] Scheduled time reached, but SMTP/WEEKLY_REPORT_TO is not configured in .env.');
    }
    return;
  }

  // Respect retry cooldown & daily retry cap on transient SMTP errors
  if (failureDateStr === local.dateStr) {
    if (failureCountToday >= MAX_DAILY_RETRIES) return;
    if (Date.now() - lastFailureAtMs < RETRY_COOLDOWN_MS) return;
  } else {
    failureDateStr = local.dateStr;
    failureCountToday = 0;
  }

  try {
    await triggerWeeklyReportNow({ markScheduledSent: true });
    failureCountToday = 0;
  } catch (err: any) {
    lastFailureAtMs = Date.now();
    failureCountToday++;
    console.error(
      `[Weekly Report] Failed to send scheduled report (attempt ${failureCountToday}/${MAX_DAILY_RETRIES}):`,
      err?.message || err
    );
  }
}

export function startWeeklyReportScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
  }

  const config = getWeeklyReportConfig();
  const timeStr = `${String(config.hour).padStart(2, '0')}:${String(config.minute).padStart(2, '0')}`;
  const dayName = DAY_NAMES_RU[config.dayOfWeek] || 'Воскресенье';

  // Initial check 15 seconds after startup (catches up if server was offline at target time)
  setTimeout(() => {
    checkAndSendWeeklyReport().catch((err) =>
      console.error('[Weekly Report Initial Check Error]:', err?.message || err)
    );
  }, 15000);

  // Periodic check every 60 seconds
  schedulerInterval = setInterval(() => {
    checkAndSendWeeklyReport().catch((err) =>
      console.error('[Weekly Report Periodic Check Error]:', err?.message || err)
    );
  }, 60 * 1000);

  console.log(
    `[Weekly Report Scheduler] Initialized (${config.enabled ? 'enabled' : 'disabled'}): ${dayName} ${timeStr} (${config.timezone}), SMTP configured: ${isEmailConfigured()}`
  );
}

export function getWeeklyReportStatus() {
  const config = getWeeklyReportConfig();
  const timeStr = `${String(config.hour).padStart(2, '0')}:${String(config.minute).padStart(2, '0')}`;
  const dayName = DAY_NAMES_RU[config.dayOfWeek] || 'Воскресенье';

  return {
    enabled: config.enabled,
    smtpConfigured: isEmailConfigured(),
    recipientMasked: getMaskedRecipient(),
    timezone: config.timezone,
    dayOfWeek: config.dayOfWeek,
    hour: config.hour,
    minute: config.minute,
    scheduleLabel: `${dayName}, ${timeStr} (${config.timezone})`,
    lastSentDate: getAppSetting(SETTING_LAST_SENT_DATE),
    lastSentAt: getAppSetting(SETTING_LAST_SENT_AT),
    lastError: getAppSetting(SETTING_LAST_ERROR) || null,
  };
}
