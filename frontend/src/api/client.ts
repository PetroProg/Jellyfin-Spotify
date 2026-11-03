import { tr, td } from '../store/i18nStore';
import { enqueueOutboxMutation } from '../utils/outbox';

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

export interface ApiRequestOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  silentOffline?: boolean;
  queueIfOffline?: boolean;
  coalesceKey?: string;
  actionType?: string;
}

/**
 * Checks whether an endpoint and method represents a persistent database mutation
 * that must be preserved and executed even if offline or timing out.
 */
function isPersistentMutationEndpoint(endpoint: string, method: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET') return false;

  const ep = endpoint.toLowerCase();
  return (
    ep.startsWith('/likes') ||
    ep.startsWith('/playlists') ||
    ep.startsWith('/blacklist') ||
    ep.startsWith('/user/settings') ||
    ep.startsWith('/settings')
  );
}

export async function apiRequest<T = any>(
  endpoint: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const isGet = method === 'GET';
  const isMutation = isPersistentMutationEndpoint(endpoint, method) || options.queueIfOffline === true;

  // 1. Immediate offline intercept for database mutations:
  // If the device is completely offline and this is a mutation, queue immediately without waiting for a timeout!
  if (!isGet && isMutation && typeof navigator !== 'undefined' && !navigator.onLine) {
    let parsedBody: any = undefined;
    if (options.body && typeof options.body === 'string') {
      try {
        parsedBody = JSON.parse(options.body);
      } catch (_) {
        parsedBody = options.body;
      }
    } else {
      parsedBody = options.body;
    }

    await enqueueOutboxMutation({
      type: options.actionType || `${method}_${endpoint.replace(/[^a-zA-Z0-9]/g, '_')}`,
      endpoint,
      method: method as any,
      body: parsedBody,
      coalesceKey: options.coalesceKey,
    });

    console.log(`[Offline-First] Queued mutation offline: ${method} ${endpoint}`);
    return {
      success: true,
      queuedOffline: true,
      offline: true,
      liked: parsedBody?.liked !== undefined ? parsedBody.liked : true,
    } as any;
  }

  const maxRetries = options.retries ?? (isGet ? 2 : 1);
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

    const timeoutMs = options.timeoutMs ?? (isGet ? 20000 : 25000);
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

      // Do not retry 4xx errors (client faults)
      if (netErr?.status && netErr.status >= 400 && netErr.status < 500) {
        throw netErr;
      }

      // Retry network failures / timeouts up to maxRetries
      if (attempt <= maxRetries) {
        const delay = 600 * attempt;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // 2. If all retries failed and this is a mutation: ABSORB INTO OUTBOX!
      // NEVER fail with an ugly "server request timed out" error toast!
      if (!isGet && isMutation && options.queueIfOffline !== false) {
        let parsedBody: any = undefined;
        if (options.body && typeof options.body === 'string') {
          try {
            parsedBody = JSON.parse(options.body);
          } catch (_) {
            parsedBody = options.body;
          }
        } else {
          parsedBody = options.body;
        }

        await enqueueOutboxMutation({
          type: options.actionType || `${method}_${endpoint.replace(/[^a-zA-Z0-9]/g, '_')}`,
          endpoint,
          method: method as any,
          body: parsedBody,
          coalesceKey: options.coalesceKey,
        });

        console.warn(`[Offline-First] Server request timed out or network dropped. Mutation preserved in Outbox: ${method} ${endpoint}`);
        return {
          success: true,
          queuedOffline: true,
          offline: true,
          liked: parsedBody?.liked !== undefined ? parsedBody.liked : true,
        } as any;
      }

      // For GET read queries or non-queueable requests
      const isAbort = netErr.name === 'AbortError';
      const offlineErr: any = new Error(
        isAbort
          ? tr('Server request timed out', 'Таймаут запроса к серверу')
          : netErr.message || tr('Network error', 'Ошибка сети')
      );
      offlineErr.isNetworkError = true;
      offlineErr.isTimeout = isAbort;
      offlineErr.isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      offlineErr.silent = Boolean(options.silentOffline);
      throw offlineErr;
    }
  }
}
