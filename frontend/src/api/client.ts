import { tr, td } from '../store/i18nStore';

const API_BASE = '/api';

export function getToken(): string | null {
  return localStorage.getItem('token');
}

export function setToken(token: string | null) {
  if (token) {
    localStorage.setItem('token', token);
  } else {
    localStorage.removeItem('token');
  }
}

export async function apiRequest<T = any>(
  endpoint: string,
  options: RequestInit & { timeoutMs?: number; retries?: number } = {}
): Promise<T> {
  const isGet = !options.method || options.method.toUpperCase() === 'GET';
  const maxRetries = options.retries ?? (isGet ? 2 : 0);
  let attempt = 0;

  while (true) {
    attempt++;
    const token = getToken();
    const headers: Record<string, string> = {
      ...(options.headers as any),
    };

    if (options.body) {
      headers['Content-Type'] = 'application/json';
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) {
        headers['X-Timezone'] = tz;
      }
    } catch {}

    const timeoutMs = options.timeoutMs ?? 20000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers,
        signal: options.signal || controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.status === 401) {
        setToken(null);
        window.location.href = '/login';
        const err: any = new Error(tr('Session expired, please log in again', 'Сессия истекла, авторизуйтесь снова'));
        err.status = 401;
        throw err;
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const rawErr = data.error ? td(data.error) : tr(`Server error (${res.status})`, `Ошибка сервера (${res.status})`);
        const error: any = new Error(rawErr);
        error.status = res.status;
        throw error;
      }

      return data;
    } catch (netErr: any) {
      clearTimeout(timeoutId);

      if (netErr?.status === 401 || netErr?.status === 403 || netErr?.status === 404) {
        throw netErr;
      }

      if (attempt <= maxRetries) {
        const delay = 500 * attempt;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      const offlineErr: any = new Error(
        netErr.name === 'AbortError'
          ? tr('Server request timed out', 'Таймаут запроса к серверу')
          : netErr.message || tr('Network error', 'Ошибка сети')
      );
      offlineErr.isNetworkError = true;
      offlineErr.isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      throw offlineErr;
    }
  }
}
