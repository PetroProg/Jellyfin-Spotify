import nodemailer from 'nodemailer';
import { formatDurationRu, type ListeningReportData } from './listeningStats';

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
}

const BASIC_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function escapeHtml(input: string): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getEmailConfig(): EmailConfig {
  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const parsedPort = parseInt(process.env.SMTP_PORT || '465', 10);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 465;

  const rawSecure = (process.env.SMTP_SECURE || '').trim().toLowerCase();
  const secure = rawSecure === 'true' ? true : rawSecure === 'false' ? false : port === 465;

  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  const to = (process.env.WEEKLY_REPORT_TO || '').trim();
  const from = (process.env.SMTP_FROM || (user ? `"Jellyfy Reports" <${user}>` : '')).trim();

  return { host, port, secure, user, pass, from, to };
}

export function isEmailConfigured(): boolean {
  const cfg = getEmailConfig();
  return Boolean(
    cfg.host &&
    cfg.user &&
    cfg.pass &&
    cfg.to &&
    BASIC_EMAIL_REGEX.test(cfg.to)
  );
}

export function getMaskedRecipient(): string {
  const to = getEmailConfig().to;
  if (!to || !to.includes('@')) return '';
  const [local, domain] = to.split('@');
  if (local.length <= 2) return `${local[0] || '*'}***@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

function formatReportDateTime(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso));
  } catch (_) {
    return new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

function formatSubjectDate(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(iso));
  } catch (_) {
    return iso.slice(0, 10);
  }
}

export function renderWeeklyReportEmail(report: ListeningReportData): {
  subject: string;
  text: string;
  html: string;
} {
  const dateLabel = formatSubjectDate(report.generatedAt, report.timezone);
  const fullDateTime = formatReportDateTime(report.generatedAt, report.timezone);
  const { summary, users } = report;

  const subject = `Jellyfy — Еженедельный отчёт прослушиваний (${dateLabel})`;

  // Plain-text version
  const textLines: string[] = [
    `Jellyfy — Еженедельный отчёт прослушиваний`,
    `Сформирован: ${fullDateTime} (${report.timezone})`,
    ``,
    `ОБЩАЯ СВОДКА:`,
    `- Пользователей: ${summary.totalUsers} (активных за ${report.periodDays} дн.: ${summary.activeUsersThisWeek})`,
    `- Всего прослушано песен: ${summary.totalPlaysAllUsers} (+${summary.weeklyPlaysAllUsers} за ${report.periodDays} дн.)`,
    `- Общее время прослушивания: ${formatDurationRu(summary.totalListenedSecAllUsers)} (+${formatDurationRu(summary.weeklyListenedSecAllUsers)} за ${report.periodDays} дн.)`,
    ``,
    `ПОЛЬЗОВАТЕЛИ:`,
  ];

  if (users.length === 0) {
    textLines.push('Зарегистрированных пользователей пока нет.');
  } else {
    users.forEach((u, idx) => {
      const displaySuffix = u.displayName && u.displayName !== u.username ? ` (${u.displayName})` : '';
      textLines.push(
        `${idx + 1}. @${u.username}${displaySuffix} — всего: ${u.totalPlays} песен (+${u.weeklyPlays} за неделю) | время: ${formatDurationRu(u.totalListenedSec)} (+${formatDurationRu(u.weeklyListenedSec)} за неделю)`
      );
      if (u.topTracks.length > 0) {
        textLines.push(`   Топ-3 трека:`);
        u.topTracks.forEach((t, tIdx) => {
          textLines.push(`     ${tIdx + 1}) ${t.artist} — ${t.title} (${t.plays}x)`);
        });
      } else {
        textLines.push(`   Топ-3 трека: пока нет прослушиваний`);
      }
    });
  }

  // HTML version (table-based layout with inline CSS for Gmail desktop/mobile compatibility)
  const userRowsHtml = users.length === 0
    ? `<tr><td colspan="4" style="padding:20px;text-align:center;color:#94a3b8;font-size:14px;">Зарегистрированных пользователей пока нет.</td></tr>`
    : users.map((u, idx) => {
        const bgColor = idx % 2 === 0 ? '#1e1e2e' : '#242436';
        const showDisplayName = u.displayName && u.displayName.trim() !== u.username.trim();
        const topTracksHtml = u.topTracks.length > 0
          ? u.topTracks
              .map(
                (t, tIdx) =>
                  `<div style="margin:2px 0;font-size:12px;line-height:1.4;color:#cdd6f4;">` +
                  `<span style="color:#cba6f7;font-weight:700;">${tIdx + 1}.</span> ` +
                  `<strong>${escapeHtml(t.artist)}</strong> — ${escapeHtml(t.title)} ` +
                  `<span style="color:#a6e3a1;font-weight:600;">(${t.plays})</span>` +
                  `</div>`
              )
              .join('')
          : `<span style="font-size:12px;color:#6c7086;">Нет прослушиваний</span>`;

        return `
          <tr style="background-color:${bgColor};border-top:1px solid #313244;">
            <td style="padding:12px 14px;vertical-align:top;">
              <div style="font-weight:700;color:#cdd6f4;font-size:14px;">@${escapeHtml(u.username)}</div>
              ${showDisplayName ? `<div style="font-size:12px;color:#a6adc8;margin-top:2px;">${escapeHtml(u.displayName)}</div>` : ''}
            </td>
            <td style="padding:12px 14px;vertical-align:top;white-space:nowrap;">
              <div style="font-weight:700;color:#f5e0dc;font-size:15px;">${u.totalPlays}</div>
              <div style="font-size:12px;color:${u.weeklyPlays > 0 ? '#a6e3a1' : '#6c7086'};margin-top:2px;">+${u.weeklyPlays} за ${report.periodDays} дн.</div>
            </td>
            <td style="padding:12px 14px;vertical-align:top;white-space:nowrap;">
              <div style="font-weight:600;color:#89b4fa;font-size:13px;">${escapeHtml(formatDurationRu(u.totalListenedSec))}</div>
              <div style="font-size:12px;color:#a6adc8;margin-top:2px;">+${escapeHtml(formatDurationRu(u.weeklyListenedSec))}</div>
            </td>
            <td style="padding:12px 14px;vertical-align:top;">
              ${topTracksHtml}
            </td>
          </tr>
        `;
      }).join('');

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#11111b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#cdd6f4;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#11111b;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:720px;background-color:#181825;border:1px solid #313244;border-radius:16px;overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="padding:24px 28px;background:linear-gradient(135deg,#313244 0%,#1e1e2e 100%);border-bottom:1px solid #313244;">
              <div style="font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#cba6f7;">Jellyfy Analytics</div>
              <h1 style="margin:6px 0 4px 0;font-size:22px;font-weight:800;color:#cdd6f4;">Еженедельный отчёт прослушиваний</h1>
              <div style="font-size:13px;color:#a6adc8;">Сформирован: ${escapeHtml(fullDateTime)} (${escapeHtml(report.timezone)})</div>
            </td>
          </tr>

          <!-- Summary Cards -->
          <tr>
            <td style="padding:20px 24px 8px 24px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td width="33.3%" style="padding:6px;">
                    <div style="background-color:#1e1e2e;border:1px solid #313244;border-radius:12px;padding:14px;">
                      <div style="font-size:11px;text-transform:uppercase;color:#a6adc8;font-weight:600;">Пользователи</div>
                      <div style="font-size:22px;font-weight:800;color:#cba6f7;margin-top:4px;">${summary.totalUsers}</div>
                      <div style="font-size:12px;color:#a6e3a1;margin-top:2px;">Активных за неделю: ${summary.activeUsersThisWeek}</div>
                    </div>
                  </td>
                  <td width="33.3%" style="padding:6px;">
                    <div style="background-color:#1e1e2e;border:1px solid #313244;border-radius:12px;padding:14px;">
                      <div style="font-size:11px;text-transform:uppercase;color:#a6adc8;font-weight:600;">Всего песен</div>
                      <div style="font-size:22px;font-weight:800;color:#f5e0dc;margin-top:4px;">${summary.totalPlaysAllUsers}</div>
                      <div style="font-size:12px;color:#a6e3a1;margin-top:2px;">+${summary.weeklyPlaysAllUsers} за ${report.periodDays} дн.</div>
                    </div>
                  </td>
                  <td width="33.3%" style="padding:6px;">
                    <div style="background-color:#1e1e2e;border:1px solid #313244;border-radius:12px;padding:14px;">
                      <div style="font-size:11px;text-transform:uppercase;color:#a6adc8;font-weight:600;">Время прослушивания</div>
                      <div style="font-size:20px;font-weight:800;color:#89b4fa;margin-top:4px;">${escapeHtml(formatDurationRu(summary.totalListenedSecAllUsers))}</div>
                      <div style="font-size:12px;color:#a6adc8;margin-top:2px;">+${escapeHtml(formatDurationRu(summary.weeklyListenedSecAllUsers))} за ${report.periodDays} дн.</div>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Per-User Table -->
          <tr>
            <td style="padding:16px 24px 24px 24px;">
              <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:#a6adc8;margin-bottom:10px;">
                Статистика по пользователям
              </div>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #313244;border-radius:12px;overflow:hidden;">
                <thead>
                  <tr style="background-color:#11111b;text-align:left;">
                    <th style="padding:10px 14px;font-size:11px;text-transform:uppercase;color:#a6adc8;font-weight:700;">Пользователь</th>
                    <th style="padding:10px 14px;font-size:11px;text-transform:uppercase;color:#a6adc8;font-weight:700;">Песен</th>
                    <th style="padding:10px 14px;font-size:11px;text-transform:uppercase;color:#a6adc8;font-weight:700;">Время</th>
                    <th style="padding:10px 14px;font-size:11px;text-transform:uppercase;color:#a6adc8;font-weight:700;">Топ-3 трека (всего)</th>
                  </tr>
                </thead>
                <tbody>
                  ${userRowsHtml}
                </tbody>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:14px 24px;background-color:#11111b;border-top:1px solid #313244;font-size:11px;color:#6c7086;text-align:center;">
              Автоматическая рассылка Jellyfy · Засчитываются треки с реальным прослушиванием от 30 сек (или 50% для коротких треков)
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text: textLines.join('\n'), html };
}

export async function sendWeeklyListeningReport(report: ListeningReportData): Promise<void> {
  const cfg = getEmailConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) {
    throw new Error('SMTP не настроен: укажите SMTP_USER и SMTP_PASS в .env');
  }
  if (!cfg.to || !BASIC_EMAIL_REGEX.test(cfg.to)) {
    throw new Error('Некорректный или пустой адрес получателя WEEKLY_REPORT_TO в .env');
  }

  const { subject, text, html } = renderWeeklyReportEmail(report);

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });

  try {
    await transporter.sendMail({
      from: cfg.from || cfg.user,
      to: cfg.to,
      subject,
      text,
      html,
    });
  } finally {
    try {
      transporter.close();
    } catch (_) {}
  }
}
