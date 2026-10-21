import { create } from 'zustand';
import { Track } from '../types';
import { useAuthStore } from './authStore';
import { usePlayerStore } from './playerStore';
import { toast } from './toastStore';
import { getToken } from '../api/client';
import { tr } from './i18nStore';

export interface ConnectedDevice {
  id: string;
  name: string;
  type: 'desktop' | 'mobile' | 'tablet';
  lastSeen: number;
  isActive: boolean;
}

interface SyncState {
  deviceId: string;
  deviceName: string;
  deviceType: 'desktop' | 'mobile' | 'tablet';
  isConnected: boolean;
  isLocalActive: boolean;
  activeDeviceId: string | null;
  activeDeviceName: string | null;
  devices: ConnectedDevice[];
  isDevicePickerOpen: boolean;

  initSync: () => void;
  disconnectSync: () => void;
  sendPlaybackState: (extra?: any) => void;
  sendRemoteCommand: (action: string, value?: any) => void;
  transferPlayback: (targetDeviceId: string) => void;
  setDevicePickerOpen: (open: boolean) => void;
  setDeviceName: (name: string) => void;
}

const STORAGE_KEY_DEVICE_ID = 'jellyfy_device_id';
const STORAGE_KEY_DEVICE_NAME = 'jellyfy_device_name';

function getOrGenerateDeviceId(): string {
  try {
    let id = localStorage.getItem(STORAGE_KEY_DEVICE_ID);
    if (!id) {
      id = 'dev_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36).slice(-4);
      localStorage.setItem(STORAGE_KEY_DEVICE_ID, id);
    }
    return id;
  } catch (_) {
    return 'dev_' + Math.random().toString(36).substring(2, 10);
  }
}

function detectDevice(): { name: string; type: 'desktop' | 'mobile' | 'tablet' } {
  try {
    const savedName = localStorage.getItem(STORAGE_KEY_DEVICE_NAME);
    const ua = navigator.userAgent || '';

    let type: 'desktop' | 'mobile' | 'tablet' = 'desktop';
    let defaultName = tr('Web Browser', 'Браузер');

    if (/iPad|Tablet/i.test(ua)) {
      type = 'tablet';
      defaultName = tr('Tablet', 'Планшет');
    } else if (/iPhone/i.test(ua)) {
      type = 'mobile';
      defaultName = 'iPhone';
    } else if (/Android/i.test(ua)) {
      type = 'mobile';
      defaultName = tr('Phone (Android)', 'Телефон (Android)');
    } else if (/Macintosh|Mac OS X/i.test(ua)) {
      type = 'desktop';
      defaultName = 'MacBook';
    } else if (/Windows NT/i.test(ua)) {
      type = 'desktop';
      defaultName = tr('PC (Windows)', 'Компьютер (Windows)');
    } else if (/Linux/i.test(ua)) {
      type = 'desktop';
      defaultName = tr('PC (Linux)', 'Компьютер (Linux)');
    }

    return {
      name: savedName && savedName.trim().length > 0 ? savedName.trim() : defaultName,
      type,
    };
  } catch (_) {
    return { name: tr('Device', 'Устройство'), type: 'desktop' };
  }
}

let wsInstance: WebSocket | null = null;
let pingInterval: any = null;
let syncThrottleTimer: any = null;
let passiveTickInterval: any = null;

