import { db } from './db';

const JELLYFIN_URL = process.env.JELLYFIN_URL || 'http://jellyfin:8096';
let warnedMissingApiKey = false;

function getJellyfinApiKey(): string {
  const envKey = (process.env.JELLYFIN_API_KEY || '').trim();
  if (envKey) return envKey;
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('jellyfin_api_key') as { value?: string } | undefined;
    if (row?.value && row.value.trim()) {
      return row.value.trim();
    }
  } catch (_) {}
  return '';
}

export async function refreshJellyfinLibrary() {
  const apiKey = getJellyfinApiKey();
  if (!apiKey) {
    if (!warnedMissingApiKey) {
      warnedMissingApiKey = true;
      console.warn('[Jellyfin] JELLYFIN_API_KEY is not configured; skipping /Library/Refresh to avoid 401 Unauthorized.');
    }
    return;
  }

  try {
    const res = await fetch(`${JELLYFIN_URL}/Library/Refresh`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'X-Emby-Token': apiKey
      },
      signal: AbortSignal.timeout(3500)
    });
    if (res.status === 401 || res.status === 403) {
      console.warn(`[Jellyfin] Library refresh rejected (${res.status}). Check JELLYFIN_API_KEY.`);
    } else {
      console.log(`[Jellyfin] Library refresh triggered. Status: ${res.status}`);
    }
  } catch (err: any) {
    console.warn(`[Jellyfin] Could not reach Jellyfin server for library refresh: ${err.message}`);
  }
}

export async function getJellyfinStatus() {
  try {
    const res = await fetch(`${JELLYFIN_URL}/System/Info/Public`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(3500)
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    // Return offline
  }
  return { ServerName: 'Jellyfin (Audio Core)', Version: 'Active' };
}
