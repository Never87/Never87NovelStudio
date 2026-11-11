import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface ProjectDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Footer actions (Cancel / Save / Delete). */
  footer?: ReactNode;
  /** Allows closing via Escape / backdrop. Disable while a save is in flight. */
  dismissible?: boolean;
  /** 'danger' tints the header icon for destructive dialogs. */
  tone?: 'default' | 'danger';
}

/**
 * Accessible modal dialog used by the project CRUD flows.
 *
 * Behaviour:
 * - Rendered into `document.body` via a portal so it escapes any stacking
 *   / overflow context in the page.
 * - `role="dialog"` + `aria-modal`, labelled by the title, described by the
 *   optional description.
 * - Escape and backdrop clicks close it (unless `dismissible` is false, e.g.
 *   while saving/deleting).
 * - Focus moves to the first focusable element on open and is restored to the
 *   previously focused element on close. Tab is trapped inside the dialog.
 *
 * Kept inside the projects module on purpose: it is not (yet) a general design
 * system primitive, and only these three dialogs use it.
 */
export function ProjectDialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  dismissible = true,
  tone = 'default',
}: ProjectDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [open]);

  // Focus management + Tab trap + Escape.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    if (panel) {
      const focusable = panel.querySelector<HTMLElement>(
        'input, textarea, select, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissible) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [open, dismissible, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          'bg-surface border-line relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl border shadow-xl sm:max-w-lg sm:rounded-xl',
        )}
      >
        <div className="border-line flex items-start justify-between gap-3 border-b px-5 py-3.5">
          <div className="min-w-0">
            <h2
              id={titleId}
              className={cn('text-ink text-sm font-semibold', tone === 'danger' && 'text-danger')}
            >
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-muted mt-0.5 text-xs">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={!dismissible}
            aria-label="Close dialog"
            className="text-subtle hover:text-ink hover:bg-surface-muted -mr-1.5 -mt-1 grid size-8 shrink-0 place-items-center rounded-md disabled:opacity-40"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <div className="border-line bg-surface-muted/40 flex items-center justify-end gap-2 border-t px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
