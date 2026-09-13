import { type AppMessage, type AppState, DEFAULT_STATE, applyDefaults } from './appTypes.ts';

type Listener = (state: AppState) => void;

type AppBridge = {
  request: () => void;
  subscribe: (listener: Listener) => () => void;
  update: (patch: Partial<AppState>) => void;
};

const mergeState = (current: AppState, patch: Partial<AppState>): AppState => ({
  ...current,
  ...patch,
  settings: patch.settings ? { ...current.settings, ...patch.settings } : current.settings,
});

/**
 * A port to the service worker, which owns the persisted state. The worker can
 * be put to sleep between messages, so a dropped port is reconnected on the
 * next send and the state is asked for again.
 */
const createBridge = (): AppBridge => {
  let port: chrome.runtime.Port | null = null;
  let reconnectTimer: number | null = null;
  let state = DEFAULT_STATE;
  const listeners = new Set<Listener>();

  const notify = () => {
    for (const listener of listeners) {
      listener(state);
    }
  };

  const handleMessage = (message: AppMessage) => {
    if (message.type === 'state:response' || message.type === 'state:update') {
      state = applyDefaults(message.payload);
      notify();
    }
  };

  const connectPort = () => {
    if (port) {
      return port;
    }
    const nextPort = chrome.runtime.connect({ name: 'app' });
    nextPort.onMessage.addListener(handleMessage);
    nextPort.onDisconnect.addListener(() => {
      port = null;
      if (reconnectTimer !== null) {
        return;
      }
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        safePostMessage({ type: 'state:request' } satisfies AppMessage);
      }, 250);
    });
    port = nextPort;
    return nextPort;
  };

  const safePostMessage = (message: AppMessage) => {
    const activePort = connectPort();
    try {
      activePort.postMessage(message);
    } catch {
      port = null;
      const retryPort = connectPort();
      retryPort.postMessage(message);
    }
  };

  return {
    request: () => {
      safePostMessage({ type: 'state:request' } satisfies AppMessage);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (patch) => {
      state = mergeState(state, patch);
      notify();
      safePostMessage({
        payload: state,
        type: 'state:update',
      } satisfies AppMessage);
    },
  };
};

let bridge: AppBridge | null = null;

export const getAppBridge = (): AppBridge => {
  bridge ??= createBridge();
  return bridge;
};
