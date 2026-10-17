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

export async function apiRequest<T = any>(endpoint: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
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

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const offlineErr: any = new Error('Отсутствует подключение к сети');
    offlineErr.isNetworkError = true;
    offlineErr.isOffline = true;
    throw offlineErr;
  }

  const timeoutMs = options.timeoutMs ?? 7000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
      signal: options.signal || controller.signal,
    });
  } catch (netErr: any) {
    const offlineErr: any = new Error(netErr.name === 'AbortError' ? 'Таймаут запроса к серверу' : (netErr.message || 'Ошибка сети'));
    offlineErr.isNetworkError = true;
    offlineErr.isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
    throw offlineErr;
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 401) {
    setToken(null);
    window.location.href = '/login';
    const err: any = new Error('Сессия истекла, авторизуйтесь снова');
    err.status = 401;
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error: any = new Error(data.error || `Ошибка сервера (${res.status})`);
    error.status = res.status;
    throw error;
  }

  return data;
}
