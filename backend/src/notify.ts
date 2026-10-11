export async function checkAndNotifyUserLimit(userCount: number) {
  if (userCount >= 5) {
    const phoneIp = process.env.NOTIFY_PHONE_IP || '100.76.188.111';
    const notifyUrl = process.env.NOTIFY_PHONE_URL || `http://${phoneIp}:8080/api/notification`;
    
    console.warn(`[SECURITY / LIMIT ALERT] Registered user count has reached ${userCount} users! Sending alert to phone ${phoneIp}...`);
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      await fetch(notifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'USER_LIMIT_REACHED',
          userCount,
          message: `Внимание: в Jellyfin-Spotify зарегистрировано ${userCount} пользователей!`,
          timestamp: new Date().toISOString()
        }),
        signal: controller.signal
      }).catch(err => {
        // Silently log error without crashing the server if the phone is not running an HTTP server
        console.log(`[Notification to ${phoneIp}] Phone HTTP endpoint not responding or offline: ${err.message}`);
      });
      clearTimeout(timeoutId);
    } catch (e: any) {
      console.log(`[Notification to ${phoneIp}] Exception: ${e.message}`);
    }
  }
}
