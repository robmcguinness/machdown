import { Button } from '#components/ui/button.tsx';
import { Check } from 'lucide-react';
import { Kbd } from '#components/ui/kbd.tsx';
import type { ReactNode } from 'react';
import { cn } from '#lib/utils.ts';

export type ActionStatus = 'idle' | 'busy' | 'done';

type ActionButtonProps = Omit<React.ComponentProps<typeof Button>, 'children'> & {
  /** What the button says once the action has finished, e.g. "Saved". */
  doneLabel: string;
  icon: ReactNode;
  /** Idle label. Omit for an icon-only button. */
  label?: string;
  shortcut?: string;
  status: ActionStatus;
};

/**
 * A registry button that reports its own outcome in place: the icon spins
 * while busy, then the label gives way to a check and `doneLabel` for a beat,
 * tinted with the success tone. Feedback without a toast covering the page.
 */
export const ActionButton = ({
  className,
  disabled,
  doneLabel,
  icon,
  label,
  shortcut,
  status,
  ...props
}: ActionButtonProps) => (
  <Button
    className={cn(
      'relative overflow-hidden',
      status === 'done' &&
        'border-success/40 bg-success/15 text-success hover:bg-success/15 hover:text-success',
      className,
    )}
    aria-label={label ?? doneLabel}
    data-status={status}
    disabled={status === 'idle' ? disabled : true}
    title={label === undefined ? doneLabel : undefined}
    {...props}
  >
    <span
      className={cn(
        'inline-flex items-center gap-1 transition-all duration-150',
        status === 'done' && '-translate-y-1.5 opacity-0',
        status === 'busy' && 'opacity-60 [&>svg]:animate-spin',
      )}
    >
      {icon}
      {label}
      {shortcut && (
        <Kbd className='ml-0.5 h-4 min-w-0 bg-transparent px-0 text-current opacity-60'>
          {shortcut}
        </Kbd>
      )}
    </span>
    <span
      className={cn(
        'absolute inset-0 inline-flex items-center justify-center gap-1 transition-all duration-150',
        status === 'done' ? 'translate-y-0 opacity-100' : 'translate-y-1.5 opacity-0',
      )}
      aria-hidden={status !== 'done'}
    >
      <Check className={cn(status === 'done' && 'animate-in zoom-in-50 duration-300')} />
      {label !== undefined && doneLabel}
    </span>
  </Button>
);
