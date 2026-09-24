import { McpUiHostContextSchema, McpUiHostStylesSchema, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';

const styleKeys = McpUiHostStylesSchema.shape.variables.unwrap().keyType.options.flatMap(option => [...option.values]);
const required = ['--color-background-primary', '--color-background-secondary', '--color-text-primary',
  '--color-text-secondary', '--color-border-secondary', '--color-ring-primary', '--font-sans', '--font-mono',
  '--font-text-sm-size', '--font-text-xs-size', '--font-weight-normal', '--border-radius-xs',
  '--border-radius-sm', '--border-radius-md', '--border-radius-xl', '--shadow-lg'];

// The preview source injects the live host context here; this module has no theme defaults.
export function injectPreviewTheme(context: McpUiHostContext) {
  const parsed = McpUiHostContextSchema.parse(context);
  const root = document.documentElement;
  root.dataset.theme = parsed.theme || '';
  for (const key of styleKeys) {
    const value = parsed.styles?.variables?.[key];
    if (value == null) root.style.removeProperty(key);
    else root.style.setProperty(key, value);
  }
  let fonts = document.querySelector<HTMLStyleElement>('style[data-preview-fonts]');
  if (!fonts) {
    fonts = document.createElement('style'); fonts.dataset.previewFonts = '';
    document.head.append(fonts);
  }
  fonts.textContent = parsed.styles?.css?.fonts || '';
  root.style.setProperty('--interaction-cursor', String(parsed['openai/interactionCursor'] || ''));
}

export function observePreviewTheme(onTheme: (context: McpUiHostContext) => void, onMissing: (missing: string[]) => void) {
  let previous: string | undefined;
  const refresh = () => {
    const root = document.documentElement, style = getComputedStyle(root);
    const variables = Object.fromEntries(styleKeys.map(key => [key, style.getPropertyValue(key).trim()]));
    const missing = required.filter(key => !variables[key]);
    if (!['light', 'dark'].includes(root.dataset.theme || '')) missing.push('data-theme');
    if (missing.length) { previous = undefined; onMissing(missing); return; }
    const context: McpUiHostContext = { theme: root.dataset.theme as 'light' | 'dark', styles: { variables: McpUiHostStylesSchema.parse({ variables }).variables,
      css: { fonts: document.querySelector<HTMLStyleElement>('style[data-preview-fonts]')?.textContent || '' } },
      'openai/interactionCursor': style.getPropertyValue('--interaction-cursor').trim() };
    const serialized = JSON.stringify(context);
    if (serialized !== previous) { previous = serialized; onTheme(context); }
  };
  const observer = new MutationObserver(refresh);
  observer.observe(document.documentElement, { attributes: true });
  observer.observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true });
  document.addEventListener('load', refresh, true);
  refresh();
  return () => { observer.disconnect(); document.removeEventListener('load', refresh, true); };
}
