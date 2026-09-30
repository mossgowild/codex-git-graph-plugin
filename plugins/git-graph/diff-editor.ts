import { editor, Uri } from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/features/codicon/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import 'monaco-editor/languages/definitions/yaml/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import 'monaco-editor/languages/definitions/dart/register.js';

import type { diff } from './git.ts';
import { error, format, msg, type Locale } from './i18n.ts';
type DiffResult = Awaited<ReturnType<typeof diff>>;
export type DiffStatus = { text: string; canNavigate: boolean };
export type DiffView = { state: editor.IDiffEditorViewState | null; focus: 'original' | 'modified' | null };
type DiffInstance = {
  id: number; editor: editor.IStandaloneDiffEditor; models: editor.ITextModel[]; sourceEqual: boolean;
  status: DiffStatus; subscription?: { dispose(): void }; disposed: boolean; pendingReveal: boolean;
};
const $ = (id: string) => document.getElementById(id)!;
let single: DiffInstance | undefined, workerUrl: string | undefined, nextId = 0;
let codeFontSize: number | undefined, split = false;
let report: (status: DiffStatus) => void = () => {};
export function onStatus(callback: typeof report) { report = callback; }
const modelNamespace = [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16)).join('-');
declare const __DIFF_WORKER__: string;
declare const __EDITOR_LOCALE__: Locale;
const globals = globalThis as typeof globalThis & {
  _VSCODE_NLS_MESSAGES?: string[]; _VSCODE_NLS_LANGUAGE?: string; MonacoEnvironment: { getWorker(): Worker };
};
const messages = globals._VSCODE_NLS_MESSAGES;
const workerEnvironment = { getWorker() {
  workerUrl ||= URL.createObjectURL(new Blob([__DIFF_WORKER__], { type: 'text/javascript' }));
  return new Worker(workerUrl, { name: 'git-graph-diff' });
} };
export function activate() {
  if (__EDITOR_LOCALE__ === 'en') delete globals._VSCODE_NLS_MESSAGES;
  else globals._VSCODE_NLS_MESSAGES = messages;
  globals._VSCODE_NLS_LANGUAGE = __EDITOR_LOCALE__ === 'en' ? 'en' : 'zh-cn';
  globals.MonacoEnvironment = workerEnvironment;
}

