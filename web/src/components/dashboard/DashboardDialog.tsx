import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { LinearIcon } from "../LinearIcon";

interface DashboardDialogProps {
  title: ReactNode;
  labelledBy: string;
  triggerRef: RefObject<HTMLElement | null>;
  busy?: boolean;
  closeDisabled?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function DashboardDialog({
  title,
  labelledBy,
  triggerRef,
  busy = false,
  closeDisabled = false,
  onClose,
  children,
  footer,
}: DashboardDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    return () => triggerRef.current?.focus();
  }, []);

  function requestClose() {
    if (!closeDisabled) onClose();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key === "Tab") {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey
        && (document.activeElement === last || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  return createPortal(
    <div
      className="dashboard-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="task-dialog detail-dialog dashboard-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="dialog-header">
          <div className="dialog-context">
            <LinearIcon name="project" />
            <strong id={labelledBy}>{title}</strong>
          </div>
          <div className="dialog-header-actions">
            <button
              ref={closeButtonRef}
              className="icon-button dialog-close"
              type="button"
              aria-label="关闭"
              title="关闭 (Esc)"
              disabled={closeDisabled}
              onClick={requestClose}
            >
              <LinearIcon name="close" />
            </button>
          </div>
        </header>
        {children}
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
