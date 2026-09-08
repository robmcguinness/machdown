'use client';

import * as React from 'react';
import { Slider as SliderPrimitive } from '@base-ui/react/slider';

import { cn } from '#lib/utils.ts';

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  ...props
}: SliderPrimitive.Root.Props) {
  // One thumb per value. Checked with `typeof` rather than `Array.isArray`,
  // which widens `readonly number[]` unions to `any[]`.
  const thumbCount = React.useMemo(() => {
    const current = value ?? defaultValue;
    if (current === undefined) return 2;
    return typeof current === 'number' ? 1 : current.length;
  }, [value, defaultValue]);

  return (
    <SliderPrimitive.Root
      className={cn('data-horizontal:w-full data-vertical:h-full', className)}
      data-slot='slider'
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment='edge'
      {...props}
    >
      <SliderPrimitive.Control className='relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col'>
        <SliderPrimitive.Track
          data-slot='slider-track'
          className='relative grow overflow-hidden rounded-full bg-muted select-none data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1'
        >
          <SliderPrimitive.Indicator
            data-slot='slider-range'
            className='bg-primary select-none data-horizontal:h-full data-vertical:w-full'
          />
        </SliderPrimitive.Track>
        {Array.from({ length: thumbCount }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot='slider-thumb'
            key={index}
            className='relative block size-3 shrink-0 rounded-full border border-ring bg-white ring-ring/50 select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-50'
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
