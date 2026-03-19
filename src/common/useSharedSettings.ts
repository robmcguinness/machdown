import { type AppSettings, type AppState, DEFAULT_SETTINGS } from './appTypes';
import { getAppBridge } from './appBridge';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { watchAppSettings } from './appSettings';

type SharedSettingsState = {
  settings: AppSettings;
  setSettings: (patch: Partial<AppSettings>) => void;
};

export const useSharedSettings = (): SharedSettingsState => {
  const bridge = useMemo(() => getAppBridge(), []);
  const [state, setState] = useState<AppState>({
    settings: DEFAULT_SETTINGS,
  });
  const stateRef = useRef(state);

  useEffect(() => {
    const unsubscribe = bridge.subscribe((nextState) => {
      setState(nextState);
    });
    bridge.request();
    return unsubscribe;
  }, [bridge]);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => watchAppSettings(state.settings), [state.settings]);

  const setSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      const current = stateRef.current;
      bridge.update({ settings: { ...current.settings, ...patch } });
    },
    [bridge],
  );

  return {
    settings: state.settings,
    setSettings,
  };
};
