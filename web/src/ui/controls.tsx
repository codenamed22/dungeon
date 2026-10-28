import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Minus, Plus } from "lucide-react";

/** A labelled field with an optional hint and error under it. */
export function Field({ label, hint, error, children, className }: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`field ${className ?? ""}`}>
      {label}
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error" role="alert">{error}</span>}
    </label>
  );
}

/** One of a few choices, as pressed buttons. */
export function Segmented<T extends string>({ value, options, onChange, label, disabled }: {
  value: T | undefined;
  options: readonly { value: T; label: ReactNode }[];
  onChange(value: T): void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={option.value === value} disabled={disabled} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A whole number between bounds, with − and + buttons for thumbs. */
export function Stepper({ value, min, max, step = 1, unit, label, onChange, disabled }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  label: string;
  onChange(value: number): void;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next)));
  return (
    <span className="stepper">
      <button type="button" aria-label={`Less ${label}`} disabled={disabled || value <= min} onClick={() => onChange(clamp(value - step))}><Minus size={14} /></button>
      <input type="number" inputMode="numeric" aria-label={label} min={min} max={max} value={text} disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          const next = Number(event.target.value);
          if (event.target.value.trim() !== "" && Number.isFinite(next) && next >= min && next <= max) onChange(Math.round(next));
        }}
        onBlur={() => setText(String(value))} />
      {unit && <span className="unit">{unit}</span>}
      <button type="button" aria-label={`More ${label}`} disabled={disabled || value >= max} onClick={() => onChange(clamp(value + step))}><Plus size={14} /></button>
    </span>
  );
}

/**
 * Text that changes the draft as you type. `commit` returns why a value was
 * refused, if it was; the field keeps what you typed and shows the reason. A
 * new value from elsewhere, such as the AI creator, replaces the text unless
 * you are typing in it.
 */
export function LiveText({ value, commit, multiline, rows = 3, placeholder, maxLength, disabled, label, hint, className, inputClassName }: {
  value: string;
  commit(next: string): string | null;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  label?: ReactNode;
  hint?: ReactNode;
  className?: string;
  inputClassName?: string;
}) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setText(value);
      setError(null);
    }
  }, [value]);
  const props = {
    value: text,
    placeholder,
    maxLength,
    disabled,
    className: inputClassName,
    onFocus: () => { focused.current = true; },
    onBlur: () => {
      focused.current = false;
      if (error) {
        setText(value);
        setError(null);
      }
    },
    onChange: (event: { target: { value: string } }) => {
      setText(event.target.value);
      setError(commit(event.target.value));
    },
  };
  const input = multiline ? <textarea rows={rows} {...props} /> : <input {...props} />;
  if (label === undefined) return input;
  return <Field label={label} hint={hint} error={error} {...(className ? { className } : {})}>{input}</Field>;
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="card-icon">{icon}</span>
      <h3>{title}</h3>
      {children}
    </div>
  );
}
