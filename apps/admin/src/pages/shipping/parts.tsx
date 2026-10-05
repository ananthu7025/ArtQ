// Small pieces shared by the Shipping Rates tabs.
import { btn } from '../../components/dialogs';

export const card = 'rounded-lg border border-surface-200 bg-white p-5';
export const primary = `${btn} bg-brand-700 text-white disabled:opacity-80`;
export const quiet = `${btn} text-ink-900 hover:bg-surface-100`;
export const outline = `${btn} border border-border-input`;

export function Check({ id, label, help, ...input }: { id: string; label: string; help?: string } & React.InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  return (
    <div className="flex items-start gap-3 text-sm text-ink-900">
      <input id={id} type="checkbox" className="mt-0.5 h-5 w-5 accent-brand-700" aria-describedby={help ? `${id}-help` : undefined} {...input} />
      <div><label htmlFor={id} className="font-medium">{label}</label>{help && <p id={`${id}-help`} className="text-ink-700">{help}</p>}</div>
    </div>
  );
}
