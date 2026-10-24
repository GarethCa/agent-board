import { cloneElement, isValidElement, useId } from 'react';
import type {
  CSSProperties,
  FieldsetHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { ChevronDown } from 'lucide-react';
import { cx } from './cx';

type ControlSize = 'sm' | 'md';

interface FieldProps {
  /** The control's visible name: also its accessible one, as the label wraps the control. */
  label: ReactNode;
  /** A line under the control saying what it is for or what it takes. */
  hint?: ReactNode;
  /** The control: one Input, Textarea or Select, which the hint describes. */
  children: ReactNode;
  className?: string;
}

/** A labelled form control, with an optional hint under it that screen readers read with the control. */
export function Field({ label, hint, children, className }: FieldProps) {
  const hintId = useId();
  const control =
    hint !== undefined && isValidElement<{ 'aria-describedby'?: string }>(children)
      ? cloneElement(children, { 'aria-describedby': hintId })
      : children;
  return (
    <div className={cx('ui-field', className)}>
      <label className="ui-field-label">
        <span className="ui-field-name">{label}</span>
        {control}
      </label>
      {hint !== undefined && (
        <p className="ui-hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** A group of controls under one caption. */
export function Fieldset({ legend, children, className, ...rest }: FieldsetHTMLAttributes<HTMLFieldSetElement> & { legend: ReactNode }) {
  return (
    <fieldset className={cx('ui-fieldset', className)} {...rest}>
      <legend className="ui-field-name">{legend}</legend>
      {children}
    </fieldset>
  );
}

/** A line that says what a control is for, outside a Field. */
export function Hint({ children, className, ...rest }: { children: ReactNode; className?: string; 'data-testid'?: string }) {
  return (
    <p className={cx('ui-hint', className)} {...rest}>
      {children}
    </p>
  );
}

/** What went wrong, announced as it appears; `announce={false}` for a standing error that shouldn't interrupt. */
export function ErrorText({ children, announce = true, className }: { children: ReactNode; announce?: boolean; className?: string }) {
  return (
    <p className={cx('ui-error', className)} role={announce ? 'alert' : undefined}>
      {children}
    </p>
  );
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: ControlSize;
  /** An icon inside its start, such as a search glass. */
  icon?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

/** A one-line text input. */
export function Input({ size = 'md', icon, className, ...rest }: InputProps) {
  const input = <input className={cx('ui-input', className)} data-size={size} data-icon={icon !== undefined || undefined} {...rest} />;
  if (icon === undefined) return input;
  return (
    <span className="ui-input-wrap">
      <span className="ui-input-icon">{icon}</span>
      {input}
    </span>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea className={cx('ui-input', 'ui-textarea', className)} {...rest} />;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: ControlSize;
}

/** A native select, so the platform's own list and keyboard handling come with it, in the app's look. */
export function Select({ size = 'md', className, children, ...rest }: SelectProps) {
  return (
    <span className="ui-select-wrap">
      <select className={cx('ui-input', 'ui-select', className)} data-size={size} {...rest}>
        {children}
      </select>
      <ChevronDown className="ui-select-chevron" />
    </span>
  );
}

type CheckProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /** The visible label beside it. Without one, give it an `aria-label`. */
  label?: ReactNode;
};

function makeCheckControl(type: 'checkbox' | 'radio', role: 'switch' | undefined, inputClass: string) {
  return function Check({ label, className, title, ...rest }: CheckProps) {
    const input = <input type={type} role={role} className={inputClass} title={label === undefined ? title : undefined} {...rest} />;
    if (label === undefined) return input;
    return (
      // The hint is on the label, so it shows over the text as well as the box.
      <label className={cx('ui-check', className)} title={title}>
        {input}
        <span>{label}</span>
      </label>
    );
  };
}

/** A checkbox, with its label beside it. */
export const Checkbox = makeCheckControl('checkbox', undefined, 'ui-checkbox');

/** One choice of a radio group, with its label beside it. */
export const Radio = makeCheckControl('radio', undefined, 'ui-radio');

/** An on/off setting that takes effect at once: a checkbox with the switch role. */
export const Switch = makeCheckControl('checkbox', 'switch', 'ui-switch');

interface ChoiceProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  /** A line under the label: a model, a mode. */
  detail?: ReactNode;
  /** A mark before the label, such as a harness's logo. */
  mark?: ReactNode;
}

/** One of a few big options in a radio group, drawn as a card: picked, it takes the accent edge and halo. */
export function Choice({ label, detail, mark, className, ...rest }: ChoiceProps) {
  return (
    <label className={cx('ui-choice', className)}>
      <input type="radio" {...rest} />
      {mark !== undefined && <span className="ui-choice-mark">{mark}</span>}
      <span>
        <span className="ui-choice-label">{label}</span>
        {detail !== undefined && <span className="ui-choice-detail">{detail}</span>}
      </span>
    </label>
  );
}

/** A radio group of Choice cards, side by side. */
export function Choices({ children, 'aria-label': label }: { children: ReactNode; 'aria-label': string }) {
  return (
    <div className="ui-choices" role="radiogroup" aria-label={label}>
      {children}
    </div>
  );
}

type SwatchProps = {
  /** The colour it shows: a zone's stored colour, or an item's colour as the theme draws it (board-colors.ts). */
  color: string;
  /** The colour's name. */
  'aria-label': string;
};

/** A colour to pick, as a toggle button: pressed while it is the colour in use. Its `edge`, if given, rings it. */
export function Swatch({
  color,
  edge,
  pressed,
  className,
  ...rest
}: SwatchProps & { edge?: string; pressed: boolean; onClick(): void; title?: string; className?: string }) {
  return (
    <button
      type="button"
      className={cx('ui-swatch', className)}
      aria-pressed={pressed}
      style={{ '--swatch': color, ...(edge === undefined ? {} : { '--swatch-edge': edge }) } as CSSProperties}
      {...rest}
    />
  );
}

/** A colour to pick, as one choice of a radio group. */
export function SwatchRadio({ color, ...rest }: SwatchProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'color'>) {
  return <input type="radio" className="ui-swatch" style={{ '--swatch': color } as CSSProperties} {...rest} />;
}
