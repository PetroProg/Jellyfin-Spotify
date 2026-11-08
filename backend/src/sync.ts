import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { db } from './db';

export interface DeviceInfo {
  id: string;
  name: string;
  type: 'desktop' | 'mobile' | 'tablet';
  lastSeen: number;
  isActive: boolean;
}

export interface PlaybackState {
  activeDeviceId: string | null;
  activeDeviceName: string | null;
  track: any | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  queue: any[];
  originalQueue: any[];
  currentIndex: number;
  shuffle: boolean;
  repeat: string;
  volume: number;
  updatedAt: number;
}

interface ClientSession {
  ws: WebSocket;
  userId: number;
  deviceId: string;
  deviceName: string;
  deviceType: 'desktop' | 'mobile' | 'tablet';
  isAlive: boolean;
  lastSeen: number;
}

// Map: userId -> Map<deviceId, ClientSession>
const userClients = new Map<number, Map<string, ClientSession>>();

// Map: userId -> PlaybackState
const userPlayback = new Map<number, PlaybackState>();

// Active device disconnect grace timeouts
const disconnectTimers = new Map<number, NodeJS.Timeout>();

// Unregistered pending connections per user (max 10)
const unregisteredClients = new Map<number, Set<WebSocket>>();

function getOrCreatePlayback(userId: number): PlaybackState {
  let state = userPlayback.get(userId);
  if (!state) {
    state = {
      activeDeviceId: null,
      activeDeviceName: null,
      track: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      queue: [],
      originalQueue: [],
      currentIndex: -1,
      shuffle: false,
      repeat: 'off',
      volume: 1,
      updatedAt: Date.now(),
    };
    userPlayback.set(userId, state);
  }
  return state;
}

function getDeviceList(userId: number): DeviceInfo[] {
  const clients = userClients.get(userId);
  if (!clients) return [];
  const playback = getOrCreatePlayback(userId);
  const now = Date.now();
  const list: DeviceInfo[] = [];

  for (const client of clients.values()) {
    if (client.deviceId) {
      list.push({
        id: client.deviceId,
        name: client.deviceName || 'Устройство',
        type: client.deviceType || 'desktop',
        lastSeen: client.lastSeen || now,
        isActive: client.deviceId === playback.activeDeviceId,
      });
    }
  }

  return list;
}

function sanitizePlaybackTrack(track: any): any {
  if (!track || typeof track !== 'object') return null;
  return {
    id: track.id,
    title: typeof track.title === 'string' ? track.title.slice(0, 200) : '',
    artist: typeof track.artist === 'string' ? track.artist.slice(0, 200) : '',
    album: typeof track.album === 'string' ? track.album.slice(0, 200) : '',
    duration_ms: typeof track.duration_ms === 'number' ? track.duration_ms : 0,
    cover_url: typeof track.cover_url === 'string' ? track.cover_url.slice(0, 2048) : '',
    spotify_id: typeof track.spotify_id === 'string' ? track.spotify_id.slice(0, 64) : undefined,
    isPreview: Boolean(track.isPreview)
  };
}

function sanitizePlaybackQueue(queue: any[]): any[] {
  if (!Array.isArray(queue)) return [];
  return queue.slice(0, 500).map(sanitizePlaybackTrack).filter(Boolean);
}

function safeSend(ws: WebSocket, message: any) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      console.warn('[WS Send Error]:', err);
    }
  }
}

export function broadcastToUser(userId: number, message: any, excludeDeviceId?: string) {
  const clients = userClients.get(userId);
  if (!clients) return;
  for (const [devId, client] of clients.entries()) {
    if (excludeDeviceId && devId === excludeDeviceId) continue;
    safeSend(client.ws, message);
  }
}

