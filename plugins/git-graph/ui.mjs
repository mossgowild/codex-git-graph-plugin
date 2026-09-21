import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';
import { layout, graphPaths, laneX } from './graph.mjs';
import { widthsSchema, panelsSchema } from './layout.mjs';
import { createPanels } from './panels.mjs';
import { setSelectOptions } from './select.mjs';
import { clearDiff, showDiff, themeDiff, disposeDiff, setCodeFontSize } from './diff-editor.mjs';

const $ = id => document.getElementById(id);
const rowHeight = 28;
const detailRow = $('detail-row');
const commitRows = () => [...$('rows').querySelectorAll('.commit-row')];
const app = new App({ name: 'Git Graph', version: '0.3.0' });
const state = { repo: '', repository: '', repositories: [], branch: '', parent: 0, commits: [], refs: [], tips: [], selected: '', focused: '', detail: null, file: '', matches: [], match: -1, searchQuery: '', searchSelection: '',
  hasMore: false, historyVersion: 0, detailVersion: 0, diffVersion: 0, connected: false, loading: false };
let retry = null, fontRefresh = null, fontTimer;
let columnWidths = {}, layoutReady = false, layoutRetry = null;
let saveQueue = Promise.resolve(), saveVersion = 0;
const panels = createPanels({ ready: () => layoutReady, save: saveLayout });

function layoutError(message, action) {
  $('layout-error').hidden = false;
  $('layout-error').querySelector('span').textContent = message;
  layoutRetry = action;
}
async function loadLayout() {
  try {
    const result = await call('git_graph_layout', {});
    columnWidths = widthsSchema.parse(result.widths);
    const panelLayout = panelsSchema.parse(result.panels);
    layoutReady = true;
    panels.load(panelLayout);
    $('layout-error').hidden = true;
  } catch (e) { layoutError(`无法读取已保存的布局。${e.message}`, loadLayout); }
}
function saveLayout() {
  const widths = { ...columnWidths }, panelLayout = panels.preferences, version = ++saveVersion;
  saveQueue = saveQueue.then(async () => {
    try {
      await call('git_graph_save_layout', { widths, panels: panelLayout });
      if (version === saveVersion) $('layout-error').hidden = true;
    } catch (e) {
      if (version === saveVersion) layoutError(`布局尚未保存。${e.message}`, saveLayout);
    }
  });
  return saveQueue;
}
$('layout-retry').addEventListener('click', () => layoutRetry?.());

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function error(message, action) {
  $('error').hidden = false;
  $('error').querySelector('span').textContent = message;
  retry = action;
  $('retry').hidden = !action;
}
async function call(name, args) {
  if (!state.connected) throw new Error('尚未连接到 Codex，请重新打开 Git Graph 窗口。');
  if (state.repository && ['git_graph_history', 'git_graph_commit', 'git_graph_diff', 'git_graph_workspace_file'].includes(name)) {
    args = { repository: state.repository, ...args };
  }
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Git 查询失败。');
  if (!result.structuredContent) throw new Error('Git Graph 返回了无效的数据。');
  return result.structuredContent;
}
function refreshCodeFontSize() {
  if (!state.connected || fontRefresh) return fontRefresh;
  fontRefresh = call('git_graph_appearance', {}).then(data => {
    if (state.connected) setCodeFontSize(z.number().min(8).max(24).parse(data.codeFontSize));
  }).catch(e => error(`无法读取 Codex 代码字号：${e.message}`, refreshCodeFontSize))
    .finally(() => { fontRefresh = null; });
  return fontRefresh;
}
window.addEventListener('focus', refreshCodeFontSize);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCodeFontSize(); });

