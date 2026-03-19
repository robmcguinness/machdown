/// <reference types='chrome'/>
import {
  type AppMessage,
  type AppState,
  DEFAULT_STATE,
  applyDefaults,
} from '@common/appTypes';

type CSClient = { tabId: number; port: chrome.runtime.Port };
type AppClient = { port: chrome.runtime.Port };

const appClients = new Set<AppClient>();
const csByTab = new Map<number, CSClient>();

const safePostMessage = (port: chrome.runtime.Port, message: AppMessage) => {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
};

let appState: AppState = DEFAULT_STATE;
let stateLoadPromise: Promise<void> | null = null;

const ensureStateLoaded = () => {
  if (!stateLoadPromise) {
    stateLoadPromise = chrome.storage.local
      .get('appState')
      .then(({ appState: stored }) => {
        if (stored) {
          appState = applyDefaults(stored as Partial<AppState>);
        }
        return undefined;
      })
      .catch(() => {
        appState = DEFAULT_STATE;
      });
  }
  return stateLoadPromise;
};

const broadcastToApps = (message: AppMessage) => {
  for (const client of appClients) {
    if (!safePostMessage(client.port, message)) {
      appClients.delete(client);
    }
  }
};

const persistState = () => {
  void chrome.storage.local.set({ appState });
};

chrome.runtime.onConnect.addListener((port) => {
  const who = port.name;
  const tabId = port.sender?.tab?.id ?? null;

  if (who === 'app') {
    const app: AppClient = { port };
    appClients.add(app);
    //console.log('App connected, total app clients:', appClients.size);

    void ensureStateLoaded().then(() => {
      safePostMessage(port, { type: 'state:response', payload: appState });
      return undefined;
    });

    port.onMessage.addListener((message: AppMessage) => {
      if (message.type === 'state:request') {
        safePostMessage(port, { type: 'state:response', payload: appState });
        return;
      }

      if (message.type === 'state:update') {
        const incoming = applyDefaults(message.payload);
        const nextSettings = incoming.settings ?? appState.settings;
        const nextState: AppState = {
          ...appState,
          ...incoming,
          settings: nextSettings,
        };
        appState = nextState;
        persistState();
        broadcastToApps({ type: 'state:update', payload: appState });
      }
    });

    port.onDisconnect.addListener(() => {
      appClients.delete(app);
      //console.log('App disconnected, total app clients:', appClients.size);
    });
  }

  if (who === 'content-script' && tabId !== null) {
    const cs: CSClient = { tabId, port };
    csByTab.set(tabId, cs);
    //console.log(`CS connected for tab ${tabId}, total CS:`, csByTab.size);
    port.onDisconnect.addListener(() => {
      csByTab.delete(tabId);
      //console.log(`CS disconnected for tab ${tabId}, total CS:`, csByTab.size);
    });
  }
});