export function setupWebSocketSync(server: FastifyInstance) {
  const wss = new WebSocketServer({ 
    noServer: true,
    maxPayload: 512 * 1024 // 512 KB maximum frame/message payload to prevent OOM
  });

  server.server.on('upgrade', (request, socket, head) => {
    try {
      const host = request.headers.host || 'localhost';
      const url = new URL(request.url || '', `http://${host}`);

      if (url.pathname !== '/api/ws') {
        return; // Let other handlers (or not found) deal with it
      }

      const token = url.searchParams.get('token');
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      let decoded: any;
      try {
        decoded = (server as any).jwt.verify(token);
      } catch (err) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const userId = decoded.id;
      if (!userId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Check if user still exists in DB
      const userExists = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
      if (!userExists) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, userId);
      });
    } catch (err) {
      console.error('[WS Upgrade Error]:', err);
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, req: any, userId: number) => {
    // Limit pending unregistered WebSocket connections per user to 10
    let unreg = unregisteredClients.get(userId);
    if (!unreg) {
      unreg = new Set<WebSocket>();
      unregisteredClients.set(userId, unreg);
    }
    if (unreg.size >= 10) {
      try { ws.close(1008, 'Too many pending connections'); } catch (_) {}
      return;
    }
    unreg.add(ws);

    let session: ClientSession = {
      ws,
      userId,
      deviceId: '',
      deviceName: '',
      deviceType: 'desktop',
      isAlive: true,
      lastSeen: Date.now(),
    };

    const regTimeout = setTimeout(() => {
      if (!session.deviceId) {
        const u = unregisteredClients.get(userId);
        if (u) {
          u.delete(ws);
          if (u.size === 0) unregisteredClients.delete(userId);
        }
        try { ws.close(4001, 'Registration timeout'); } catch (_) {}
      }
    }, 15000);

    let messageCount = 0;
    let messageWindowStart = Date.now();

    ws.on('pong', () => {
      session.isAlive = true;
      session.lastSeen = Date.now();
    });

    ws.on('message', (raw: any) => {
      // Message flood limiter: max 60 messages per second per WebSocket
      const now = Date.now();
      if (now - messageWindowStart > 1000) {
        messageWindowStart = now;
        messageCount = 0;
      }
      messageCount++;
      if (messageCount > 60) {
        if (messageCount === 61) {
          console.warn(`[WS Throttling] User ${userId} device ${session.deviceId || 'unknown'} exceeded 60 msgs/sec`);
        }
        return;
      }

      try {
        const data = JSON.parse(raw.toString());
        session.lastSeen = Date.now();

        if (!session.deviceId && data.type !== 'REGISTER' && data.type !== 'PING') {
          return;
        }

        const playback = getOrCreatePlayback(userId);

        switch (data.type) {
          case 'REGISTER': {
            clearTimeout(regTimeout);
            const u = unregisteredClients.get(userId);
            if (u) {
              u.delete(ws);
              if (u.size === 0) unregisteredClients.delete(userId);
            }
            const { deviceId, deviceName, deviceType, hasActivePlayback } = data;
            if (!deviceId || typeof deviceId !== 'string') return;

            const cleanDeviceId = String(deviceId).trim().slice(0, 64);
            const cleanDeviceName = String(deviceName || 'Устройство').trim().slice(0, 64);
            const cleanDeviceType = (['desktop', 'mobile', 'tablet'].includes(deviceType) ? deviceType : 'desktop') as 'desktop' | 'mobile' | 'tablet';

            session.deviceId = cleanDeviceId;
            session.deviceName = cleanDeviceName;
            session.deviceType = cleanDeviceType;

            let clients = userClients.get(userId);
            if (!clients) {
              clients = new Map<string, ClientSession>();
              userClients.set(userId, clients);
            }

            // If an older connection exists for this deviceId, cleanly terminate it
            const existingSession = clients.get(cleanDeviceId);
            if (existingSession && existingSession.ws !== ws) {
              try {
                existingSession.ws.close(1000, 'Replaced by new connection');
              } catch (_) {}
            }

            // Limit concurrent devices per user to 15 to prevent memory exhaustion
            if (!clients.has(cleanDeviceId) && clients.size >= 15) {
              const oldestId = clients.keys().next().value;
              if (oldestId) {
                const oldSession = clients.get(oldestId);
                if (oldSession) {
                  try { oldSession.ws.close(1008, 'Max devices exceeded'); } catch (_) {}
                }
                clients.delete(oldestId);
              }
            }

            clients.set(cleanDeviceId, session);

            // Cancel any pending disconnect timer for this user if this was active device
            if (playback.activeDeviceId === cleanDeviceId || hasActivePlayback) {
              const timer = disconnectTimers.get(userId);
              if (timer) {
                clearTimeout(timer);
                disconnectTimers.delete(userId);
              }
              playback.activeDeviceId = cleanDeviceId;
              playback.activeDeviceName = session.deviceName;
            }

            // If no active device currently, make this device the active candidate
            if (!playback.activeDeviceId) {
              playback.activeDeviceId = cleanDeviceId;
              playback.activeDeviceName = session.deviceName;
            }

            // Send initial state to the registering client
            safeSend(ws, {
              type: 'SYNC_INIT',
              myDeviceId: cleanDeviceId,
              activeDeviceId: playback.activeDeviceId,
              activeDeviceName: playback.activeDeviceName,
              devices: getDeviceList(userId),
              playback: playback,
            });

            // Notify other clients about the new/updated device list
            broadcastToUser(
              userId,
              {
                type: 'DEVICES_CHANGED',
                activeDeviceId: playback.activeDeviceId,
                activeDeviceName: playback.activeDeviceName,
                devices: getDeviceList(userId),
              },
              cleanDeviceId
            );
            break;
          }

          case 'PLAYBACK_STATE': {
            const state = data.state || {};
            const isPlayingChanged = state.isPlaying !== undefined && state.isPlaying !== playback.isPlaying;
            const isShuffleChanged = state.shuffle !== undefined && state.shuffle !== playback.shuffle;
            const isRepeatChanged = state.repeat !== undefined && state.repeat !== playback.repeat;
            const hasStructuralChange =
              state.track !== undefined ||
              state.queue !== undefined ||
              state.originalQueue !== undefined ||
              isShuffleChanged ||
              isRepeatChanged;

            // If this client is playing or updates state, it claims active playback
            playback.activeDeviceId = session.deviceId;
            playback.activeDeviceName = session.deviceName;

            if (state.track !== undefined) playback.track = sanitizePlaybackTrack(state.track);
            if (state.isPlaying !== undefined) playback.isPlaying = Boolean(state.isPlaying);
            if (state.currentTime !== undefined) playback.currentTime = typeof state.currentTime === 'number' ? state.currentTime : 0;
            if (state.duration !== undefined) playback.duration = typeof state.duration === 'number' ? state.duration : 0;
            if (state.queue !== undefined) {
              playback.queue = sanitizePlaybackQueue(state.queue);
            }
            if (state.originalQueue !== undefined) {
              playback.originalQueue = sanitizePlaybackQueue(state.originalQueue);
            }
            if (state.currentIndex !== undefined) {
              playback.currentIndex = typeof state.currentIndex === 'number' && Number.isInteger(state.currentIndex)
                ? Math.max(-1, Math.min(10000, state.currentIndex))
                : -1;
            }
            if (state.shuffle !== undefined) {
              playback.shuffle = Boolean(state.shuffle);
            }
            if (state.repeat !== undefined) {
              playback.repeat = ['off', 'all', 'one'].includes(String(state.repeat)) ? String(state.repeat) : 'off';
            }
            if (state.volume !== undefined) {
              playback.volume = typeof state.volume === 'number' && !isNaN(state.volume)
                ? Math.max(0, Math.min(1, state.volume))
                : 1;
            }
            playback.updatedAt = Date.now();

            if (hasStructuralChange) {
              // Full structural state update (track changed, queue modified, shuffle/repeat toggled)
              broadcastToUser(
                userId,
                {
                  type: 'PLAYBACK_UPDATE',
                  activeDeviceId: playback.activeDeviceId,
                  activeDeviceName: playback.activeDeviceName,
                  state: playback,
                },
                session.deviceId
              );
            } else {
              // High-frequency lightweight progress tick (~100 bytes vs ~100 KB, saving 99% WS bandwidth)
              broadcastToUser(
                userId,
                {
                  type: 'PLAYBACK_TICK',
                  activeDeviceId: playback.activeDeviceId,
                  activeDeviceName: playback.activeDeviceName,
                  currentTime: playback.currentTime,
                  duration: playback.duration,
                  isPlaying: playback.isPlaying,
                  currentIndex: playback.currentIndex,
                  volume: playback.volume,
                  updatedAt: playback.updatedAt,
                },
                session.deviceId
              );
            }

            if (isPlayingChanged) {
              broadcastToUser(userId, {
                type: 'DEVICES_CHANGED',
                activeDeviceId: playback.activeDeviceId,
                activeDeviceName: playback.activeDeviceName,
                devices: getDeviceList(userId),
              });
            }
            break;
          }

          case 'REMOTE_COMMAND': {
            const { action, value } = data;
            if (typeof action !== 'string' || action.length > 50 || !/^[a-zA-Z0-9_-]+$/.test(action)) {
              return;
            }
            let safeValue: any = undefined;
            if (value !== undefined) {
              if (typeof value === 'number') {
                if (!isNaN(value)) safeValue = value;
              } else if (typeof value === 'boolean') {
                safeValue = value;
              } else if (typeof value === 'string') {
                safeValue = value.slice(0, 100);
              }
            }
            const clients = userClients.get(userId);
            const activeClient = playback.activeDeviceId && clients ? clients.get(playback.activeDeviceId) : null;

            if (activeClient && activeClient.deviceId !== session.deviceId && activeClient.ws.readyState === WebSocket.OPEN) {
              // Forward command to currently active output device
              safeSend(activeClient.ws, {
                type: 'EXECUTE_COMMAND',
                action,
                value: safeValue,
                fromDeviceId: session.deviceId,
              });
            } else {
              // Active device is this device or no active device: tell caller to execute locally
              safeSend(ws, {
                type: 'BECOME_ACTIVE',
                action,
                value: safeValue,
              });
            }
            break;
          }

          case 'TRANSFER_PLAYBACK': {
            const { targetDeviceId, state: clientState } = data;
            if (!targetDeviceId) return;

            const clients = userClients.get(userId);
            if (!clients) return;
            const targetClient = clients.get(targetDeviceId);
            if (!targetClient) {
              safeSend(ws, {
                type: 'DEVICES_CHANGED',
                activeDeviceId: playback.activeDeviceId,
                activeDeviceName: playback.activeDeviceName,
                devices: getDeviceList(userId),
              });
              return;
            }

            const oldActiveId = playback.activeDeviceId;
            const oldClient = oldActiveId ? clients.get(oldActiveId) : null;

            // Merge incoming state from client if provided
            if (clientState) {
              if (clientState.track !== undefined) playback.track = sanitizePlaybackTrack(clientState.track);
              if (clientState.isPlaying !== undefined) playback.isPlaying = Boolean(clientState.isPlaying);
              if (clientState.currentTime !== undefined) playback.currentTime = typeof clientState.currentTime === 'number' ? clientState.currentTime : 0;
              if (clientState.duration !== undefined) playback.duration = typeof clientState.duration === 'number' ? clientState.duration : 0;
              if (clientState.queue !== undefined) {
                playback.queue = sanitizePlaybackQueue(clientState.queue);
              }
              if (clientState.originalQueue !== undefined) {
                playback.originalQueue = sanitizePlaybackQueue(clientState.originalQueue);
              }
              if (clientState.currentIndex !== undefined) {
                playback.currentIndex = typeof clientState.currentIndex === 'number' && Number.isInteger(clientState.currentIndex)
                  ? Math.max(-1, Math.min(10000, clientState.currentIndex))
                  : -1;
              }
              if (clientState.shuffle !== undefined) {
                playback.shuffle = Boolean(clientState.shuffle);
              }
              if (clientState.repeat !== undefined) {
                playback.repeat = ['off', 'all', 'one'].includes(String(clientState.repeat)) ? String(clientState.repeat) : 'off';
              }
            } else if (playback.isPlaying && playback.updatedAt) {
              // Interpolate current playhead if client didn't supply state
              const elapsed = (Date.now() - playback.updatedAt) / 1000;
              if (elapsed > 0 && elapsed < 3600) {
                playback.currentTime = Math.min(playback.duration || 99999, playback.currentTime + elapsed);
              }
            }
            playback.updatedAt = Date.now();

            // Stop local sound on old active device
            if (oldClient && oldActiveId !== targetDeviceId) {
              safeSend(oldClient.ws, {
                type: 'STOP_LOCAL_PLAYBACK',
              });
            }

            // Set new active device
            playback.activeDeviceId = targetDeviceId;
            playback.activeDeviceName = targetClient.deviceName;

            // Start local sound on new active device
            safeSend(targetClient.ws, {
              type: 'START_LOCAL_PLAYBACK',
              state: playback,
            });

            // Broadcast device and state change to all clients
            broadcastToUser(userId, {
              type: 'DEVICES_CHANGED',
              activeDeviceId: playback.activeDeviceId,
              activeDeviceName: playback.activeDeviceName,
              devices: getDeviceList(userId),
            });

            broadcastToUser(userId, {
              type: 'PLAYBACK_UPDATE',
              activeDeviceId: playback.activeDeviceId,
              activeDeviceName: playback.activeDeviceName,
              state: playback,
            });
            break;
          }

          case 'PING': {
            safeSend(ws, { type: 'PONG' });
            break;
          }
        }
      } catch (err) {
        console.warn('[WS Message Processing Error]:', err);
      }
    });

    ws.on('close', () => {
      clearTimeout(regTimeout);
      const u = unregisteredClients.get(userId);
      if (u) {
        u.delete(ws);
        if (u.size === 0) unregisteredClients.delete(userId);
      }
      const clients = userClients.get(userId);
      if (clients && session.deviceId) {
        // Only delete from active client map if this session is still the active one registered
        if (clients.get(session.deviceId) === session) {
          clients.delete(session.deviceId);
          if (clients.size === 0) {
            userClients.delete(userId);
          }
        }
      }

      const playback = getOrCreatePlayback(userId);
      if (playback.activeDeviceId === session.deviceId) {
        const existingTimer = disconnectTimers.get(userId);
        if (existingTimer) {
          clearTimeout(existingTimer);
          disconnectTimers.delete(userId);
        }
        // Active device went offline. Give 45 seconds grace in case of mobile network switch / cell tower handover
        const timer = setTimeout(() => {
          disconnectTimers.delete(userId);
          const currentClients = userClients.get(userId);
          if (!currentClients || !currentClients.has(session.deviceId)) {
            playback.isPlaying = false;
            playback.activeDeviceId = null;
            playback.activeDeviceName = null;

            // If user has zero active connections, free heavy queue memory to prevent RAM retention
            if (!currentClients || currentClients.size === 0) {
              playback.queue = [];
              playback.originalQueue = [];
            }

            broadcastToUser(userId, {
              type: 'DEVICES_CHANGED',
              activeDeviceId: playback.activeDeviceId,
              activeDeviceName: playback.activeDeviceName,
              devices: getDeviceList(userId),
            });
            broadcastToUser(userId, {
              type: 'PLAYBACK_UPDATE',
              activeDeviceId: playback.activeDeviceId,
              activeDeviceName: playback.activeDeviceName,
              state: playback,
            });
          }
        }, 45000);
        disconnectTimers.set(userId, timer);
      }

      broadcastToUser(userId, {
        type: 'DEVICES_CHANGED',
        activeDeviceId: playback.activeDeviceId,
        activeDeviceName: playback.activeDeviceName,
        devices: getDeviceList(userId),
      });
    });

    ws.on('error', (err) => {
      console.warn('[WS Client Error]:', err.message);
    });
  });

  // Heartbeat interval to prune stale connections
  const interval = setInterval(() => {
    for (const [userId, clients] of userClients.entries()) {
      for (const [deviceId, client] of clients.entries()) {
        if (!client.isAlive) {
          client.ws.terminate();
          clients.delete(deviceId);
        } else {
          client.isAlive = false;
          try {
            client.ws.ping();
          } catch (_) {}
        }
      }
      if (clients.size === 0) {
        userClients.delete(userId);
      }
    }

    // Sweep offline inactive userPlayback states older than 15 minutes to prevent RAM leaks
    const now = Date.now();
    for (const [userId, playback] of userPlayback.entries()) {
      const clients = userClients.get(userId);
      const isOnline = clients && clients.size > 0;
      if (!isOnline && !playback.isPlaying && (now - playback.updatedAt) > 15 * 60 * 1000) {
        playback.queue = [];
        playback.originalQueue = [];
        playback.track = null;
        userPlayback.delete(userId);
      }
    }
  }, 30000);

  wss.on('close', () => {
    clearInterval(interval);
  });

  console.log('[WebSocket Sync] Real-time multi-device synchronization initialized on /api/ws');
}

