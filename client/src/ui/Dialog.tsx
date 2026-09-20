import { useEffect, useId, useRef, type ReactNode } from "react";

export function Dialog({
  title,
  children,
  onClose,
  closeLabel = "إغلاق",
  className,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  /** Extra class for dialogs with their own internal scroll region. */
  className?: string | undefined;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    document.documentElement.classList.add("modal-open");
    document.body.classList.add("modal-open");
    return () => {
      dialog?.close();
      if (!document.querySelector("dialog[open]")) {
        document.documentElement.classList.remove("modal-open");
        document.body.classList.remove("modal-open");
      }
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`card dialog-sheet react-dialog${className ? ` ${className}` : ""}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <button
        type="button"
        className="icon-button rules-dialog-close"
        aria-label={closeLabel}
        onClick={onClose}
      >
        ×
      </button>
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}
