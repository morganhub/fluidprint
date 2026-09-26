import { forwardRef, type InputHTMLAttributes, type LabelHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export const inputClass =
  'h-7 w-full min-w-0 rounded-md border border-neutral-300 bg-white px-2 text-[13px] text-neutral-900 tabular-nums ' +
  'placeholder:text-neutral-400 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/30 disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(inputClass, className)} {...props} />
));
Input.displayName = 'Input';

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-[11px] font-medium text-neutral-500', className)} {...props} />;
}

/** Liste déroulante native au style des champs : clavier et accessibilité natifs, sans dépendance. */
export const NativeSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(inputClass, 'pr-6', className)} {...props} />
));
NativeSelect.displayName = 'NativeSelect';
