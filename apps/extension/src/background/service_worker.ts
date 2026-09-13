/// <reference types='chrome'/>
import { type AppMessage, type AppState, DEFAULT_STATE, applyDefaults } from '#common/appTypes.ts';
import { runAsync } from '#lib/async.ts';

type CSClient = { port: chrome.runtime.Port; tabId: number };
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

const loadState = async (): Promise<void> => {
  try {
    const { appState: stored } = await chrome.storage.local.get('appState');
    if (stored) {
      appState = applyDefaults(stored);
    }
  } catch {
    appState = DEFAULT_STATE;
  }
};

const ensureStateLoaded = (): Promise<void> => {
  stateLoadPromise ??= loadState();
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
  runAsync(() => chrome.storage.local.set({ appState }));
};

chrome.runtime.onConnect.addListener((port) => {
  const who = port.name;
  const tabId = port.sender?.tab?.id ?? null;

  if (who === 'app') {
    const app: AppClient = { port };
    appClients.add(app);
    //console.log('App connected, total app clients:', appClients.size);

    runAsync(async () => {
      await ensureStateLoaded();
      safePostMessage(port, { payload: appState, type: 'state:response' });
    });

    port.onMessage.addListener((message: AppMessage) => {
      if (message.type === 'state:request') {
        safePostMessage(port, { payload: appState, type: 'state:response' });
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
        broadcastToApps({ payload: appState, type: 'state:update' });
      }
    });

    port.onDisconnect.addListener(() => {
      appClients.delete(app);
      //console.log('App disconnected, total app clients:', appClients.size);
    });
  }

  if (who === 'content-script' && tabId !== null) {
    const cs: CSClient = { port, tabId };
    csByTab.set(tabId, cs);
    //console.log(`CS connected for tab ${tabId}, total CS:`, csByTab.size);
    port.onDisconnect.addListener(() => {
      csByTab.delete(tabId);
      //console.log(`CS disconnected for tab ${tabId}, total CS:`, csByTab.size);
    });
  }
});
