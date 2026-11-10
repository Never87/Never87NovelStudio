import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
  Ref,
} from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { cn } from '@/utils/cn';

/* Shared shape/colour tokens for every button-like element (button + link). */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-white hover:bg-accent-hover border border-transparent shadow-none dark:text-[#12141a]',
  secondary:
    'bg-surface text-ink border border-line-strong hover:bg-surface-muted active:bg-bg-subtle',
  subtle: 'bg-surface-muted text-ink border border-transparent hover:bg-bg-subtle',
  ghost: 'bg-transparent text-muted border border-transparent hover:bg-surface-muted hover:text-ink',
  danger:
    'bg-danger text-white border border-transparent hover:brightness-95 dark:text-[#180d0c]',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-md',
  lg: 'h-10 px-4 text-sm gap-2 rounded-lg',
};

const BASE_CLASSES =
  'inline-flex select-none items-center justify-center whitespace-nowrap font-medium ' +
  'transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

export interface SharedButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
  children?: ReactNode;
  className?: string;
}

export function buttonClassName({
  variant = 'secondary',
  size = 'md',
  fullWidth,
  className,
}: Pick<SharedButtonProps, 'variant' | 'size' | 'fullWidth' | 'className'>): string {
  return cn(BASE_CLASSES, VARIANT_CLASSES[variant], SIZE_CLASSES[size], fullWidth && 'w-full', className);
}

export type ButtonProps = SharedButtonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> & {
    ref?: Ref<HTMLButtonElement>;
  };

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  iconLeft,
  iconRight,
  fullWidth,
  className,
  children,
  disabled,
  type = 'button',
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClassName({ variant, size, fullWidth, className })}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> : iconLeft}
      {children}
      {!loading && iconRight}
    </button>
  );
}

export type ButtonLinkProps = SharedButtonProps &
  Omit<LinkProps, 'children' | 'className'> & {
    /** Render as a plain anchor (external link) instead of a router Link. */
    external?: boolean;
  };

export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  iconLeft,
  iconRight,
  fullWidth,
  className,
  children,
  external,
  ...rest
}: ButtonLinkProps) {
  const classes = buttonClassName({ variant, size, fullWidth, className });
  const content = (
    <>
      {iconLeft}
      {children}
      {iconRight}
    </>
  );

  if (external) {
    const { to, ...anchorRest } = rest;
    return (
      <a href={String(to)} className={classes} {...(anchorRest as AnchorHTMLAttributes<HTMLAnchorElement>)}>
        {content}
      </a>
    );
  }

  return (
    <Link className={classes} {...rest}>
      {content}
    </Link>
  );
}
