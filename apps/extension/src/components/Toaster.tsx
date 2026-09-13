import type { ComponentProps } from 'react';
import { Toaster as RegistryToaster } from '#components/ui/sonner.tsx';
import { useSharedSettings } from '#common/useSharedSettings.ts';

/**
 * Follows the extension's own theme setting, not `next-themes`. Sonner resolves
 * `system` against the OS itself. The registry Toaster spreads its props after
 * its own `theme`, so this `theme` wins.
 */
export const Toaster = (props: ComponentProps<typeof RegistryToaster>) => {
  const { settings } = useSharedSettings();

  return <RegistryToaster theme={settings.theme} {...props} />;
};
