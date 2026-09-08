import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useEffect, useState } from 'react';

/**
 * The registry's Toaster reads the theme from `next-themes`, which this
 * extension does not use: `watchAppSettings` toggles a `.dark` class on the
 * document element from the saved theme setting. Watch that class instead, so
 * the toasts follow an explicit Light/Dark choice and not just the OS.
 */
const useDarkClass = () => {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(root.classList.contains('dark')));
    observer.observe(root, { attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return dark;
};

export const Toaster = (props: ToasterProps) => {
  const dark = useDarkClass();

  return (
    <Sonner
      theme={dark ? 'dark' : 'light'}
      className='toaster group'
      icons={{
        success: <CircleCheckIcon className='size-4' />,
        info: <InfoIcon className='size-4' />,
        warning: <TriangleAlertIcon className='size-4' />,
        error: <OctagonXIcon className='size-4' />,
        loading: (
          <Loader2Icon className='size-4 motion-safe:animate-spin motion-reduce:animate-pulse' />
        ),
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      toastOptions={{ classNames: { toast: 'cn-toast' } }}
      {...props}
    />
  );
};