export function themeDiff(theme: string) {
  const probe = document.createElement('span');
  probe.hidden = true; $('detail').append(probe);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const color = (value: string) => {
    probe.style.color = value;
    context.clearRect(0, 0, 1, 1); context.fillStyle = getComputedStyle(probe).color; context.fillRect(0, 0, 1, 1);
    return '#' + [...context.getImageData(0, 0, 1, 1).data].map(n => n.toString(16).padStart(2, '0')).join('');
  };
  probe.style.boxShadow = 'var(--shadow-lg)';
  const shadow = getComputedStyle(probe).boxShadow;
  const shadowColor = shadow === 'none' ? 'transparent' : shadow.match(/(?:rgba?|color|oklch|oklab|lch|lab|hsla?)\([^)]*\)/)?.[0];
  if (!shadowColor) throw error('editor.error.shadow');
  const dark = theme === 'dark';
  const lineBackground = (tone: string) => color(`color-mix(in lab, var(--bg) ${dark ? 80 : 88}%, var(${tone}))`);
  const wordBackground = (tone: string) => color(`rgb(from var(${tone}) r g b / ${dark ? .2 : .15})`);
  editor.defineTheme('codex', { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors: {
    'editor.background': color('var(--bg)'), 'editor.foreground': color('var(--fg)'),
    'editorGutter.background': color('var(--bg)'), 'editorLineNumber.foreground': color('var(--muted)'),
    'editorLineNumber.activeForeground': color('var(--fg)'), 'editorCursor.foreground': color('var(--fg)'),
    'editor.selectionBackground': color('var(--color-background-info, var(--selected))'), 'editor.inactiveSelectionBackground': color('var(--color-background-primary-ghost-hover)'),
    'editor.lineHighlightBackground': color('transparent'), 'editorWidget.background': color('var(--bg)'),
    'editorWidget.border': color('var(--border)'), 'editorWidget.foreground': color('var(--fg)'),
    'input.background': color('var(--surface)'), 'input.foreground': color('var(--fg)'),
    'input.border': color('var(--border)'), 'focusBorder': color('var(--accent)'),
    'diffEditor.border': color('var(--border)'),
    'widget.border': color('var(--border)'), 'widget.shadow': color(shadowColor),
    'editor.findMatchBackground': color('var(--color-background-info, var(--selected))'),
    'editor.findMatchHighlightBackground': color('var(--color-background-primary-ghost-hover)'),
    'editor.findMatchBorder': color('var(--accent)'),
    'editor.findMatchHighlightBorder': color('var(--border)'),
    'inputOption.activeBackground': color('var(--selected)'),
    'inputOption.activeBorder': color('var(--border)'), 'inputOption.activeForeground': color('var(--fg)'),
    'inputOption.hoverBackground': color('var(--color-background-primary-ghost-hover)'), 'input.placeholderForeground': color('var(--muted)'),
    'inputValidation.errorBackground': color('var(--color-background-danger, var(--bg))'),
    'inputValidation.errorBorder': color('var(--danger)'), 'inputValidation.errorForeground': color('var(--fg)'),
    'button.background': color('var(--surface)'), 'button.foreground': color('var(--fg)'),
    'button.hoverBackground': color('var(--color-background-primary-ghost-hover)'),
    'scrollbarSlider.background': color('var(--scrollbar-thumb)'),
    'scrollbarSlider.hoverBackground': color('var(--scrollbar-thumb-strong)'),
    'scrollbarSlider.activeBackground': color('var(--scrollbar-thumb-strong)'),
    'scrollbar.shadow': color('transparent'),
    'diffEditorGutter.insertedLineBackground': lineBackground('--success'),
    'diffEditorGutter.removedLineBackground': lineBackground('--danger'),
    'diffEditor.insertedLineBackground': lineBackground('--success'),
    'diffEditor.removedLineBackground': lineBackground('--danger'),
    'diffEditor.insertedTextBackground': wordBackground('--success'),
    'diffEditor.removedTextBackground': wordBackground('--danger'),
    'diffEditor.unchangedRegionBackground': color('var(--surface)'),
    'diffEditor.unchangedRegionForeground': color('var(--muted)'),
  } });
  probe.remove(); editor.setTheme('codex');
  updateOptions();
  document.fonts.ready.then(() => editor.remeasureFonts());
}
export function setCodeFontSize(size: number) {
  codeFontSize = size;
  updateOptions();
}
function viewOptions() {
  return { ...(codeFontSize == null ? {} : { fontSize: codeFontSize }), fontFamily: getComputedStyle($('detail-hash')).fontFamily,
    renderSideBySide: split,
    originalAriaLabel: format(msg('editor.aria.original'), __EDITOR_LOCALE__), modifiedAriaLabel: format(msg('editor.aria.modified'), __EDITOR_LOCALE__) };
}