function theme(context) {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.css?.fonts != null) {
    applyHostFonts(context.styles.css.fonts);
    document.getElementById('__mcp-host-fonts').textContent = context.styles.css.fonts;
  }
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context['openai/interactionCursor']) document.documentElement.style.setProperty('--interaction-cursor', context['openai/interactionCursor']);
  const probe = document.createElement('span'); probe.hidden = true; document.body.append(probe);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const painter = canvas.getContext('2d', { willReadFrequently: true });
  // Flatten translucent host colors so overlapping SVG shapes do not accumulate opacity.
  for (const name of ['selected-surface', 'graph-current', 'graph-remote', 'graph-1', 'graph-2', 'graph-3', 'graph-4', 'graph-5']) {
    document.documentElement.style.removeProperty(`--${name}`);
    painter.clearRect(0, 0, 1, 1);
    for (const value of ['var(--bg)', `var(--${name === 'selected-surface' ? 'selected' : name})`]) {
      probe.style.color = value; painter.fillStyle = getComputedStyle(probe).color; painter.fillRect(0, 0, 1, 1);
    }
    document.documentElement.style.setProperty(`--${name}`, `rgb(${[...painter.getImageData(0, 0, 1, 1).data].slice(0, 3).join(',')})`);
  }
  probe.remove();
  themeDiff(document.documentElement.style.colorScheme || context.theme);
  refreshCodeFontSize();
}
function refsLabel(ref) { return ref.name.replace(/^refs\/(heads|remotes|tags)\//, ''); }
function refDisplayName(ref) {
  const label = refsLabel(ref);
  if (state.refCounts.get(label) < 2) return label;
  const kind = ref.name.startsWith('refs/heads/') ? '本地' : ref.name.startsWith('refs/remotes/') ? '远程' : '标签';
  return `${kind} · ${label}`;
}
function refBadge(ref) {
  const label = node('span', null, `ref ${ref.icon}`);
  label.title = ref.name;
  label.setAttribute('aria-label', refDisplayName(ref));
  if (ref.color) label.style.setProperty('--ref-color', ref.color);
  label.append(node('span', refDisplayName(ref), 'ref-name'));
  return label;
}
function renderCommitRefs() {
  const refs = state.graphRows.get(state.selected)?.references || [];
  $('commit-refs').replaceChildren(...refs.map(refBadge));
}

function acceptHistory(data, append = false) {
  state.repo = data.repo;
  if (data.repositories) state.repositories = data.repositories;
  state.repository = state.repositories.find(repo => repo.path === data.repo)?.id || '';
  state.commits = append ? [...state.commits, ...data.commits] : data.commits;
  state.refs = data.refs;
  state.branch = data.branch;
  if (data.missingBranch) error(`所选分支或标签“${refsLabel({ name: data.missingBranch })}”已不存在，已显示所有分支与标签`, null);
  state.refCounts = new Map();
  for (const ref of state.refs) {
    const label = refsLabel(ref);
    state.refCounts.set(label, (state.refCounts.get(label) || 0) + 1);
  }
  state.tips = data.tips;
  state.hasMore = data.hasMore;
  state.head = data.head;
  state.headName = data.headName;
  const currentRepository = state.repositories.find(repo => repo.path === data.repo);
  $('repo-label').textContent = currentRepository?.name || data.repo.split('/').at(-1);
  $('repo-label').title = currentRepository?.displayPath || data.repo;
  $('repo-label').hidden = state.repositories.length > 1;
  $('repository').hidden = state.repositories.length < 2;
  setSelectOptions($('repository'), state.repositories.map(repo => ({
    label: state.repositories.some(other => other.id !== repo.id && other.name === repo.name) ? (repo.displayPath || repo.path) : repo.name,
    value: repo.id, title: repo.displayPath || repo.path,
  })), state.repository, 'folder-light-16');
  $('repository').title = currentRepository?.displayPath || data.repo;
  $('toolbar').hidden = false;
  const groups = [['本地分支', 'refs/heads/'], ['远程分支', 'refs/remotes/'], ['标签', 'refs/tags/']];
  setSelectOptions($('branch'), [{ label: '所有分支与标签', value: '' },
    ...groups.map(([label, prefix]) => ({ label,
      options: data.refs.filter(ref => ref.name.startsWith(prefix)).map(ref => ({ label: refDisplayName(ref), value: ref.name })),
    })).filter(group => group.options.length),
  ], state.branch, 'branch-light-16');
  renderHistory();
  if (state.selected && !state.commits.some(commit => commit.hash === state.selected)) closeDetail();
}

async function loadHistory(append = false, branch = $('branch').value, repository = state.repository) {
  if (append && (state.loading || !state.hasMore)) return;
  const version = ++state.historyVersion;
  const changingRepository = repository !== state.repository;
  const switching = changingRepository || branch !== state.branch;
  if (switching) closeDetail();
  if (changingRepository) { $('search').value = ''; updateSearch(); }
  state.loading = true;
  $('branch').value = branch;
  $('repository').value = repository;
  $('branch').disabled = changingRepository;
  $('history-table').hidden = switching;
  $('searchbar').inert = switching;
  $('empty').hidden = true;
  $('history-pane').setAttribute('aria-busy', 'true');
  $('load-more').disabled = true;
  $('error').hidden = true;
  try {
    const args = { branch, ...(repository ? { repository } : {}) };
    if (append) { args.offset = state.commits.length; args.tips = state.tips; }
    let result = await call('git_graph_history', args);
    if (version !== state.historyVersion) return;
    if (append && !result.missingBranch && (result.head !== state.head || result.headName !== state.headName
      || JSON.stringify(result.refs) !== JSON.stringify(state.refs))) {
      result = await call('git_graph_history', { branch, ...(repository ? { repository } : {}) });
      if (version !== state.historyVersion) return;
      append = false;
    }
    if (result.missingBranch) append = false;
    acceptHistory(result, append);
    if (!append) $('history-scroll').scrollTop = 0;
    if (state.selected && !append && !detailRow.hidden) selectCommit(state.selected, state.parent, false, state.file);
  } catch (e) {
    if (version !== state.historyVersion) return;
    $('branch').value = state.branch;
    $('repository').value = state.repository;
    $('empty').hidden = state.commits.length > 0;
    error(e.message, () => loadHistory(append, branch, repository));
  } finally {
    if (version === state.historyVersion) {
      $('history-pane').setAttribute('aria-busy', 'false');
      state.loading = false; $('load-more').disabled = false; $('history-table').hidden = false; $('searchbar').inert = false;
      $('branch').disabled = false;
    }
  }
}

function graphSvg(row) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.classList.add('graph'); svg.style.width = `${row.width}px`;
  svg.setAttribute('width', row.width); svg.setAttribute('height', rowHeight); svg.setAttribute('aria-hidden', 'true');
  for (const { d, color } of graphPaths(row, rowHeight)) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d); path.setAttribute('fill', 'none'); path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '1'); path.setAttribute('stroke-linecap', 'round'); svg.append(path);
  }
  if (row.parents.length || row.input[row.column]?.hash === row.hash) svg.lastElementChild.classList.add('node-edge');
  const circle = (radius, width, hollow = false) => {
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', laneX(row.column)); dot.setAttribute('cy', rowHeight / 2); dot.setAttribute('r', radius);
    dot.setAttribute('stroke-width', width); dot.setAttribute('fill', hollow ? 'var(--bg)' : row.color);
    svg.append(dot);
  };
  if (row.kind === 'HEAD') { circle(7, 2); circle(2, 4, true); }
  else if (row.parents.length > 1) { circle(6, 2); circle(3, 2); }
  else circle(5, 2);
  return svg;
}
function renderHistory() {
  const graph = layout(state.commits, state);
  state.graphRows = new Map(graph.rows.map(row => [row.hash, row]));
  const fragment = document.createDocumentFragment();
  for (const row of graph.rows) {
    const entry = node('div', null, 'commit-entry'); entry.role = 'listitem';
    const button = node('button', null, 'commit-row');
    button.dataset.hash = row.hash;
    button.classList.toggle('current', row.kind === 'HEAD');
    button.classList.toggle('is-focused', row.hash === state.focused);
    button.setAttribute('aria-pressed', String(row.hash === state.selected));
    button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', 'detail-row');
    button.setAttribute('aria-label', `${row.subject}，${row.author}，${row.hash.slice(0, 8)}${row.references.length ? `，${row.references.map(refDisplayName).join('，')}` : ''}`);
    button.tabIndex = row.hash === state.selected || (!state.selected && fragment.childNodes.length === 0) ? 0 : -1;
    const message = node('span', null, 'message');
    const subject = node('span', row.subject || '（无提交标题）', 'subject'); subject.title = row.subject;
    const author = node('span', row.author, 'author'); author.title = `${row.author} <${row.email}>`;
    const badges = node('span', null, 'badges');
    badges.append(...row.references.map(refBadge));
    message.append(badges, subject);
    button.title = `${row.subject}\n${row.author} <${row.email}>\n${new Date(row.date).toLocaleString('zh-CN')}\n${row.hash}`;
    button.append(graphSvg(row), message, author); entry.append(button); fragment.append(entry);
  }
  $('content').append(detailRow);
  $('rows').replaceChildren(fragment);
  positionDetail();
  $('empty').hidden = state.commits.length > 0;
  if (!state.commits.length) $('empty').replaceChildren(node('strong', '这个仓库还没有提交'), node('span', '创建提交后点击刷新。'));
  $('load-more').hidden = !state.hasMore;
  if (state.selected) renderCommitRefs();
  updateSearch();
}
function positionDetail(reveal = false) {
  for (const row of commitRows()) {
    const open = row.dataset.hash === state.selected && !detailRow.hidden;
    row.setAttribute('aria-expanded', String(open)); row.parentElement.classList.toggle('is-open', open);
    if (!open) continue;
    row.after(detailRow);
    const graph = state.graphRows.get(state.selected), ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const graphWidth = graph.width;
    detailRow.style.setProperty('--graph-width', `${graphWidth}px`);
    svg.setAttribute('width', graphWidth); svg.setAttribute('viewBox', `0 0 ${graphWidth} 1`);
    svg.setAttribute('preserveAspectRatio', 'none');
    for (const [lane, { color }] of graph.output.entries()) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', `M${laneX(lane)} 0V1`); path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', lane === graph.column && graph.parents.length ? '3' : '1'); path.setAttribute('vector-effect', 'non-scaling-stroke'); svg.append(path);
    }
    $('detail-graph').replaceChildren(svg);
    panels.render();
    if (reveal) {
      const viewport = $('history-scroll').getBoundingClientRect(), top = viewport.top;
      if (row.getBoundingClientRect().top < top || detailRow.getBoundingClientRect().bottom > viewport.bottom) {
        $('history-scroll').scrollTop += row.getBoundingClientRect().top - top;
      }
    }
  }
}
function setSearchOpen(open) {
  $('searchbar').hidden = !open;
  $('toggle-search').setAttribute('aria-expanded', String(open));
  if (open && $('history-pane').classList.contains('detail-maximized')) panels.setMaximized(false);
  updateSearch();
  $(open ? 'search' : 'toggle-search').focus();
}
function highlightSearch(element, pattern) {
  const text = element.textContent, parts = [], marks = [];
  let end = 0;
  if (pattern) for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(end, match.index));
    const mark = node('mark', match[0]); mark.dataset.searchMatch = '';
    parts.push(mark); marks.push(mark); end = match.index + match[0].length;
  }
  element.replaceChildren(...parts, text.slice(end));
  return marks;
}
function paintSearchMatch() {
  for (const [index, match] of state.matches.entries()) match.element.toggleAttribute('data-active', index === state.match);
  $('search-count').textContent = state.searchQuery ? `${state.match < 0 ? 0 : state.match + 1}/${state.matches.length} · 已加载历史` : '';
  $('prev-match').disabled = $('next-match').disabled = !state.matches.length;
}
function updateSearch() {
  const query = $('searchbar').hidden ? '' : $('search').value.trim();
  const previous = state.matches[state.match], sameQuery = query === state.searchQuery;
  const selectionChanged = state.searchSelection !== state.selected;
  const pattern = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu') : null;
  // ponytail: search covers loaded commits; load further pages to extend its scope without hiding graph ancestry.
  state.matches = [];
  for (const row of commitRows()) {
    const hash = row.dataset.hash;
    row.querySelector('.search-context')?.remove();
    const marks = [...row.querySelectorAll('.subject, .author, .ref-name')].flatMap(element => highlightSearch(element, pattern));
    // Reveal a hidden field only when the visible title, author and refs do not explain the match.
    if (pattern && !marks.length) {
      const commit = state.graphRows.get(hash);
      for (const [label, text] of [['SHA', hash], ['邮箱', commit.email],
        ...state.refs.filter(ref => ref.hash === hash).map(ref => ['引用', refsLabel(ref)])]) {
        const match = [...text.matchAll(pattern)][0];
        if (!match) continue;
        const start = Math.max(0, match.index - 6), end = Math.min(text.length, match.index + match[0].length + 6);
        const context = node('span', null, 'search-context');
        const value = node('span', `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`);
        context.append(`${label} `, value);
        context.title = `${label}: ${text}`;
        row.querySelector('.message').append(context);
        marks.push(...highlightSearch(value, pattern));
        break;
      }
    }
    row.classList.toggle('is-match', marks.length > 0);
    marks.forEach((element, index) => state.matches.push({ hash, key: `${hash}:${index}`, element }));
  }
  state.match = sameQuery && previous ? state.matches.findIndex(match => match.key === previous.key) : -1;
  if (selectionChanged) state.match = state.matches.findIndex(match => match.hash === state.selected);
  if (state.match < 0 && state.matches.length) state.match = 0;
  state.searchQuery = query; state.searchSelection = state.selected;
  paintSearchMatch();
}
function stepMatch(direction) {
  if (!state.matches.length) return;
  state.match = (state.match + direction + state.matches.length) % state.matches.length;
  const { hash } = state.matches[state.match];
  state.searchSelection = hash;
  if (hash !== state.selected || detailRow.hidden) selectCommit(hash);
  paintSearchMatch();
  state.matches[state.match]?.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function closeDetail(resetSelection = true) {
  ++state.detailVersion; ++state.diffVersion;
  if (resetSelection) state.selected = state.focused = '';
  state.detail = null; state.file = '';
  clearDiff(); detailRow.hidden = true; $('content').append(detailRow); panels.render();
  for (const row of commitRows()) {
    const selected = row.dataset.hash === state.selected;
    row.setAttribute('aria-pressed', String(selected)); row.setAttribute('aria-expanded', 'false');
    row.classList.toggle('is-focused', row.dataset.hash === state.focused);
    row.parentElement.classList.remove('is-open'); row.tabIndex = selected ? 0 : -1;
    if (selected) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }
  if (!state.selected && commitRows()[0]) commitRows()[0].tabIndex = 0;
  updateSearch();
}
async function selectCommit(hash, parent = 0, focus = false, file = '') {
  refreshCodeFontSize();
  const version = ++state.detailVersion; ++state.diffVersion;
  $('error').hidden = true;
  state.selected = hash; state.parent = parent; state.detail = null; state.file = file;
  for (const row of commitRows()) {
    const selected = row.dataset.hash === hash;
    row.setAttribute('aria-pressed', String(selected)); row.tabIndex = selected ? 0 : -1;
    if (selected && focus) row.focus({ preventScroll: true });
  }
  updateSearch();
  detailRow.hidden = false; positionDetail(true); $('detail-hash').textContent = hash.slice(0, 12);
  $('detail-hash').title = hash;
  renderCommitRefs();
  $('commit-message').textContent = '正在读取提交…'; $('commit-meta').textContent = '';
  $('files').replaceChildren(); clearDiff(); $('parent-label').hidden = true;
  $('open-file').disabled = true;
  $('diff-title').textContent = '选择文件查看差异'; $('files-label').textContent = '变更文件';
  try {
    const detail = await call('git_graph_commit', { hash, parent });
    if (version !== state.detailVersion) return;
    state.detail = detail;
    $('commit-message').textContent = detail.message || '（无提交说明）';
    $('commit-meta').replaceChildren(node('div', `${detail.author} <${detail.email}>`), node('div', new Date(detail.date).toLocaleString('zh-CN')));
    $('parent-label').hidden = detail.parents.length < 2;
    setSelectOptions($('parent'), detail.parents.map((hash, i) => ({ label: `${i + 1} · ${hash.slice(0, 12)}`, value: i })), parent);
    $('files-label').textContent = `变更文件 · ${detail.files.length}${detail.parents.length > 1 ? ` · 相对父提交 ${parent + 1}` : ''}`;
    for (const file of detail.files) {
      const button = node('button'); button.dataset.path = file.path; button.setAttribute('aria-pressed', 'false');
      button.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
      button.setAttribute('aria-label', `${file.status[0]} ${button.title}`);
      const slash = file.path.lastIndexOf('/');
      button.append(node('span', file.path.slice(slash + 1), 'file-path'));
      if (slash !== -1) button.append(node('span', file.path.slice(0, slash), 'file-directory'));
      button.append(node('span', file.status[0], `file-status ${file.status[0]}`)); $('files').append(button);
    }
    if (detail.files.length) await selectFile(detail.files.some(item => item.path === file) ? file : detail.files[0].path);
    else clearDiff('相对所选父提交没有文件变更。');
  } catch (e) {
    if (version !== state.detailVersion) return;
    $('commit-message').textContent = '提交读取失败'; error(e.message, () => selectCommit(hash, parent, false, file));
  }
}
async function selectFile(path) {
  const detail = state.detail;
  if (!detail) return;
  const version = ++state.diffVersion;
  $('error').hidden = true;
  state.file = path;
  $('open-file').disabled = false;
  for (const button of $('files').children) button.setAttribute('aria-pressed', String(button.dataset.path === path));
  const file = detail.files.find(file => file.path === path);
  $('diff-title').textContent = file.oldPath ? `${file.oldPath} → ${path}` : path;
  $('diff-title').title = $('diff-title').textContent;
  clearDiff('正在读取差异…');
  try {
    const result = await call('git_graph_diff', { ...detailArgs(detail), path });
    if (version !== state.diffVersion) return;
    showDiff(result);
  } catch (e) {
    if (version !== state.diffVersion) return;
    clearDiff('差异读取失败。'); error(e.message, () => selectFile(path));
  }
}

function detailArgs(detail) {
  return { hash: detail.hash, parent: detail.parent };
}
function activateCommit(hash, focus = false) {
  if (hash === state.selected && !detailRow.hidden) { closeDetail(false); return; }
  selectCommit(hash, 0, focus);
}

async function openWorkspaceFile() {
  const detail = state.detail, file = state.file, version = state.diffVersion;
  if (!detail || !file) return;
  $('open-file').disabled = true;
  try {
    const { path } = await call('git_graph_workspace_file', { ...detailArgs(detail), path: file });
    if (version !== state.diffVersion) return;
    const result = await app.request({ method: 'openai/files/open', params: { path } }, z.object({ isError: z.boolean().optional() }).passthrough());
    if (result.isError) throw new Error('Codex 未能打开工作区文件。');
  } catch (e) {
    if (version === state.diffVersion) error(e.message, openWorkspaceFile);
  } finally {
    if (version === state.diffVersion) $('open-file').disabled = false;
  }
}

$('branch').addEventListener('change', () => loadHistory());
$('repository').addEventListener('change', () => loadHistory(false, '', $('repository').value));
$('toggle-search').addEventListener('click', () => setSearchOpen($('searchbar').hidden || $('history-pane').classList.contains('detail-maximized')));
$('refresh').addEventListener('click', () => loadHistory());
$('load-more').addEventListener('click', () => { if (!state.loading) loadHistory(true); });
$('search').addEventListener('input', updateSearch);
$('search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); stepMatch(event.shiftKey ? -1 : 1); } });
$('prev-match').addEventListener('click', () => stepMatch(-1));
$('next-match').addEventListener('click', () => stepMatch(1));
$('rows').addEventListener('focusin', event => {
  const focused = event.target.closest('.commit-row'); if (!focused) return;
  state.focused = focused.dataset.hash;
  for (const row of commitRows()) row.classList.toggle('is-focused', row === focused);
});
$('rows').addEventListener('click', event => {
  const row = event.target.closest('.commit-row');
  if (row) activateCommit(row.dataset.hash);
});
$('rows').addEventListener('keydown', event => {
  const row = event.target.closest('.commit-row'); if (!row) return;
  const rows = commitRows(), index = rows.indexOf(row);
  let target = null;
  if (event.key === 'ArrowDown') target = rows[index + 1];
  if (event.key === 'ArrowUp') target = rows[index - 1];
  if (event.key === 'Home') target = rows[0];
  if (event.key === 'End') target = rows.at(-1);
  if (target) {
    event.preventDefault();
    selectCommit(target.dataset.hash, 0, true);
  }
});
$('files').addEventListener('click', event => { const button = event.target.closest('button'); if (button) selectFile(button.dataset.path); });
$('parent').addEventListener('change', () => selectCommit(state.selected, Number($('parent').value)));
$('close-detail').addEventListener('click', () => closeDetail(false));
$('open-file').addEventListener('click', openWorkspaceFile);
$('files').addEventListener('keydown', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const target = event.key === 'ArrowDown' ? button.nextElementSibling : event.key === 'ArrowUp' ? button.previousElementSibling : null;
  if (target) { event.preventDefault(); target.focus(); selectFile(target.dataset.path); }
});
$('dismiss-error').addEventListener('click', () => { $('error').hidden = true; });
$('retry').addEventListener('click', () => { $('error').hidden = true; retry?.(); });
document.addEventListener('keydown', event => {
  if (event.target.closest('#diff-editor')) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && state.repo) { event.preventDefault(); setSearchOpen(true); }
  if (event.key === 'Escape' && event.target.closest('#searchbar')) { event.preventDefault(); setSearchOpen(false); return; }
  if (event.key === 'Escape' && !detailRow.hidden && !document.activeElement.closest('input, select')) closeDetail(false);
});

