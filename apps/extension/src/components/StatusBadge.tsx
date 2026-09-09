import { type VariantProps, cva } from 'class-variance-authority';
import { Badge } from '#components/ui/badge.tsx';
import { cn } from '#lib/utils.ts';

/**
 * The neutral palette has no token for "paired but not set up" (warning) or
 * "clips have somewhere to go" (success). These live here, not in the registry
 * badge, so `shadcn add badge --overwrite` cannot remove them.
 */
export const statusToneVariants = cva('', {
  defaultVariants: { tone: 'neutral' },
  variants: {
    tone: {
      neutral: '',
      success:
        'bg-success/10 text-success focus-visible:ring-success/20 dark:bg-success/20 dark:focus-visible:ring-success/40 [a]:hover:bg-success/20',
      warning:
        'bg-warning/10 text-warning focus-visible:ring-warning/20 dark:bg-warning/20 dark:focus-visible:ring-warning/40 [a]:hover:bg-warning/20',
    },
  },
});

export type StatusTone = NonNullable<VariantProps<typeof statusToneVariants>['tone']>;

type StatusBadgeProps = Omit<React.ComponentProps<typeof Badge>, 'variant'> & { tone?: StatusTone };

/**
 * A `secondary` registry badge with a status tone on top. `cn()` is
 * tailwind-merge, so the tone classes replace the secondary background and
 * text classes.
 */
export const StatusBadge = ({ className, tone, ...props }: StatusBadgeProps) => (
  <Badge className={cn(statusToneVariants({ tone }), className)} variant='secondary' {...props} />
);
