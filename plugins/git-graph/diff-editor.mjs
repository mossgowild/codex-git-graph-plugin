import 'monaco-editor/nls/lang/zh-cn.js';
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

const $ = id => document.getElementById(id);
let diffEditor, models = [], workerUrl, sourceEqual = false, codeFontSize;
globalThis.MonacoEnvironment = { getWorker() {
  workerUrl ||= URL.createObjectURL(new Blob([__DIFF_WORKER__], { type: 'text/javascript' }));
  return new Worker(workerUrl, { name: 'git-graph-diff' });
} };

export function themeDiff(theme) {
  const probe = document.createElement('span');
  probe.hidden = true; $('detail').append(probe);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const color = value => {
    probe.style.color = value;
    context.clearRect(0, 0, 1, 1); context.fillStyle = getComputedStyle(probe).color; context.fillRect(0, 0, 1, 1);
    return '#' + [...context.getImageData(0, 0, 1, 1).data].map(n => n.toString(16).padStart(2, '0')).join('');
  };
  probe.style.boxShadow = 'var(--shadow-lg)';
  const shadow = getComputedStyle(probe).boxShadow;
  const shadowColor = shadow === 'none' ? 'transparent' : shadow.match(/(?:rgba?|color|oklch|oklab|lch|lab|hsla?)\([^)]*\)/)?.[0];
  if (!shadowColor) throw new Error('无法解析 Codex 浮层阴影颜色');
  const dark = theme === 'dark';
  const syntax = Object.fromEntries(Object.entries({
    comment: '--muted', string: '--success', number: '--accent',
    keyword: '--danger', identifier: '--fg', type: '--graph-remote',
  }).map(([token, variable]) => [token, color(`var(${variable})`).slice(1, 7)]));
  const rules = [{ token: '', foreground: color('var(--fg)').slice(1, 7) },
    ...Object.entries(syntax).map(([token, foreground]) => ({ token, foreground })),
    ...['delimiter', 'operator'].map(token => ({ token, foreground: syntax.comment })),
    ...['function', 'type.identifier', 'tag'].map(token => ({ token, foreground: syntax.type })),
    { token: 'attribute.name', foreground: syntax.identifier },
    { token: 'attribute.value', foreground: syntax.string },
    { token: 'regexp', foreground: syntax.string },
    { token: 'invalid', foreground: color('var(--danger)').slice(1, 7) }];
  const lineBackground = tone => color(`color-mix(in lab, var(--bg) ${dark ? 80 : 88}%, var(${tone}))`);
  const wordBackground = tone => color(`rgb(from var(${tone}) r g b / ${dark ? .2 : .15})`);
  editor.defineTheme('codex', { base: dark ? 'vs-dark' : 'vs', inherit: false, rules, colors: {
    'editor.background': color('var(--bg)'), 'editor.foreground': color('var(--fg)'),
    'editorGutter.background': color('var(--bg)'), 'editorLineNumber.foreground': color('var(--muted)'),
    'editorLineNumber.activeForeground': color('var(--fg)'), 'editorCursor.foreground': color('var(--fg)'),
    'editor.selectionBackground': color('var(--color-background-info, var(--selected))'), 'editor.inactiveSelectionBackground': color('var(--hover)'),
    'editor.lineHighlightBackground': color('transparent'), 'editorWidget.background': color('var(--bg)'),
    'editorWidget.border': color('var(--border)'), 'editorWidget.foreground': color('var(--fg)'),
    'input.background': color('var(--surface)'), 'input.foreground': color('var(--fg)'),
    'input.border': color('var(--border)'), 'focusBorder': color('var(--accent)'),
    'diffEditor.border': color('var(--border)'),
    'widget.border': color('var(--border)'), 'widget.shadow': color(shadowColor),
    'editor.findMatchBackground': color('var(--color-background-info, var(--selected))'),
    'editor.findMatchHighlightBackground': color('var(--hover)'),
    'editor.findMatchBorder': color('var(--accent)'),
    'editor.findMatchHighlightBorder': color('var(--border)'),
    'inputOption.activeBackground': color('var(--selected)'),
    'inputOption.activeBorder': color('var(--border)'), 'inputOption.activeForeground': color('var(--fg)'),
    'inputOption.hoverBackground': color('var(--hover)'), 'input.placeholderForeground': color('var(--muted)'),
    'inputValidation.errorBackground': color('var(--color-background-danger, var(--bg))'),
    'inputValidation.errorBorder': color('var(--danger)'), 'inputValidation.errorForeground': color('var(--fg)'),
    'button.background': color('var(--surface)'), 'button.foreground': color('var(--fg)'),
    'button.hoverBackground': color('var(--hover)'),
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
  diffEditor?.updateOptions(viewOptions());
  document.fonts.ready.then(() => editor.remeasureFonts());
}
export function setCodeFontSize(size) {
  codeFontSize = size;
  diffEditor?.updateOptions(viewOptions());
}
function viewOptions() {
  return { ...(codeFontSize == null ? {} : { fontSize: codeFontSize }), fontFamily: getComputedStyle($('detail-hash')).fontFamily,
    renderSideBySide: $('diff-mode').dataset.mode === 'split',
    originalAriaLabel: '基准版本，只读', modifiedAriaLabel: '目标版本，只读' };
}

export function clearDiff(message = '') {
  diffEditor?.setModel(null);
  for (const model of models) model.dispose();
  models = [];
  $('diff-editor').hidden = true;
  $('diff-notice').textContent = message; $('diff-notice').hidden = !message;
  $('diff-revisions').hidden = true;
  $('diff-status').textContent = '';
  $('diff-mode').disabled = $('prev-change').disabled = $('next-change').disabled = true;
}
export function showDiff(result) {
  clearDiff();
  const revisions = [result.original, result.modified];
  sourceEqual = result.original.content === result.modified.content;
  for (const [index, side] of revisions.entries()) {
    const element = $(index === 0 ? 'diff-original' : 'diff-modified');
    element.textContent = `${index === 0 ? '基准' : '目标'} ${side.hash?.slice(0, 7) || '空树'}${side.exists ? '' : ' · 文件不存在'}${side.mode && result.original.mode !== result.modified.mode ? ` · ${side.mode}` : ''}`;
    element.title = `${side.hash || '空树'}\n${side.path}${side.mode ? `\n文件模式：${side.mode}` : ''}`;
  }
  $('diff-revisions').hidden = false;
  const reasons = revisions.flatMap((side, i) => side.reason ? [`${i === 0 ? '基准' : '目标'}：${side.reason}`] : []);
  if (reasons.length) {
    $('diff-notice').textContent = reasons.join('\n'); $('diff-notice').hidden = false;
    return;
  }
  $('diff-editor').hidden = false;
  if (!diffEditor) {
    diffEditor = editor.createDiffEditor($('diff-editor'), {
      ...viewOptions(), theme: 'codex', readOnly: true, originalEditable: false,
      automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false,
      renderLineHighlight: 'none',
      renderOverviewRuler: false, renderMarginRevertIcon: false, renderGutterMenu: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3 },
      ignoreTrimWhitespace: false, diffAlgorithm: 'advanced', maxComputationTime: 5000,
      useInlineViewWhenSpaceIsLimited: false,
      contextmenu: false, links: false, stickyScroll: { enabled: false },
    });
    diffEditor.onDidUpdateDiff(() => {
      if (!models.length) return;
      const changes = diffEditor.getLineChanges();
      $('prev-change').disabled = $('next-change').disabled = !changes?.length;
      $('diff-status').textContent = changes == null ? '差异尚未算出' : changes.length ? `${changes.length} 处差异`
        : sourceEqual ? '文件内容相同'
          : models[0].getValue(editor.EndOfLinePreference.LF) === models[1].getValue(editor.EndOfLinePreference.LF)
            ? '文本相同；换行符或 BOM 有变化' : '未能完整计算差异';
    });
  }
  for (const [index, side] of revisions.entries()) models.push(editor.createModel(side.content, undefined,
    Uri.from({ scheme: 'git-graph', authority: index ? 'modified' : 'original', path: `/${side.hash || 'empty'}/${side.path}` })));
  $('diff-status').textContent = '正在比较…'; $('diff-mode').disabled = false;
  diffEditor.updateOptions(viewOptions());
  diffEditor.setModel({ original: models[0], modified: models[1] });
  diffEditor.revealFirstDiff();
}
export function disposeDiff() {
  clearDiff(); diffEditor?.dispose(); diffEditor = null;
  if (workerUrl) URL.revokeObjectURL(workerUrl);
}
$('diff-mode').addEventListener('click', () => {
  const button = $('diff-mode'), split = button.dataset.mode !== 'split';
  button.dataset.mode = split ? 'split' : 'inline';
  button.title = split ? '切换为行内差异' : '切换为并排差异';
  button.setAttribute('aria-label', button.title);
  diffEditor?.updateOptions(viewOptions());
});
$('prev-change').addEventListener('click', () => diffEditor?.goToDiff('previous'));
$('next-change').addEventListener('click', () => diffEditor?.goToDiff('next'));
