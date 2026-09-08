import { type AppSettings, type AppState, DEFAULT_STATE } from './appTypes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAppBridge } from './appBridge';
import { watchAppSettings } from './appSettings';

type SharedSettingsState = {
  setSettings: (patch: Partial<AppSettings>) => void;
  settings: AppSettings;
};

export const useSharedSettings = (): SharedSettingsState => {
  const bridge = useMemo(() => getAppBridge(), []);
  const [state, setState] = useState<AppState>(DEFAULT_STATE);
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
    setSettings,
    settings: state.settings,
  };
};
