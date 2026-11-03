import { getToken } from '../api/client';

export interface OutboxMutation {
  id: string;
  type: string;
  endpoint: string;
  method: 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: any;
  coalesceKey?: string;
  createdAt: number;
  attempts: number;
  lastAttemptAt?: number;
}

const OUTBOX_STORAGE_KEY = 'jellyfy_action_outbox_v1';
let memoryQueue: OutboxMutation[] | null = null;
let isDraining = false;
let drainTimer: any = null;

function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
}

export function loadOutbox(): OutboxMutation[] {
  if (memoryQueue !== null) return memoryQueue;
  if (typeof window === 'undefined') return [];

  try {
    const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        memoryQueue = parsed;
        return memoryQueue;
      }
    }
  } catch (err) {
    console.warn('[Outbox] Failed to load outbox from localStorage:', err);
  }

  memoryQueue = [];
  return memoryQueue;
}

function saveOutbox(queue: OutboxMutation[]): void {
  memoryQueue = queue;
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(queue));
    notifyOutboxChange();
  } catch (err) {
    console.warn('[Outbox] Failed to save outbox to localStorage:', err);
  }
}

export function getPendingOutboxCount(): number {
  return loadOutbox().length;
}

const listeners = new Set<(count: number) => void>();

export function subscribeOutbox(callback: (count: number) => void): () => void {
  listeners.add(callback);
  callback(getPendingOutboxCount());
  return () => {
    listeners.delete(callback);
  };
}

function notifyOutboxChange(): void {
  const count = getPendingOutboxCount();
  listeners.forEach((cb) => {
    try {
      cb(count);
    } catch (_) {}
  });

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('jellyfy:outbox_changed', { detail: { count } }));
  }

  // Schedule background drain if there are pending actions
  if (count > 0 && !drainTimer) {
    scheduleNextDrain(3000);
  }
}

/**
 * Enqueues a mutating action to be sent to the backend with guaranteed delivery.
 * If coalesceKey is specified (e.g. `like_track_3589` or `reorder_9`), previous pending
 * actions with the same key are merged/replaced so only the latest state is sent.
 */
export async function enqueueOutboxMutation(
  action: Omit<OutboxMutation, 'id' | 'createdAt' | 'attempts'>
): Promise<void> {
  const queue = loadOutbox();
  const newAction: OutboxMutation = {
    ...action,
    id: generateId(),
    createdAt: Date.now(),
    attempts: 0,
  };

  let nextQueue: OutboxMutation[];
  if (action.coalesceKey) {
    // Replace any existing queued action with the same coalesceKey
    const filtered = queue.filter((item) => item.coalesceKey !== action.coalesceKey);
    nextQueue = [...filtered, newAction];
  } else {
    nextQueue = [...queue, newAction];
  }

  saveOutbox(nextQueue);

  // If online, attempt immediate background flush
  if (typeof navigator === 'undefined' || navigator.onLine) {
    drainOutbox().catch(() => {});
  }
}

/**
 * Drains the outbox by processing queued actions sequentially.
 * Guarantees zero "server request timeout" errors to the user.
 */
export async function drainOutbox(): Promise<void> {
  if (isDraining) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return;
  }

  const queue = loadOutbox();
  if (queue.length === 0) return;

  isDraining = true;
  try {
    while (queue.length > 0) {
      const current = queue[0];
      const token = getToken();

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz) headers['X-Timezone'] = tz;
      } catch (_) {}

      try {
        const endpoint = current.endpoint.startsWith('/') ? current.endpoint : `/${current.endpoint}`;
        const url = `/api${endpoint}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);

        const res = await fetch(url, {
          method: current.method,
          headers,
          body: current.body !== undefined ? JSON.stringify(current.body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        // 2xx Success (or 404 for idempotent deletes/unlikes) -> Action completed!
        if (res.ok || (res.status === 404 && (current.method === 'DELETE' || current.type.includes('REMOVE')))) {
          queue.shift();
          saveOutbox([...queue]);
          continue;
        }

        // 401 Unauthorized -> Wait until user logs in
        if (res.status === 401) {
          console.warn('[Outbox] Pausing outbox sync: user not authenticated (401)');
          break;
        }

        // 4xx Client error (e.g. 400 Bad Request or invalid data) -> drop faulty action to avoid getting stuck
        if (res.status >= 400 && res.status < 500) {
          console.warn(`[Outbox] Dropping unrecoverable client error action (${res.status}):`, current);
          queue.shift();
          saveOutbox([...queue]);
          continue;
        }

        // 5xx Server error -> transient, retry later with backoff
        current.attempts = (current.attempts || 0) + 1;
        current.lastAttemptAt = Date.now();
        saveOutbox([...queue]);
        scheduleNextDrain(Math.min(30000, 2000 * Math.pow(1.5, current.attempts)));
        break;
      } catch (err: any) {
        // Network offline, DNS failure or request timed out
        current.attempts = (current.attempts || 0) + 1;
        current.lastAttemptAt = Date.now();
        saveOutbox([...queue]);

        const delay = Math.min(30000, 2500 * Math.pow(1.4, Math.min(current.attempts, 6)));
        scheduleNextDrain(delay);
        break;
      }
    }
  } finally {
    isDraining = false;
  }
}

function scheduleNextDrain(delayMs: number): void {
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = setTimeout(() => {
    drainTimer = null;
    drainOutbox().catch(() => {});
  }, delayMs);
}

// Auto-initialize background synchronization listeners
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    drainOutbox().catch(() => {});
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      drainOutbox().catch(() => {});
    }
  });

  // Check on app load if there are pending actions from previous session
  setTimeout(() => {
    if (getPendingOutboxCount() > 0) {
      drainOutbox().catch(() => {});
    }
  }, 1500);
}
