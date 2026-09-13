/**
 * The daemon pairing credential.
 *
 * Deliberately stored under its own `chrome.storage.local` key rather than in
 * `AppState`: the options page's "Reset to defaults" replaces the whole
 * settings object, and a token living there would be silently wiped, quietly
 * unpairing the daemon.
 */
export type DaemonPairing = {
  baseUrl: string;
  extensionId: string;
  pairedAt: string;
  token: string;
};

const STORAGE_KEY = 'machdown.daemon';

function isDaemonPairing(value: unknown): value is DaemonPairing {
  return (
    typeof value === 'object' &&
    value !== null &&
    'baseUrl' in value &&
    typeof value.baseUrl === 'string' &&
    'extensionId' in value &&
    typeof value.extensionId === 'string' &&
    'pairedAt' in value &&
    typeof value.pairedAt === 'string' &&
    'token' in value &&
    typeof value.token === 'string'
  );
}

export const loadPairing = async (): Promise<DaemonPairing | null> => {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const candidate: unknown = stored[STORAGE_KEY];
  return isDaemonPairing(candidate) ? candidate : null;
};

export const savePairing = async (pairing: DaemonPairing): Promise<void> => {
  await chrome.storage.local.set({ [STORAGE_KEY]: pairing });
};

export const clearPairing = async (): Promise<void> => {
  await chrome.storage.local.remove(STORAGE_KEY);
};

/** The extension's own ID, used to label the pairing on the daemon side. */
export const getExtensionId = (): string => chrome.runtime.id;
