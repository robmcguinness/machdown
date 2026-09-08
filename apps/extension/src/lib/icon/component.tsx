import { type CSSSize, type IconProps, type TailwindSize, cssColors, tailwindSizes } from './types';
import { IconRegistry } from './registry';
import { memo } from 'react';

/** A type guard, not a cast: `size` is wider than `TailwindSize` alone. */
const isTailwindSizeValue = (value: CSSSize | TailwindSize | undefined): value is TailwindSize =>
  tailwindSizes.some((candidate) => candidate === value);

const IconComponent = ({
  animate = 'none',
  className = '',
  color = 'inherit',
  label,
  name = 'icon-[line-md--question]',
  onClick,
  rotate,
  size = '2xl',
}: IconProps) => {
  const isTailwindSize = isTailwindSizeValue(size);
  const isCssColor = cssColors.some((regex) => regex.test(color));
  const isTailwindColor = !isCssColor && color !== 'inherit';

  const classList = [
    'icon motion-reduce:animate-none',
    IconRegistry.get(name || '') ?? name,
    isTailwindSize ? `text-${size}` : '',
    isTailwindColor ? `text-${color}` : color === 'inherit' ? 'text-inherit' : '',
    animate && animate !== 'none' ? `animate-${animate}` : '',
    onClick ? 'hover:cursor-pointer hover:opacity-95' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const style: React.CSSProperties = {
    color: isCssColor ? color : undefined,
    fontSize: isTailwindSize ? undefined : size,
    transform: rotate ? `rotate(${rotate}deg)` : undefined,
  };

  if (onClick) {
    return (
      <button
        aria-label={label ?? name}
        className={classList}
        style={style}
        type='button'
        onClick={(e) => {
          e.stopPropagation();
          onClick?.();
        }}
      />
    );
  }
  return <span className={classList} style={style} />;
};

export const Icon = memo(IconComponent);
