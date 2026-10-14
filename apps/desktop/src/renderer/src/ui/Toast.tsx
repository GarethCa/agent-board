import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Info, X } from 'lucide-react';
import { Button, IconButton } from './Button';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastOptions {
  message: ReactNode;
  tone?: ToastTone;
  /** A toast with the id of one already showing replaces it, so a repeated failure shows once. */
  id?: string;
  /** One action, such as Retry or Open. Taking it dismisses the toast. */
  action?: { label: string; onClick(): void };
}

type Toast = ToastOptions & Required<Pick<ToastOptions, 'tone' | 'id'>>;

interface Toasts {
  /** Shows a toast and returns its id. Errors stay until dismissed; the rest go after a few seconds. */
  show(options: ToastOptions): string;
  dismiss(id: string): void;
}

/** How long a confirmation stays up. An error stays until it is dismissed: it may need reading or retrying. */
const LINGER_MS = 6000;

const ToastContext = createContext<Toasts | undefined>(undefined);

/** The app-wide toasts: errors and confirmations, stacked at the bottom of the window. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (options: ToastOptions) => {
      const id = options.id ?? `toast-${next.current++}`;
      const toast: Toast = { tone: 'info', ...options, id };
      setToasts((current) =>
        current.some((each) => each.id === id) ? current.map((each) => (each.id === id ? toast : each)) : [...current, toast],
      );
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      if (toast.tone !== 'error') timers.current.set(id, setTimeout(() => dismiss(id), LINGER_MS));
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext value={value}>
      {children}
      {/*
        Always there and live, so a toast is read out as it lands, and a modal dialog (which hides the rest of the page
        from screen readers) leaves it showing: Radix keeps live regions.
      */}
      <ol className="ui-toasts" aria-label="Notifications" aria-live="polite">
        {toasts.map((toast) => (
          <li key={toast.id}>
            <ToastView {...toast} onDismiss={() => dismiss(toast.id)} />
          </li>
        ))}
      </ol>
    </ToastContext>
  );
}

/** The app's toasts. */
export function useToast(): Toasts {
  const toasts = use(ToastContext);
  if (toasts === undefined) throw new Error('useToast needs a ToastProvider');
  return toasts;
}

const TONE_ICONS: Record<ToastTone, ReactNode> = {
  info: <Info aria-hidden />,
  success: <Check aria-hidden />,
  error: <X aria-hidden />,
};

/** One toast. An error's message is an alert, read out at once; the rest are read out politely by the region. */
export function ToastView({
  message,
  tone = 'info',
  action,
  onDismiss,
  preview,
}: Omit<ToastOptions, 'id'> & {
  onDismiss(): void;
  /** Holds its buttons in a pointer or focus state, for the component gallery. */
  preview?: 'hover' | 'active' | 'focus';
}) {
  return (
    <div className="ui-toast" data-tone={tone}>
      {TONE_ICONS[tone]}
      <span className="ui-toast-message" role={tone === 'error' ? 'alert' : undefined}>
        {message}
      </span>
      <span className="ui-toast-actions">
        {action !== undefined && (
          <Button
            size="sm"
            data-preview={preview}
            onClick={() => {
              onDismiss();
              action.onClick();
            }}
          >
            {action.label}
          </Button>
        )}
        <IconButton icon={<X />} aria-label="Dismiss" size="sm" data-preview={preview} onClick={onDismiss} />
      </span>
    </div>
  );
}
