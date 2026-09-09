import type { ComponentProps } from 'react';
import { Toaster as RegistryToaster } from '#components/ui/sonner.tsx';
import { useDarkClass } from '#common/useDarkClass.ts';

/**
 * Follows the extension's own `.dark` class, not `next-themes`. The registry
 * Toaster spreads its props after its own `theme`, so this `theme` wins.
 */
export const Toaster = (props: ComponentProps<typeof RegistryToaster>) => {
  const dark = useDarkClass();

  return <RegistryToaster theme={dark ? 'dark' : 'light'} {...props} />;
};
