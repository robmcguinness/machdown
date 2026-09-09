import { StatusBadge, type StatusTone } from '#components/StatusBadge.tsx';
import type { DaemonStatus as Status } from '#common/useDaemonStatus.ts';
import { cn } from '#lib/utils.ts';

type DaemonStatusProps = {
  /** `line` is the popup header's dot-and-text form; `badge` is the pill. */
  appearance?: 'badge' | 'line';
  className?: string;
  onClick?: () => void;
  status: Status;
};

/** `describe`'s result, checked with `satisfies` on each return so the
 * `tone` literals below stay `StatusTone` instead of widening to `string`
 * the way a function return-type annotation would. */
type DescribeResult = { label: string; title: string; tone: StatusTone };

/** Tailwind classes for the state dot, kept next to the tone they follow. */
const DOT_COLOR: Record<StatusTone, string> = {
  neutral: 'bg-muted-foreground',
  success: 'bg-success',
  warning: 'bg-warning',
};

const describe = (status: Status) => {
  switch (status.state) {
    case 'checking':
      return {
        label: 'Checking…',
        title: 'Contacting the Machdown daemon',
        tone: 'neutral',
      } satisfies DescribeResult;
    case 'offline':
      return {
        label: 'Daemon offline',
        title: 'Clips will be saved with the browser download dialog',
        tone: 'neutral',
      } satisfies DescribeResult;
    case 'unpaired':
      return {
        label: 'Not paired',
        title: 'Open settings to pair this extension with the daemon',
        tone: 'warning',
      } satisfies DescribeResult;
    default:
      return status.health.repo
        ? ({
            label: status.health.repo.branch,
            title: `Saving to ${status.health.repo.path}`,
            tone: 'success',
          } satisfies DescribeResult)
        : ({
            label: 'No repository',
            title: 'Paired, but no clip repository has been set up yet',
            tone: 'warning',
          } satisfies DescribeResult);
  }
};

/**
 * A one-glance answer to "where will this clip go?".
 *
 * Silent fallback to a download would be confusing, so the destination is
 * always visible even when everything is working.
 */
export const DaemonStatus = ({
  appearance = 'badge',
  className,
  onClick,
  status,
}: DaemonStatusProps) => {
  const { label, title, tone } = describe(status);

  if (appearance === 'line') {
    const connected = status.state === 'ready' && status.health.repo;

    return (
      <button
        className={cn(
          'flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground',
          onClick ? 'cursor-pointer hover:text-foreground' : 'cursor-default',
          className,
        )}
        title={title}
        type='button'
        onClick={onClick}
      >
        <span className={cn('size-1.5 shrink-0 rounded-full', DOT_COLOR[tone])} />
        <span className='truncate'>
          {connected && 'Connected · '}
          <span className='font-medium text-foreground'>{label}</span>
        </span>
      </button>
    );
  }

  return (
    <StatusBadge
      className={cn('gap-1.5 font-normal', onClick && 'cursor-pointer', className)}
      title={title}
      tone={tone}
      onClick={onClick}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          status.state === 'ready' ? 'bg-current' : 'bg-current/50',
        )}
      />
      {label}
    </StatusBadge>
  );
};
