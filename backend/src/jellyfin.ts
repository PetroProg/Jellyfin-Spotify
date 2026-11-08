const JELLYFIN_URL = process.env.JELLYFIN_URL || 'http://jellyfin:8096';

export async function refreshJellyfinLibrary() {
  try {
    const res = await fetch(`${JELLYFIN_URL}/Library/Refresh`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(3500)
    });
    console.log(`[Jellyfin] Library refresh triggered. Status: ${res.status}`);
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
