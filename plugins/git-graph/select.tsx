import type { JSX } from 'preact';
declare module 'preact' { namespace JSX { interface IntrinsicElements { selectedcontent: HTMLAttributes<HTMLElement>; } } }

export type SelectOption = { label: string; value: string | number; title?: string };
export type SelectItem = SelectOption | { label: string; options: SelectOption[] };
export function Select({ items, icon, value, class: className = '', ...props }: Omit<JSX.SelectHTMLAttributes<HTMLSelectElement>, 'value'> & {
  items: SelectItem[]; value: string | number; icon?: string;
}) {
  const option = (item: SelectOption) => <option key={item.value} value={String(item.value)} title={item.title}>{item.label}</option>;
  return <select {...props} class={`codex-select ${className}`} value={String(value)}>
    <button type="button">{icon && <span class="codex-select-icon" data-codex-icon={icon} aria-hidden="true" />}<selectedcontent /></button>
    {items.map(item => 'options' in item
      ? <optgroup key={item.label} label={item.label}><legend>{item.label}</legend>{item.options.map(option)}</optgroup>
      : option(item))}
  </select>;
}
