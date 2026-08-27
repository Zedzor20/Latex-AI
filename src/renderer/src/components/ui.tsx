import { type ReactNode, type ButtonHTMLAttributes, useEffect } from "react";

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

export function IconButton({
  title,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button type="button" title={title} className={`iconButton ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

/** Modal shell with a dimmed backdrop; closes on Escape or backdrop click. */
export function Modal({
  onClose,
  children,
  width = 720
}: {
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modalBackdrop" onMouseDown={onClose}>
      <div
        className="modalPanel"
        style={{ width: `min(${width}px, calc(100vw - 48px))` }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
