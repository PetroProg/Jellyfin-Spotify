import nodemailer from 'nodemailer';
import { db } from './db';

export function getSmtpConfig() {
  const host = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('smtp_host') as any;
  const port = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('smtp_port') as any;
  const user = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('smtp_user') as any;
  const pass = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('smtp_pass') as any;
  const from = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('smtp_from') as any;

  return {
    host: host?.value || process.env.SMTP_HOST || '',
    port: Number(port?.value || process.env.SMTP_PORT) || 465,
    user: user?.value || process.env.SMTP_USER || '',
    pass: pass?.value || process.env.SMTP_PASS || '',
    from: from?.value || process.env.SMTP_FROM || 'Jellyfin Spotify <noreply@tail703e6c.ts.net>',
    secure: (port?.value || process.env.SMTP_PORT) === '465' || !port?.value,
  };
}

export async function sendWelcomeEmail(toEmail: string, displayName: string, username: string) {
  if (!toEmail) return;

  const config = getSmtpConfig();

  // If no SMTP configured, log friendly message
  if (!config.host || !config.user || !config.pass) {
    console.log(`[EMAIL NOTICE] Приветственное письмо для ${toEmail} (@${username}): SMTP не настроен в Настройках. Письмо смоделировано.`);
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #11111b; color: #cdd6f4; margin: 0; padding: 20px; }
        .container { max-width: 560px; margin: 0 auto; background-color: #1e1e2e; border-radius: 24px; padding: 32px; border: 1px solid #313244; }
        .badge { background: rgba(203, 166, 247, 0.2); color: #cba6f7; display: inline-block; padding: 6px 14px; border-radius: 9999px; font-weight: bold; font-size: 12px; margin-bottom: 16px; }
        h1 { color: #cdd6f4; font-size: 24px; margin-top: 0; }
        p { color: #a6adc8; line-height: 1.6; font-size: 14px; }
        .button { display: inline-block; background-color: #cba6f7; color: #11111b; text-decoration: none; font-weight: bold; padding: 12px 28px; border-radius: 9999px; margin: 20px 0; font-size: 14px; }
        .footer { border-top: 1px solid #313244; margin-top: 24px; padding-top: 16px; font-size: 11px; color: #6c7086; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="badge">Jellyfy</div>
        <h1>Добро пожаловать в Jellyfy, ${displayName}! 🎵</h1>
        <p>Ваш персональный аккаунт <strong>@${username}</strong> успешно создан в медиатеке.</p>
        <p>Теперь вам доступны:</p>
        <ul>
          <li>Импорт любимых плейлистов из Spotify в один клик.</li>
          <li>Безупречное качество звука без транскодирования.</li>
          <li>Оффлайн-сохранение музыки на смартфон.</li>
          <li>Умный режим рекомендаций (Smart Shuffle).</li>
        </ul>
        <a href="https://petroprog.tail703e6c.ts.net:10443" class="button">Открыть Jellyfy</a>
        <div class="footer">
          Jellyfy (Catppuccin Edition) • Доступно только в вашей сети Tailscale
        </div>
      </div>
    </body>
    </html>
    `;

    await transporter.sendMail({
      from: config.from,
      to: toEmail,
      subject: `Добро пожаловать в Jellyfy, ${displayName}! 🎧`,
      html: htmlContent,
    });

    console.log(`[EMAIL] Приветственное письмо успешно отправлено на ${toEmail}`);
  } catch (err: any) {
    console.warn(`[EMAIL ERROR] Не удалось отправить письмо на ${toEmail}: ${err.message}`);
  }
}
