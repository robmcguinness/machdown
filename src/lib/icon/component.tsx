import { type IconProps, type TailwindSize, cssColors, tailwindSizes } from './types';
import { IconRegistry } from './registry';
import { memo } from 'react';

const IconComponent = ({
  name = 'icon-[line-md--question]',
  size = '2xl',
  color = 'inherit',
  rotate,
  animate = 'none',
  className = '',
  onClick = undefined,
}: IconProps) => {
  const isTailwindSize = tailwindSizes.includes(size as TailwindSize);
  const isCssColor = cssColors.some((regex) => regex.test(color));
  const isTailwindColor = !isCssColor && color !== 'inherit';

  const classList = [
    'icon transition-transform',
    `${IconRegistry[name || ''] ?? name}`,
    isTailwindSize ? `text-${size}` : '',
    isTailwindColor ? `text-${color}` : color === 'inherit' ? 'text-inherit' : '',
    animate && animate !== 'none' ? `animate-${animate}` : '',
    onClick ? 'hover:cursor-pointer hover:opacity-95' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const style: React.CSSProperties = {
    fontSize: isTailwindSize ? undefined : size,
    color: isCssColor ? color : undefined,
    transform: rotate ? `rotate(${rotate}deg)` : undefined,
  };

  if (onClick)
    return (
      <button
        type='button'
        className={classList}
        style={style}
        onClick={(e) => {
          e.stopPropagation();
          onClick?.();
        }}
      />
    );
  return <span className={classList} style={style} />;
};

export const Icon = memo(IconComponent);