function updateOptions() {
  single?.editor.updateOptions(viewOptions());
}
function emit(instance: DiffInstance) {
  if (!instance.disposed) report(instance.status);
}
function createInstance(): DiffInstance {
  const instance: DiffInstance = {
    id: ++nextId, models: [], sourceEqual: false, status: { text: '', canNavigate: false }, disposed: false, pendingReveal: false,
    editor: editor.createDiffEditor($('diff-editor'), {
      ...viewOptions(), theme: 'codex', readOnly: true, originalEditable: false,
      automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
      renderLineHighlight: 'none',
      renderOverviewRuler: false, renderMarginRevertIcon: false, renderGutterMenu: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3 },
      ignoreTrimWhitespace: false, diffAlgorithm: 'advanced', maxComputationTime: 5000,
      useInlineViewWhenSpaceIsLimited: false,
      contextmenu: false, links: false, stickyScroll: { enabled: false },
    }),
  };
  instance.subscription = instance.editor.onDidUpdateDiff(() => {
    if (!instance.models.length || instance.disposed) return;
    const changes = instance.editor.getLineChanges();
    const description = changes == null ? msg('editor.status.uncomputed') : changes.length ? msg(changes.length === 1 ? 'editor.status.change' : 'editor.status.changes', { count: changes.length })
      : instance.sourceEqual ? msg('editor.status.same')
        : instance.models[0].getValue(editor.EndOfLinePreference.LF) === instance.models[1].getValue(editor.EndOfLinePreference.LF)
          ? msg('editor.status.lineEnding') : msg('editor.status.incomplete');
    if (instance.pendingReveal && changes != null) { instance.pendingReveal = false; revealChange(instance, 0); }
    instance.status = { text: format(description, __EDITOR_LOCALE__), canNavigate: Boolean(changes?.length) }; emit(instance);
  });
  return instance;
}
function clearInstance(instance: DiffInstance) {
  instance.editor.setModel(null);
  for (const model of instance.models) model.dispose();
  instance.models = [];
  instance.pendingReveal = false;
  instance.status = { text: '', canNavigate: false }; emit(instance);
}
function saveView(instance: DiffInstance): DiffView {
  return { state: instance.editor.saveViewState(), focus: instance.editor.getOriginalEditor().hasTextFocus() ? 'original'
    : instance.editor.getModifiedEditor().hasTextFocus() ? 'modified' : null };
}
function focus(instance: DiffInstance, side: 'original' | 'modified' = 'modified') {
  (side === 'original' ? instance.editor.getOriginalEditor() : instance.editor.getModifiedEditor()).focus();
}
function restoreView(instance: DiffInstance, view: DiffView) {
  instance.pendingReveal = false;
  instance.editor.restoreViewState(view.state);
  if (view.focus) focus(instance, view.focus);
}
function bindDiff(instance: DiffInstance, result: DiffResult, view?: DiffView) {
  clearInstance(instance);
  instance.sourceEqual = result.original.content === result.modified.content;
  try {
    for (const [index, side] of [result.original, result.modified].entries()) instance.models.push(editor.createModel(side.content, undefined,
      Uri.from({ scheme: 'git-graph', authority: index ? 'modified' : 'original', path: `/${side.hash || 'empty'}/${side.path}`, query: `instance=${modelNamespace}-${instance.id}` })));
    instance.status = { text: format(msg('editor.status.pending'), __EDITOR_LOCALE__), canNavigate: false }; emit(instance);
    instance.editor.updateOptions(viewOptions());
    instance.pendingReveal = !view?.state;
    instance.editor.setModel({ original: instance.models[0], modified: instance.models[1] });
    if (view?.state) restoreView(instance, view); else if (view?.focus) focus(instance, view.focus);
  } catch (error) { clearInstance(instance); throw error; }
}
function disposeInstance(instance: DiffInstance) {
  if (instance.disposed) return;
  instance.disposed = true;
  clearInstance(instance);
  instance.subscription?.dispose();
  instance.editor.dispose();
}
export function clearDiff() {
  if (single) clearInstance(single); else report({ text: '', canNavigate: false });
}
export function saveDiffView(): DiffView | undefined { return single ? saveView(single) : undefined; }
export function showDiff(result: DiffResult, preserveView: boolean | DiffView = false) {
  const view = typeof preserveView === 'boolean' ? preserveView ? saveDiffView() : undefined : preserveView;
  single ||= createInstance();
  bindDiff(single, result, view);
}
function revealChange(instance: DiffInstance, index: number) {
  const change = instance.editor.getLineChanges()?.[index], model = instance.models[1];
  if (!change || !model) return;
  const start = Math.max(1, Math.min(model.getLineCount(), change.modifiedStartLineNumber + (change.modifiedEndLineNumber === 0 ? 1 : 0)));
  const end = Math.max(start, Math.min(model.getLineCount(), change.modifiedEndLineNumber || start));
  const modified = instance.editor.getModifiedEditor();
  modified.setPosition({ lineNumber: start, column: 1 });
  modified.revealRangeInCenter({ startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: model.getLineMaxColumn(end) });
}
export function disposeDiff() {
  if (single) disposeInstance(single);
  single = undefined; report({ text: '', canNavigate: false });
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = undefined;
}
export function setSplit(value: boolean) { split = value; updateOptions(); }
export function goToDiff(direction: 'previous' | 'next') { single?.editor.goToDiff(direction); }