export function isUserOnline(userId: number): boolean {
  const clients = userClients.get(userId);
  return !!(clients && clients.size > 0);
}

export function isUserPlayingMusic(userId: number): boolean {
  const playback = userPlayback.get(userId);
  return !!(playback && playback.isPlaying);
}

export function isAnyUserPlayingMusic(): boolean {
  for (const playback of userPlayback.values()) {
    if (playback && playback.isPlaying) return true;
  }
  return false;
}

export function broadcastToAll(message: any) {
  for (const clients of userClients.values()) {
    for (const client of clients.values()) {
      safeSend(client.ws, message);
    }
  }
}

/**
 * Immediately closes and terminates all active WebSocket sessions and cached playback state
 * for a deleted or deactivated user.
 */
export function terminateUserSessions(userId: number) {
  const clients = userClients.get(userId);
  if (clients) {
    for (const client of clients.values()) {
      try {
        client.ws.close(1000, 'Session terminated');
      } catch (_) {}
    }
    userClients.delete(userId);
  }
  const pending = unregisteredClients.get(userId);
  if (pending) {
    for (const ws of pending) {
      try {
        ws.close(1000, 'Session terminated');
      } catch (_) {}
    }
    unregisteredClients.delete(userId);
  }
  userPlayback.delete(userId);
  const timer = disconnectTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(userId);
  }
}



