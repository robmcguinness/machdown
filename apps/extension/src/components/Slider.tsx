import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import { cn } from '#lib/utils.ts';

/**
 * A single-thumb slider. The registry `ui/slider` derives its thumb count from
 * an array `value`, so the Base UI shape (a plain number) falls through to
 * `[min, max]` and renders two thumbs on top of each other. This composes the
 * primitive directly with one thumb and the registry's classes.
 */
export function Slider({ className, ...props }: SliderPrimitive.Root.Props<number>) {
  return (
    <SliderPrimitive.Root
      className={cn('data-horizontal:w-full data-vertical:h-full', className)}
      data-slot='slider'
      thumbAlignment='edge'
      {...props}
    >
      <SliderPrimitive.Control className='relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col'>
        <SliderPrimitive.Track
          className='relative grow overflow-hidden rounded-none bg-muted select-none data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1'
          data-slot='slider-track'
        >
          <SliderPrimitive.Indicator
            className='bg-primary select-none data-horizontal:h-full data-vertical:w-full'
            data-slot='slider-range'
          />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          className='relative block size-3 shrink-0 rounded-none border border-ring bg-background ring-ring/50 transition-shadow select-none after:absolute after:-inset-2 hover:ring-1 focus-visible:ring-1 focus-visible:outline-hidden active:ring-1 disabled:pointer-events-none disabled:opacity-50'
          data-slot='slider-thumb'
        />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
