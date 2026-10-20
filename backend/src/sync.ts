import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';

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

function safeSend(ws: WebSocket, message: any) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      console.warn('[WS Send Error]:', err);
    }
  }
}

function broadcastToUser(userId: number, message: any, excludeDeviceId?: string) {
  const clients = userClients.get(userId);
  if (!clients) return;
  for (const [devId, client] of clients.entries()) {
    if (excludeDeviceId && devId === excludeDeviceId) continue;
    safeSend(client.ws, message);
  }
}

export function setupWebSocketSync(server: FastifyInstance) {
  const wss = new WebSocketServer({ noServer: true });

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

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, userId);
      });
    } catch (err) {
      console.error('[WS Upgrade Error]:', err);
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, req: any, userId: number) => {
    let session: ClientSession = {
      ws,
      userId,
      deviceId: '',
      deviceName: '',
      deviceType: 'desktop',
      isAlive: true,
      lastSeen: Date.now(),
    };

    ws.on('pong', () => {
      session.isAlive = true;
      session.lastSeen = Date.now();
    });

    ws.on('message', (raw: any) => {
      try {
        const data = JSON.parse(raw.toString());
        session.lastSeen = Date.now();
        const playback = getOrCreatePlayback(userId);

        switch (data.type) {
          case 'REGISTER': {
            const { deviceId, deviceName, deviceType } = data;
            if (!deviceId) return;

            session.deviceId = deviceId;
            session.deviceName = deviceName || 'Браузер';
            session.deviceType = deviceType || 'desktop';

            let clients = userClients.get(userId);
            if (!clients) {
              clients = new Map<string, ClientSession>();
              userClients.set(userId, clients);
            }
            clients.set(deviceId, session);

            // Cancel any pending disconnect timer for this user if this was active device
            if (playback.activeDeviceId === deviceId) {
              const timer = disconnectTimers.get(userId);
              if (timer) {
                clearTimeout(timer);
                disconnectTimers.delete(userId);
              }
            }

            // If no active device currently, make this device the active candidate
            if (!playback.activeDeviceId || !clients.has(playback.activeDeviceId)) {
              playback.activeDeviceId = deviceId;
              playback.activeDeviceName = session.deviceName;
            }

            // Send initial state to the registering client
            safeSend(ws, {
              type: 'SYNC_INIT',
              myDeviceId: deviceId,
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
              deviceId
            );
            break;
          }

          case 'PLAYBACK_STATE': {
            const state = data.state || {};
            const isPlayingChanged = state.isPlaying !== undefined && state.isPlaying !== playback.isPlaying;

            // If this client is playing or updates state, it claims active playback
            playback.activeDeviceId = session.deviceId;
            playback.activeDeviceName = session.deviceName;

            if (state.track !== undefined) playback.track = state.track;
            if (state.isPlaying !== undefined) playback.isPlaying = state.isPlaying;
            if (state.currentTime !== undefined) playback.currentTime = state.currentTime;
            if (state.duration !== undefined) playback.duration = state.duration;
            if (state.queue !== undefined) playback.queue = state.queue;
            if (state.originalQueue !== undefined) playback.originalQueue = state.originalQueue;
            if (state.currentIndex !== undefined) playback.currentIndex = state.currentIndex;
            if (state.shuffle !== undefined) playback.shuffle = state.shuffle;
            if (state.repeat !== undefined) playback.repeat = state.repeat;
            if (state.volume !== undefined) playback.volume = state.volume;
            playback.updatedAt = Date.now();

            // Broadcast updated playback state to all other devices
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
            const clients = userClients.get(userId);
            const activeClient = playback.activeDeviceId && clients ? clients.get(playback.activeDeviceId) : null;

            if (activeClient && activeClient.deviceId !== session.deviceId && activeClient.ws.readyState === WebSocket.OPEN) {
              // Forward command to currently active output device
              safeSend(activeClient.ws, {
                type: 'EXECUTE_COMMAND',
                action,
                value,
                fromDeviceId: session.deviceId,
              });
            } else {
              // Active device is this device or no active device: tell caller to execute locally
              safeSend(ws, {
                type: 'BECOME_ACTIVE',
                action,
                value,
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
              if (clientState.track) playback.track = clientState.track;
              if (clientState.isPlaying !== undefined) playback.isPlaying = clientState.isPlaying;
              if (clientState.currentTime !== undefined) playback.currentTime = clientState.currentTime;
              if (clientState.duration !== undefined) playback.duration = clientState.duration;
              if (clientState.queue) playback.queue = clientState.queue;
              if (clientState.originalQueue) playback.originalQueue = clientState.originalQueue;
              if (clientState.currentIndex !== undefined) playback.currentIndex = clientState.currentIndex;
              if (clientState.shuffle !== undefined) playback.shuffle = clientState.shuffle;
              if (clientState.repeat !== undefined) playback.repeat = clientState.repeat;
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
      const clients = userClients.get(userId);
      if (clients && session.deviceId) {
        clients.delete(session.deviceId);
        if (clients.size === 0) {
          userClients.delete(userId);
        }
      }

      const playback = getOrCreatePlayback(userId);
      if (playback.activeDeviceId === session.deviceId) {
        // Active device went offline. Give 6 seconds grace in case of page refresh/reconnect
        const timer = setTimeout(() => {
          disconnectTimers.delete(userId);
          const currentClients = userClients.get(userId);
          if (!currentClients || !currentClients.has(session.deviceId)) {
            playback.isPlaying = false;
            // Pick next available client as active if any exist
            if (currentClients && currentClients.size > 0) {
              const nextClient = currentClients.values().next().value;
              playback.activeDeviceId = nextClient.deviceId;
              playback.activeDeviceName = nextClient.deviceName;
            } else {
              playback.activeDeviceId = null;
              playback.activeDeviceName = null;
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
        }, 6000);
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