export const useSyncStore = create<SyncState>((set, get) => {
  const initialDev = detectDevice();
  const initialDevId = getOrGenerateDeviceId();

  return {
    deviceId: initialDevId,
    deviceName: initialDev.name,
    deviceType: initialDev.type,
    isConnected: false,
    isLocalActive: true,
    activeDeviceId: initialDevId,
    activeDeviceName: initialDev.name,
    devices: [],
    isDevicePickerOpen: false,

    initSync: () => {
      const token = getToken();
      if (!token) return;

      if (wsInstance && (wsInstance.readyState === WebSocket.OPEN || wsInstance.readyState === WebSocket.CONNECTING)) {
        return;
      }

      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/api/ws?token=${encodeURIComponent(token)}`;
        const ws = new WebSocket(wsUrl);
        wsInstance = ws;

        ws.onopen = () => {
          set({ isConnected: true });
          const { deviceId, deviceName, deviceType } = get();
          const player = usePlayerStore.getState();
          const hasActivePlayback = Boolean(player.currentTrack && player.isPlaying);

          ws.send(
            JSON.stringify({
              type: 'REGISTER',
              deviceId,
              deviceName,
              deviceType,
              hasActivePlayback,
            })
          );

          if (pingInterval) clearInterval(pingInterval);
          pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'PING' }));
            }
          }, 20000);
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            const { deviceId } = get();

            switch (data.type) {
              case 'SYNC_INIT': {
                const { activeDeviceId, activeDeviceName, devices, playback } = data;
                const player = usePlayerStore.getState();
                const isLocallyPlaying = Boolean(player.isPlaying && player.currentTrack);

                // If this device is physically playing sound, it maintains local audio sovereignty
                const isLocal = isLocallyPlaying || (!activeDeviceId || activeDeviceId === deviceId);

                set({
                  activeDeviceId: isLocal ? deviceId : (activeDeviceId || deviceId),
                  activeDeviceName: isLocal ? get().deviceName : (activeDeviceName || get().deviceName),
                  isLocalActive: isLocal,
                  devices: devices || [],
                });

                if (isLocal && isLocallyPlaying) {
                  // Confirm to server our active playback state
                  setTimeout(() => get().sendPlaybackState(), 100);
                } else if (playback && playback.track) {
                  const currentLocal = usePlayerStore.getState().currentTrack;
                  if (!isLocal && !currentLocal) {
                    // Another device is actively playing: mirror its state onto this passive device
                    usePlayerStore.setState({
                      currentTrack: playback.track,
                      isPlaying: Boolean(playback.isPlaying),
                      currentTime: playback.currentTime || 0,
                      duration: playback.duration || 0,
                      queue: playback.queue || [playback.track],
                      originalQueue: playback.originalQueue || [playback.track],
                      currentIndex: playback.currentIndex !== undefined ? playback.currentIndex : 0,
                      shuffle: Boolean(playback.shuffle),
                      repeat: playback.repeat || 'off',
                    });
                  }
                }
                break;
              }

              case 'DEVICES_CHANGED': {
                const { activeDeviceId, activeDeviceName, devices } = data;
                const player = usePlayerStore.getState();
                const isLocallyPlaying = Boolean(player.isPlaying && player.currentTrack);
                const isLocal = isLocallyPlaying || (activeDeviceId ? activeDeviceId === deviceId : true);

                set({
                  devices: devices || [],
                  activeDeviceId: isLocal ? deviceId : (activeDeviceId || get().activeDeviceId),
                  activeDeviceName: isLocal ? get().deviceName : (activeDeviceName || get().activeDeviceName),
                  isLocalActive: isLocal,
                });
                break;
              }

              case 'PLAYBACK_UPDATE': {
                const { activeDeviceId, activeDeviceName, state } = data;
                const player = usePlayerStore.getState();
                const isLocallyPlaying = Boolean(player.isPlaying && player.currentTrack);
                const isLocal = isLocallyPlaying || activeDeviceId === deviceId;

                set({
                  activeDeviceId: isLocal ? deviceId : activeDeviceId,
                  activeDeviceName: isLocal ? get().deviceName : activeDeviceName,
                  isLocalActive: isLocal,
                });

                if (!isLocal && state && !isLocallyPlaying) {
                  // Mirror playback onto passive UI without playing local sound
                  usePlayerStore.setState({
                    currentTrack: state.track ?? null,
                    isPlaying: Boolean(state.isPlaying),
                    currentTime: state.currentTime || 0,
                    duration: state.duration || 0,
                    queue: state.queue || [],
                    originalQueue: state.originalQueue || [],
                    currentIndex: state.currentIndex ?? 0,
                    shuffle: Boolean(state.shuffle),
                    repeat: state.repeat || 'off',
                  });
                }
                break;
              }

              case 'STOP_LOCAL_PLAYBACK': {
                set({ isLocalActive: false });
                usePlayerStore.getState().stopLocalPlayback();
                break;
              }

              case 'START_LOCAL_PLAYBACK': {
                const { state } = data;
                set({ isLocalActive: true, activeDeviceId: deviceId, activeDeviceName: get().deviceName });

                if (state && state.track) {
                  const shouldPlay = state.isPlaying !== false;
                  usePlayerStore.getState().playTrackLocally(
                    state.track,
                    state.queue,
                    state.currentIndex,
                    state.currentTime,
                    shouldPlay
                  );
                  toast.success(
                    tr(`Audio switched to "${get().deviceName}"`, `Звук переключен на «${get().deviceName}»`)
                  );
                }
                break;
              }

              case 'EXECUTE_COMMAND': {
                const { action, value } = data;
                const player = usePlayerStore.getState();

                switch (action) {
                  case 'play':
                    player.resume();
                    break;
                  case 'pause':
                    player.pause();
                    break;
                  case 'togglePlay':
                    player.togglePlay();
                    break;
                  case 'next':
                    player.nextTrack();
                    break;
                  case 'prev':
                    player.prevTrack();
                    break;
                  case 'seek':
                    player.seek(Number(value));
                    break;
                  case 'volume':
                    player.setVolume(Number(value));
                    break;
                  case 'playTrack':
                    if (value && value.track) {
                      player.playTrack(value.track, value.queue, value.index);
                    }
                    break;
                  case 'shufflePlay':
                    if (value && Array.isArray(value.tracks)) {
                      player.shufflePlay(value.tracks);
                    }
                    break;
                  case 'toggleShuffle':
                    player.toggleShuffle();
                    break;
                  case 'repeat':
                    if (value) {
                      usePlayerStore.setState({ repeat: value });
                      useSyncStore.getState().sendPlaybackState({ repeat: value });
                    } else {
                      player.toggleRepeat();
                    }
                    break;
                }
                break;
              }

              case 'BECOME_ACTIVE': {
                set({ isLocalActive: true, activeDeviceId: deviceId, activeDeviceName: get().deviceName });
                const { action, value } = data;
                const player = usePlayerStore.getState();
                if (action === 'playTrack' && value?.track) {
                  player.playTrack(value.track, value.queue, value.index);
                } else if (action === 'shufflePlay' && value?.tracks) {
                  player.shufflePlay(value.tracks);
                } else if (action === 'play') {
                  player.resume();
                }
                break;
              }
            }
          } catch (err) {
            console.warn('[Sync Message Parse Error]:', err);
          }
        };

        ws.onclose = () => {
          set({ isConnected: false });
          if (pingInterval) clearInterval(pingInterval);
          // Auto-reconnect after 3 seconds if user still logged in and online
          setTimeout(() => {
            if (typeof navigator !== 'undefined' && !navigator.onLine) {
              return;
            }
            if (useAuthStore.getState().isAuthenticated) {
              get().initSync();
            }
          }, 3000);
        };

        ws.onerror = () => {
          set({ isConnected: false });
        };
      } catch (e) {
        console.warn('[WebSocket Init Error]:', e);
      }

      // Lightweight 1-second timer to advance currentTime on passive devices
      if (!passiveTickInterval) {
        passiveTickInterval = setInterval(() => {
          const { isLocalActive } = get();
          if (!isLocalActive) {
            const player = usePlayerStore.getState();
            if (player.isPlaying && player.duration > 0) {
              const nextTime = Math.min(player.duration, player.currentTime + 1);
              usePlayerStore.setState({ currentTime: nextTime });
            }
          }
        }, 1000);
      }
    },

    disconnectSync: () => {
      if (pingInterval) clearInterval(pingInterval);
      if (wsInstance) {
        try {
          wsInstance.close();
        } catch (_) {}
        wsInstance = null;
      }
      set({ isConnected: false });
    },

    sendPlaybackState: (extra?: any) => {
      const { isConnected, isLocalActive } = get();
      if (!isConnected || !wsInstance || wsInstance.readyState !== WebSocket.OPEN) return;
      if (!isLocalActive) return; // Only active output device broadcasts playback state

      if (syncThrottleTimer) clearTimeout(syncThrottleTimer);
      syncThrottleTimer = setTimeout(() => {
        const player = usePlayerStore.getState();
        const payload = {
          track: player.currentTrack,
          isPlaying: player.isPlaying,
          currentTime: player.currentTime,
          duration: player.duration,
          queue: player.queue,
          originalQueue: player.originalQueue,
          currentIndex: player.currentIndex,
          shuffle: player.shuffle,
          repeat: player.repeat,
          volume: player.volume,
          ...extra,
        };

        if (wsInstance && wsInstance.readyState === WebSocket.OPEN) {
          wsInstance.send(
            JSON.stringify({
              type: 'PLAYBACK_STATE',
              state: payload,
            })
          );
        }
      }, 50);
    },

    sendRemoteCommand: (action: string, value?: any) => {
      const { isConnected } = get();
      if (!isConnected || !wsInstance || wsInstance.readyState !== WebSocket.OPEN) {
        // Fallback to local execution if not connected
        set({ isLocalActive: true });
        const player = usePlayerStore.getState();
        if (action === 'togglePlay') player.togglePlay();
        else if (action === 'next') player.nextTrack();
        else if (action === 'prev') player.prevTrack();
        else if (action === 'seek') player.seek(Number(value));
        return;
      }

      wsInstance.send(
        JSON.stringify({
          type: 'REMOTE_COMMAND',
          action,
          value,
        })
      );
    },

    transferPlayback: (targetDeviceId: string) => {
      const { isConnected, deviceId } = get();
      if (!isConnected || !wsInstance || wsInstance.readyState !== WebSocket.OPEN) return;

      const player = usePlayerStore.getState();
      const currentState = {
        track: player.currentTrack,
        isPlaying: player.isPlaying,
        currentTime: player.currentTime,
        duration: player.duration,
        queue: player.queue,
        originalQueue: player.originalQueue,
        currentIndex: player.currentIndex,
        shuffle: player.shuffle,
        repeat: player.repeat,
      };

      if (targetDeviceId !== deviceId) {
        set({ isLocalActive: false, activeDeviceId: targetDeviceId });
        usePlayerStore.getState().stopLocalPlayback();
      } else {
        set({ isLocalActive: true, activeDeviceId: deviceId, activeDeviceName: get().deviceName });
      }

      wsInstance.send(
        JSON.stringify({
          type: 'TRANSFER_PLAYBACK',
          targetDeviceId,
          state: currentState,
        })
      );
    },

    setDevicePickerOpen: (open: boolean) => {
      set({ isDevicePickerOpen: open });
    },

    setDeviceName: (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        localStorage.setItem(STORAGE_KEY_DEVICE_NAME, trimmed);
      } catch (_) {}
      set({ deviceName: trimmed });

      const { isConnected, deviceId, deviceType } = get();
      if (isConnected && wsInstance && wsInstance.readyState === WebSocket.OPEN) {
        wsInstance.send(
          JSON.stringify({
            type: 'REGISTER',
            deviceId,
            deviceName: trimmed,
            deviceType,
          })
        );
      }
    },
  };
});

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (useAuthStore.getState().isAuthenticated) {
      useSyncStore.getState().initSync();
    }
  });
}
