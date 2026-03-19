/**
 * CSS size (length) types — px, em, rem, %, calc(), var()
 */
export type CSSSize =
  | `${number}px`
  | `${number}em`
  | `${number}rem`
  | `${number}%`
  | `calc(${string})`
  | `var(${string})`;

/** CSS color regex patterns for runtime validation */
export const cssColors = [
  /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
  /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/,
  /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d+)\s*\)$/,
  /^hsl\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*\)$/,
  /^hsla\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*,\s*(0|1|0?\.\d+)\s*\)$/,
] as const;

export const tailwindSizes = [
  'xs',
  'sm',
  'base',
  'lg',
  'xl',
  '2xl',
  '3xl',
  '4xl',
  '5xl',
  '6xl',
  '7xl',
  '8xl',
  '9xl',
  'inherit',
] as const;

export type TailwindSize = (typeof tailwindSizes)[number];

/**
 * IconProps interface defines the properties for the {@link Icon} component.
 *
 * @example
 * ```tsx
 * import { Icon } from '@lib';
 * function App() {
 *  return (
 *   <div>
 *    <Icon name='icon-[material-symbols--exclamation]' size='2em' color='#ff0000' rotate={45} animate='pulse' inline onClick={() => alert('Icon clicked!')} />
 *  </div>
 * );
 * }
 * ```
 */
export interface IconProps {
  /**
   * Specifies icon displayed by referencing name from {@link IconRegistry} or Tailwind CSS class from {@link https://icon-sets.iconify.design}.
   */
  name?: string;

  /**
   * Specifies icon size using Tailwind CSS font size class name (without prefix) {@link https://tailwindcss.com/docs/font-size} or custom CSS font size.
   * @example 'sm', '24px', '2em', '1.5rem', '50%'
   * @defaultValue 'inherit'
   */
  size?: CSSSize | TailwindSize;

  /**
   * Tailwind CSS color class name (without prefix) {@link https://tailwindcss.com/docs/colors} or custom CSS color.
   * @example 'red-500', '#ff0000', 'rgb(255, 0, 0)', 'hsl(0, 100%, 50%)'
   * @defaultValue 'inherit'
   */
  color?: string;

  /**
   * Specifies icon rotation in degrees.
   * @example 0, 45, 90, 180, 270, 360
   * @defaultValue 0
   */
  rotate?: number;

  /**
   * Specifies icon animation using Tailwind CSS animation class name (without prefix) {@link https://tailwindcss.com/docs/animation}.
   * @example 'spin', 'ping', 'pulse', 'bounce', custom animation name, or 'none'
   * @defaultValue 'none'
   */
  animate?: string | 'spin' | 'ping' | 'pulse' | 'bounce' | 'none' | undefined;

  /**
   * Optional additional CSS classes to apply to the icon element.
   */
  className?: string;

  /**
   * Optional click event handler.
   */
  onClick?: () => void | undefined;
}