app.onhostcontextchanged = theme;
app.ontoolresult = result => {
  if (result.isError) { $('history-pane').setAttribute('aria-busy', 'false'); error(result.content?.find(item => item.type === 'text')?.text || '打开失败', null); return; }
  const data = result.structuredContent;
  if (data?.repo && data.commits) {
    ++state.historyVersion; closeDetail(); acceptHistory(data);
    $('history-pane').setAttribute('aria-busy', 'false');
    state.loading = false; $('load-more').disabled = false; $('history-table').hidden = false; $('searchbar').inert = false;
    $('branch').disabled = false;
  } else if (data?.contextCwd) {
    ++state.historyVersion; closeDetail();
    state.repo = ''; state.repository = ''; state.repositories = []; state.branch = ''; state.commits = []; state.refs = []; state.tips = []; state.hasMore = false;
    $('history-pane').setAttribute('aria-busy', 'false');
    $('rows').replaceChildren(); $('toolbar').hidden = true; $('searchbar').hidden = true;
    $('toggle-search').setAttribute('aria-expanded', 'false'); $('search').value = ''; updateSearch();
    $('load-more').hidden = true;
    $('repo-label').textContent = ''; $('repo-label').title = data.contextCwd;
    $('empty').hidden = false;
    $('empty').replaceChildren(node('strong', '当前任务目录不属于 Git 仓库'), node('span', data.contextCwd));
  }
  if (data?.repositoryNotice) error(data.repositoryNotice, null);
};
app.onteardown = async () => {
  state.connected = false; clearInterval(fontTimer);
  ++state.historyVersion; ++state.detailVersion; ++state.diffVersion;
  panels.dispose(); disposeDiff(); await saveQueue; return {};
};
app.connect().then(() => {
  state.connected = true; theme(app.getHostContext() || {});
  $('open-file').hidden = !app.getHostCapabilities()?.experimental?.['openai/files'];
  loadLayout();
  // MCP host styles omit code size; only visible details poll the cached configuration.
  fontTimer = setInterval(() => { if (!document.hidden && !detailRow.hidden) refreshCodeFontSize(); }, 5000);
}).catch(e => {
  $('history-pane').setAttribute('aria-busy', 'false'); error(e.message, null);
});
