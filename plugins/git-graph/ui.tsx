import { render, type ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal, flushSync } from 'preact/compat';
import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';
import { layout, graphPaths, laneX, type GraphRow, type GraphRef } from './graph.ts';
import { widthsSchema, panelsSchema, type ColumnWidths } from './layout.ts';
import { createPanels, type PanelView } from './panels.ts';
import { Select, type SelectItem } from './select.tsx';
import { Icon } from './icons.tsx';
import type { definitions } from './server.ts';
import type { history, commit, diff } from './git.ts';
import type * as Editor from './diff-editor.ts';

type Tools = typeof definitions;
type Call = <K extends keyof Tools>(name: K, args: z.input<Tools[K]['schema']>) => Promise<Awaited<ReturnType<Tools[K]['invoke']>>>;
type History = Awaited<ReturnType<typeof history>>;
type Detail = Awaited<ReturnType<typeof commit>>;
type Diff = Awaited<ReturnType<typeof diff>>;
type Row = GraphRow<History['commits'][number]>;
type GraphResult = Awaited<ReturnType<Tools['git_graph']['invoke']>>;
type Repository = GraphResult['repositories'][number];
type HostContext = NonNullable<ReturnType<App['getHostContext']>>;
type NoticeValue = { message: string; retry?: () => void; tone?: 'info' | 'error' } | null;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const refsLabel = (ref: { name: string }) => ref.name.replace(/^refs\/(heads|remotes|tags)\//, '');

function Notice({ id, value, dismiss }: { id: string; value: NoticeValue; dismiss?: () => void }) {
  return <div id={id} class="error" hidden={!value} data-tone={value?.tone || 'error'} role={value?.tone === 'info' ? 'status' : 'alert'}>
    <span>{value?.message}</span>{value?.retry && <button id={`${id}-retry`} onClick={value.retry}>重试</button>}
    {dismiss && <button class="step" aria-label="关闭提示" onClick={dismiss}><Icon name="dismiss-error" /></button>}
  </div>;
}
function applyTheme(context: HostContext) {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.css?.fonts != null) {
    applyHostFonts(context.styles.css.fonts);
    $('__mcp-host-fonts').textContent = context.styles.css.fonts;
  }
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context['openai/interactionCursor']) document.documentElement.style.setProperty('--interaction-cursor', String(context['openai/interactionCursor']));
  const probe = document.createElement('span'); probe.hidden = true; document.body.append(probe);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const painter = canvas.getContext('2d', { willReadFrequently: true })!;
  // Flatten translucent host colors so overlapping SVG shapes do not accumulate opacity.
  for (const name of ['selected-surface', 'graph-current', 'graph-remote', 'graph-1', 'graph-2', 'graph-3', 'graph-4', 'graph-5']) {
    document.documentElement.style.removeProperty(`--${name}`); painter.clearRect(0, 0, 1, 1);
    for (const value of ['var(--bg)', `var(--${name === 'selected-surface' ? 'selected' : name})`]) {
      probe.style.color = value; painter.fillStyle = getComputedStyle(probe).color; painter.fillRect(0, 0, 1, 1);
    }
    document.documentElement.style.setProperty(`--${name}`, `rgb(${[...painter.getImageData(0, 0, 1, 1).data].slice(0, 3).join(',')})`);
  }
  probe.remove();
}
function refName(ref: GraphRef, refs: GraphRef[]) {
  const label = refsLabel(ref);
  if (refs.filter(other => refsLabel(other) === label).length < 2) return label;
  return `${ref.name.startsWith('refs/heads/') ? '本地' : ref.name.startsWith('refs/remotes/') ? '远程' : '标签'} · ${label}`;
}
type Part = string | { text: string; key: string };
type RowSearch = { refs: Part[][]; subject: Part[]; author: Part[]; context?: { title: string; label: string; parts: Part[] }; matches: string[] };
function searchRows(rows: Row[], refs: GraphRef[], query: string) {
  const matches: { key: string; hash: string }[] = [], result = new Map<string, RowSearch>();
  const pattern = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu') : null;
  // ponytail: search covers loaded commits; loading further pages extends its scope without hiding ancestry.
  for (const row of rows) {
    let index = 0;
    const keys: string[] = [];
    const parts = (text: string): Part[] => {
      const values: Part[] = []; let end = 0;
      if (pattern) for (const match of text.matchAll(pattern)) {
        const key = `${row.hash}:${index++}`;
        values.push(text.slice(end, match.index), { text: match[0], key }); end = match.index! + match[0].length;
        matches.push({ hash: row.hash, key }); keys.push(key);
      }
      values.push(text.slice(end)); return values;
    };
    const value: RowSearch = { refs: row.references.map(ref => parts(refName(ref, refs))), subject: parts(row.subject || '（无提交标题）'), author: parts(row.author), matches: keys };
    if (pattern && !keys.length) for (const [label, text] of [['SHA', row.hash], ['邮箱', row.email], ...refs.filter(ref => ref.hash === row.hash).map(ref => ['引用', refsLabel(ref)])]) {
      const match = [...text.matchAll(pattern)][0]; if (!match) continue;
      const start = Math.max(0, match.index! - 6), end = Math.min(text.length, match.index! + match[0].length + 6);
      value.context = { label, title: `${label}: ${text}`, parts: parts(`${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`) }; break;
    }
    result.set(row.hash, value);
  }
  return { rows: result, matches };
}
function Highlight({ parts, active }: { parts: Part[]; active: string }) {
  return <>{parts.map((part, index) => typeof part === 'string' ? part : <mark key={index} data-search-match="" data-match-key={part.key} data-active={part.key === active ? '' : undefined}>{part.text}</mark>)}</>;
}
function RefBadge({ reference: ref, refs, children }: { reference: Row['references'][number]; refs: GraphRef[]; children?: ComponentChildren }) {
  return <span class={`ref ${ref.icon}`} title={ref.name} aria-label={refName(ref, refs)} style={ref.color ? { '--ref-color': ref.color } : {}}><span class="ref-name">{children ?? refName(ref, refs)}</span></span>;
}
function CommitRow({ row, selected, focused, open, first, refs, search, active, choose, onFocus }: {
  row: Row; selected: string; focused: string; open: boolean; first: boolean; refs: GraphRef[]; search: RowSearch; active: string; choose(hash: string, keyboard?: boolean): void; onFocus(hash: string): void;
}) {
  const paths = graphPaths(row, 30), edge = row.parents.length || row.input[row.column]?.hash === row.hash;
  const circle = (radius: number, width: number, hollow = false) => <circle cx={laneX(row.column)} cy={15} r={radius} stroke-width={width} fill={hollow ? 'var(--bg)' : row.color} />;
  return <button class={`commit-row${row.kind === 'HEAD' ? ' current' : ''}${focused === row.hash ? ' is-focused' : ''}${search.matches.length ? ' is-match' : ''}`}
    data-hash={row.hash} data-selected={selected === row.hash ? '' : undefined} aria-expanded={open} aria-controls="detail-row"
    aria-label={`${row.subject}，${row.author}，${row.hash.slice(0, 8)}${row.references.length ? `，${row.references.map(ref => refName(ref, refs)).join('，')}` : ''}`}
    tabIndex={selected === row.hash || (!selected && first) ? 0 : -1}
    title={`${row.subject}\n${row.author} <${row.email}>\n${new Date(row.date).toLocaleString('zh-CN')}\n${row.hash}`}
    onClick={() => choose(row.hash)} onFocus={() => onFocus(row.hash)}>
    <svg class="graph" style={{ width: row.width }} width={row.width} height={30} aria-hidden="true">
      {paths.map((path, index) => <path key={index} d={path.d} stroke={path.color} fill="none" stroke-width="1" stroke-linecap="round" class={edge && index === paths.length - 1 ? 'node-edge' : undefined} />)}
      {row.kind === 'HEAD' ? <>{circle(7, 2)}{circle(2, 4, true)}</> : row.parents.length > 1 ? <>{circle(6, 2)}{circle(3, 2)}</> : circle(5, 2)}
    </svg>
    <span class="message"><span class="badges">{row.references.map((ref, i) => <RefBadge key={ref.name} reference={ref} refs={refs}><Highlight parts={search.refs[i]} active={active} /></RefBadge>)}</span>
      <span class="subject" title={row.subject}><Highlight parts={search.subject} active={active} /></span>
      {search.context && <span class="search-context" title={search.context.title}>{search.context.label} <span><Highlight parts={search.context.parts} active={active} /></span></span>}
    </span><span class="author" title={`${row.author} <${row.email}>`}><Highlight parts={search.author} active={active} /></span>
  </button>;
}
function Header({ history, repositories, repository, pending, busy, initial, searchOpen, query, match, count, branchNotice, onBranch, onRepository, refresh, toggleSearch, search, step }: {
  history: History | null; repositories: Repository[]; repository: string; pending: { branch: string; repository: string } | null; busy: boolean; initial: boolean;
  searchOpen: boolean; query: string; match: number; count: number; branchNotice: NoticeValue;
  onBranch(value: string): void; onRepository(value: string): void; refresh(): void; toggleSearch(): void; search(value: string): void; step(direction: number): void;
}) {
  const refs = history?.refs || [];
  const groups: SelectItem[] = [['本地分支', 'refs/heads/'], ['远程分支', 'refs/remotes/'], ['标签', 'refs/tags/']].map(([label, prefix]) => ({ label,
    options: refs.filter(ref => ref.name.startsWith(prefix)).map(ref => ({ label: refName(ref, refs), value: ref.name })) })).filter(group => group.options.length);
  const items = refs.length === 1 ? groups.flatMap(group => 'options' in group ? group.options : [group]) : [{ label: '所有分支与标签', value: '' }, ...groups];
  return <header id="header">
    <div id="toolbar-skeleton" hidden={!initial} role="status" aria-label="正在加载提交历史"><span class="skeleton-line" aria-hidden="true" /><span class="skeleton-block" aria-hidden="true" /></div>
    <div id="toolbar" hidden={!history}>
      <Select id="repository" aria-label="切换项目内仓库" icon="folder-light-16" value={pending?.repository ?? repository} disabled={repositories.length < 2}
        title={repositories.find(repo => repo.id === repository)?.displayPath || history?.repo}
        items={repositories.map(repo => ({ label: repositories.some(other => other.id !== repo.id && other.name === repo.name) ? (repo.displayPath || repo.path) : repo.name, value: repo.id, title: repo.displayPath || repo.path }))}
        onChange={event => onRepository(event.currentTarget.value)} />
      <Select id="branch" aria-label="筛选分支" icon="branch-light-16" items={items} value={pending?.branch ?? history?.branch ?? ''}
        disabled={refs.length < 2 || (!!pending && pending.repository !== repository)} onChange={event => onBranch(event.currentTarget.value)} />
      <span class="spacer" /><button id="toggle-search" class="step" title="搜索提交" aria-label="搜索提交" aria-controls="searchbar" aria-expanded={searchOpen} onClick={toggleSearch}><Icon name="toggle-search" /></button>
      <button id="refresh" class="step" title="重新读取仓库" aria-label="刷新" onClick={refresh}><Icon name="refresh" /></button>
    </div>
    <Notice id="branch-notice" value={branchNotice} />
    <div id="searchbar" hidden={!searchOpen} inert={busy && !!pending}>
      <label id="search-field"><Icon name="toggle-search" /><input id="search" type="search" aria-label="搜索已加载的提交" placeholder="搜索提交、作者或 SHA" value={query}
        onInput={event => search(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); } }} /></label>
      <span id="search-count" role="status">{query.trim() ? `${match < 0 ? 0 : match + 1}/${count} · 已加载历史` : ''}</span>
      <button class="step" id="prev-match" disabled={!count} title="上一个匹配" aria-label="上一个匹配" onClick={() => step(-1)}><Icon name="prev-match" /></button>
      <button class="step" id="next-match" disabled={!count} title="下一个匹配" aria-label="下一个匹配" onClick={() => step(1)}><Icon name="next-match" /></button>
    </div>
  </header>;
}
function ResizeHandle({ id, label, controls, view }: { id: string; label: string; controls: string; view: PanelView | null }) {
  const handle = view?.handles[id];
  return <div id={`${id}-resize`} class="panel-resize" role="separator" tabIndex={view?.ready ? 0 : -1} hidden={handle?.hidden}
    aria-label={label} aria-controls={controls} aria-orientation={id === 'files' ? 'vertical' : 'horizontal'}
    aria-valuemin={handle?.min} aria-valuemax={handle?.max} aria-valuenow={handle?.now} aria-valuetext={`${handle?.now || 0} 像素`} aria-disabled={!view?.ready}
    title="拖动调整大小；双击恢复默认；方向键微调" />;
}

function GitGraphApp() {
  const [app] = useState(() => new App({ name: 'Git Graph', version: '0.3.0' }));
  const connected = useRef(false), historyVersion = useRef(0), layoutReady = useRef(false), saveVersion = useRef(0);
  const widths = useRef<ColumnWidths>({}), saveQueue = useRef(Promise.resolve()), panels = useRef<ReturnType<typeof createPanels>>();
  const [panelView, setPanelView] = useState<PanelView | null>(null);
  const [history, setHistory] = useState<History | null>(null), historyRef = useRef(history); historyRef.current = history;
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const repository = repositories.find(repo => repo.path === history?.repo)?.id || '', repositoryRef = useRef(repository); repositoryRef.current = repository;
  const [selected, setSelected] = useState(''), [focused, setFocused] = useState(''), [open, setOpen] = useState(false), openRef = useRef(false); openRef.current = open;
  const [refreshVersion, setRefreshVersion] = useState(0), [busy, setBusy] = useState(true), [initial, setInitial] = useState(true);
  const [pending, setPending] = useState<{ branch: string; repository: string } | null>(null);
  const [contextCwd, setContextCwd] = useState(''), [searchOpen, setSearchOpen] = useState(false), [query, setQuery] = useState(''), [matchKey, setMatchKey] = useState('');
  const [connectionNotice, setConnectionNotice] = useState<NoticeValue>(null), [fontNotice, setFontNotice] = useState<NoticeValue>(null);
  const [historyNotice, setHistoryNotice] = useState<NoticeValue>(null), [repositoryNotice, setRepositoryNotice] = useState<NoticeValue>(null);
  const [branchNotice, setBranchNotice] = useState<NoticeValue>(null), [layoutNotice, setLayoutNotice] = useState<NoticeValue>(null);
  const [hostTheme, setHostTheme] = useState(''), [fontSize, setFontSize] = useState<number>(), [canOpenFile, setCanOpenFile] = useState(false);
  const [detailRow] = useState(() => { const el = document.createElement('div'); el.id = 'detail-row'; el.hidden = true; return el; });
  const parking = useRef<HTMLDivElement>(null), slots = useRef(new Map<string, HTMLDivElement>()), reveal = useRef(false), focusRow = useRef(false), searchFocus = useRef<string>();
  const graph = useMemo(() => layout(history?.commits || [], history || {}).rows, [history]);
  const search = useMemo(() => searchRows(graph, history?.refs || [], searchOpen ? query.trim() : ''), [graph, searchOpen, query]);
  const match = Math.max(search.matches.length ? 0 : -1, search.matches.findIndex(item => item.key === matchKey));
  const active = search.matches[match]?.key || '';
  const park = () => { if (parking.current && detailRow.parentNode !== parking.current) parking.current.append(detailRow); };
  const call = useCallback(async <K extends keyof Tools,>(name: K, args: z.input<Tools[K]['schema']>): Promise<Awaited<ReturnType<Tools[K]['invoke']>>> => {
    if (!connected.current) throw new Error('尚未连接到 Codex，请重新打开 Git Graph 窗口。');
    const result = await app.callServerTool({ name, arguments: repositoryRef.current && ['git_graph_history', 'git_graph_commit', 'git_graph_diff', 'git_graph_workspace_file'].includes(name)
      ? { repository: repositoryRef.current, ...args } : args });
    if (result.isError) throw new Error(result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'Git 查询失败。');
    if (!result.structuredContent) throw new Error('Git Graph 返回了无效的数据。');
    return result.structuredContent as Awaited<ReturnType<Tools[K]['invoke']>>;
  }, [app]);
  const fontRefresh = useRef<Promise<void> | null>(null);
  const refreshFont = useCallback(() => {
    if (!connected.current || fontRefresh.current) return fontRefresh.current;
    fontRefresh.current = call('git_graph_appearance', {}).then(data => {
      if (connected.current) { setFontSize(z.number().min(8).max(24).parse(data.codeFontSize)); setFontNotice(null); }
    }).catch(error => { if (connected.current) setFontNotice({ message: `无法读取 Codex 代码字号：${message(error)}`, retry: refreshFont }); })
      .finally(() => { fontRefresh.current = null; });
    return fontRefresh.current;
  }, [call]);
  function closeDetail(reset = false) {
    setOpen(false); detailRow.hidden = true; park();
    if (reset) { setSelected(''); setFocused(''); } else focusRow.current = true;
  }
  function choose(hash: string, keyboard = false) {
    if (hash === selected && open && !keyboard) { closeDetail(); return; }
    setSelected(hash); setOpen(true); reveal.current = true; focusRow.current = keyboard;
    setMatchKey(search.matches.find(item => item.hash === hash)?.key || ''); refreshFont();
  }
  function accept(data: History, append = false) {
    if (data.refs.length === 1) data = { ...data, branch: data.refs[0].name };
    park();
    setHistory(append && historyRef.current ? { ...data, commits: [...historyRef.current.commits, ...data.commits] } : data);
    setContextCwd('');
    if (!append && selected && !data.commits.some(commit => commit.hash === selected)) closeDetail(true);
    if (data.missingBranch) setBranchNotice({ message: `所选分支或标签“${refsLabel({ name: data.missingBranch })}”已不存在，${data.refs.length === 1 ? `已切换到“${refName(data.refs[0], data.refs)}”` : '已显示所有分支与标签'}`, tone: 'info' });
  }
  async function loadHistory(append = false, branch = historyRef.current?.branch || '', targetRepo = repositoryRef.current) {
    if (append && (busy || !historyRef.current?.hasMore)) return;
    const version = ++historyVersion.current, current = historyRef.current;
    const changingRepository = targetRepo !== repositoryRef.current, switching = changingRepository || branch !== current?.branch;
    if (switching) closeDetail(true);
    if (changingRepository) { setQuery(''); setMatchKey(''); }
    setBusy(true); setPending({ branch, repository: targetRepo }); setHistoryNotice(null); setBranchNotice(null);
    try {
      let data = await call('git_graph_history', { branch, ...(targetRepo ? { repository: targetRepo } : {}), ...(append && current ? { offset: current.commits.length, tips: current.tips } : {}) });
      if (version !== historyVersion.current) return;
      if (append && !data.missingBranch && current && (data.head !== current.head || data.headName !== current.headName || JSON.stringify(data.refs) !== JSON.stringify(current.refs))) {
        data = await call('git_graph_history', { branch, ...(targetRepo ? { repository: targetRepo } : {}) }); append = false;
        if (version !== historyVersion.current) return;
      }
      if (data.missingBranch) append = false;
      accept(data, append);
      if (!append) { $('history-scroll').scrollTop = 0; setRefreshVersion(value => value + 1); }
    } catch (error) {
      if (version === historyVersion.current) setHistoryNotice({ message: message(error), retry: () => loadHistory(append, branch, targetRepo) });
    } finally { if (version === historyVersion.current) { setBusy(false); setPending(null); setInitial(false); } }
  }
  async function loadLayout() {
    try {
      const data = await call('git_graph_layout', {});
      if (!connected.current) return;
      widths.current = widthsSchema.parse(data.widths); layoutReady.current = true; panels.current?.load(panelsSchema.parse(data.panels)); setLayoutNotice(null);
    } catch (error) { if (connected.current) setLayoutNotice({ message: `无法读取已保存的布局。${message(error)}`, retry: loadLayout }); }
  }
  function saveLayout() {
    const columnWidths = { ...widths.current }, preferences = panels.current!.preferences, version = ++saveVersion.current;
    saveQueue.current = saveQueue.current.then(async () => {
      try { await call('git_graph_save_layout', { widths: columnWidths, panels: preferences }); if (version === saveVersion.current) setLayoutNotice(null); }
      catch (error) { if (version === saveVersion.current) setLayoutNotice({ message: `布局尚未保存。${message(error)}`, retry: saveLayout }); }
    });
  }
  function toggleSearch(value = !searchOpen) {
    setSearchOpen(value); if (value && panelView?.maximized) panels.current?.setMaximized(false);
    if (value === searchOpen) $(value ? 'search' : 'toggle-search').focus();
    else searchFocus.current = value ? 'search' : 'toggle-search';
  }
  function step(direction: number) {
    if (!search.matches.length) return;
    const item = search.matches[(match + direction + search.matches.length) % search.matches.length];
    if (item.hash !== selected || !open) choose(item.hash);
    setMatchKey(item.key);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`mark[data-match-key="${item.key}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }
  useLayoutEffect(() => {
    if (searchFocus.current) { $(searchFocus.current).focus(); searchFocus.current = undefined; }
    detailRow.hidden = !open;
    detailRow.style.setProperty('--graph-width', `${graph.find(row => row.hash === selected)?.width || 0}px`);
    const slot = open ? slots.current.get(selected) : null;
    if (slot) { if (detailRow.parentNode !== slot) slot.append(detailRow); } else park();
    const row = document.querySelector<HTMLButtonElement>(`.commit-row[data-hash="${selected}"]`);
    if (focusRow.current && row) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    focusRow.current = false;
    panels.current?.render();
    if (reveal.current && row && open) {
      const viewport = $('history-scroll').getBoundingClientRect();
      if (row.getBoundingClientRect().top < viewport.top || detailRow.getBoundingClientRect().bottom > viewport.bottom) $('history-scroll').scrollTop += row.getBoundingClientRect().top - viewport.top;
    }
    reveal.current = false;
  });
  useLayoutEffect(() => {
    panels.current = createPanels({ ready: () => layoutReady.current, save: saveLayout, changed: (view, sync) => sync ? flushSync(() => setPanelView(view)) : setPanelView(view) });
    return () => panels.current?.dispose();
  }, []);
  useEffect(() => {
    app.onhostcontextchanged = context => { applyTheme(context); setHostTheme(`${context.theme || document.documentElement.dataset.theme}:${Date.now()}`); refreshFont(); };
    app.ontoolresult = result => {
      ++historyVersion.current; setBusy(false); setInitial(false); setPending(null);
      if (result.isError) { setHistoryNotice({ message: result.content?.find(item => item.type === 'text')?.text || '打开失败', retry: reloadInitial }); return; }
      const data = result.structuredContent as GraphResult | undefined;
      if (!data) return;
      closeDetail(true); setRepositories(data.repositories); repositoryRef.current = data.repositories.find(repo => repo.path === data.repo)?.id || '';
      if (data.repo && 'commits' in data) { park(); setHistory(data.refs.length === 1 ? { ...data, branch: data.refs[0].name } : data); setContextCwd(''); }
      else { park(); setHistory(null); setContextCwd(data.contextCwd); setSearchOpen(false); setQuery(''); }
      setHistoryNotice(null); setBranchNotice(null);
      setRepositoryNotice(data.repositoryNotice ? { message: data.repositoryNotice, tone: 'info' } : null);
    };
    async function reloadInitial() {
      setBusy(true); setInitial(true); setHistoryNotice(null);
      const version = ++historyVersion.current;
      try {
        const data = await call('git_graph', {});
        if (version === historyVersion.current) app.ontoolresult?.({ content: [], structuredContent: data });
      } catch (error) { if (version === historyVersion.current) { setBusy(false); setInitial(false); setHistoryNotice({ message: message(error), retry: reloadInitial }); } }
    }
    const visibility = () => { if (!document.hidden) refreshFont(); };
    window.addEventListener('focus', refreshFont); document.addEventListener('visibilitychange', visibility);
    const timer = setInterval(() => { if (!document.hidden && openRef.current) refreshFont(); }, 5000);
    app.onteardown = async () => { connected.current = false; ++historyVersion.current; clearInterval(timer); await saveQueue.current; render(null, $('root')); return {}; };
    let disposed = false;
    app.connect().then(() => {
      if (disposed) return;
      connected.current = true; applyTheme(app.getHostContext() || {}); setHostTheme(`${document.documentElement.dataset.theme}:${Date.now()}`); refreshFont();
      setCanOpenFile(Boolean(app.getHostCapabilities()?.experimental?.['openai/files'])); loadLayout();
    }).catch(error => { if (!disposed) { setBusy(false); setInitial(false); setConnectionNotice({ message: `${message(error)} 请重新打开 Git Graph 窗口。` }); } });
    return () => { disposed = true; connected.current = false; ++historyVersion.current; clearInterval(timer); window.removeEventListener('focus', refreshFont); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as Element;
      if (target.closest('#diff-editor')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && history) { event.preventDefault(); toggleSearch(true); }
      if (event.key === 'Escape' && target.closest('#searchbar')) { event.preventDefault(); toggleSearch(false); return; }
      if (event.key === 'Escape' && open && !document.activeElement?.closest('input, select')) closeDetail();
    };
    document.addEventListener('keydown', keydown); return () => document.removeEventListener('keydown', keydown);
  });
  const switching = !!pending && (pending.repository !== repository || pending.branch !== history?.branch);
  return <main id="app">
    <Header history={history} repositories={repositories} repository={repository} pending={pending} busy={busy} initial={initial} searchOpen={searchOpen} query={query} match={match} count={search.matches.length} branchNotice={branchNotice}
      onBranch={value => loadHistory(false, value)} onRepository={value => loadHistory(false, '', value)} refresh={() => loadHistory()} toggleSearch={() => toggleSearch(searchOpen && panelView?.maximized ? true : !searchOpen)} search={value => { setQuery(value); setMatchKey(''); }} step={step} />
    <Notice id="connection-error" value={connectionNotice} /><Notice id="font-error" value={fontNotice} /><Notice id="layout-error" value={layoutNotice} />
    <div id="content"><section id="history-pane" aria-label="提交历史" aria-busy={busy} class={panelView?.maximized && open ? 'detail-maximized' : ''} style={{ '--history-viewport-width': `${panelView?.width || 0}px` }}>
      <Notice id="repository-notice" value={repositoryNotice} /><Notice id="history-error" value={historyNotice} dismiss={() => setHistoryNotice(null)} />
      <div id="history-body"><div id="history-scroll">
        <div id="history-skeleton" hidden={!initial && !(busy && switching)} aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <div key={index} class="skeleton-row"><span class="skeleton-line" /></div>)}</div>
        <div id="history-table" hidden={busy && switching}><div id="rows" role="list" aria-label="Git 提交列表" title="选择提交查看差异" onKeyDown={event => {
          const row = (event.target as Element).closest<HTMLElement>('.commit-row'); if (!row) return;
          const index = graph.findIndex(item => item.hash === row.dataset.hash);
          const target = event.key === 'ArrowDown' ? graph[index + 1] : event.key === 'ArrowUp' ? graph[index - 1] : event.key === 'Home' ? graph[0] : event.key === 'End' ? graph.at(-1) : null;
          if (target) { event.preventDefault(); choose(target.hash, true); }
        }}>{graph.map((row, index) => <div key={row.hash} class={`commit-entry${open && selected === row.hash ? ' is-open' : ''}`} role="listitem">
          <CommitRow row={row} selected={selected} focused={focused} open={open && selected === row.hash} first={index === 0} refs={history!.refs} search={search.rows.get(row.hash)!} active={active} choose={choose} onFocus={setFocused} />
          <div class="detail-slot" ref={el => { if (el) slots.current.set(row.hash, el); else slots.current.delete(row.hash); }} />
        </div>)}</div></div>
        <button id="load-more" hidden={!history?.hasMore || switching} disabled={busy} onClick={() => loadHistory(true)}>加载更多</button>
        <div id="empty" class="empty" hidden={busy || !!history?.commits.length || !!historyNotice || !!connectionNotice}>
          <strong>{contextCwd ? '当前目录不属于 Git 仓库' : '这个仓库还没有提交'}</strong><span>{contextCwd || '创建提交后点击刷新。'}</span>
        </div>
      </div></div>
    </section><div ref={parking} id="detail-parking" hidden /></div>
    {createPortal(<CommitDetail call={call} app={app} selected={selected} open={open} repository={repository} refreshVersion={refreshVersion} row={graph.find(row => row.hash === selected)} refs={history?.refs || []}
      view={panelView} close={() => closeDetail()} maximize={() => panels.current?.setMaximized(!panelView?.maximized)} hostTheme={hostTheme} fontSize={fontSize} canOpenFile={canOpenFile} />, detailRow)}
  </main>;
}

function CommitDetail({ call, app, selected, open, repository, refreshVersion, row, refs, view, close, maximize, hostTheme, fontSize, canOpenFile }: {
  call: Call; app: App; selected: string; open: boolean; repository: string; refreshVersion: number; row?: Row; refs: GraphRef[];
  view: PanelView | null; close(): void; maximize(): void; hostTheme: string; fontSize?: number; canOpenFile: boolean;
}) {
  const [detail, setDetail] = useState<Detail | null>(null), [file, setFile] = useState(''), [parent, setParent] = useState(0);
  const [loading, setLoading] = useState(false), [notice, setNotice] = useState<NoticeValue>(null), version = useRef(0);
  const previous = useRef({ selected: '', repository: '' }), current = useRef({ parent, file }); current.current = { parent, file };
  async function load(parentIndex: number, selectedFile = '') {
    const request = ++version.current;
    setParent(parentIndex); setDetail(null); setFile(selectedFile); setLoading(true); setNotice(null);
    try {
      const result = await call('git_graph_commit', { hash: selected, parent: parentIndex });
      if (request !== version.current) return;
      setDetail(result); setFile(result.files.some(item => item.path === selectedFile) ? selectedFile : result.files[0]?.path || '');
    } catch (error) { if (request === version.current) setNotice({ message: message(error), retry: () => load(parentIndex, selectedFile) }); }
    finally { if (request === version.current) setLoading(false); }
  }
  useLayoutEffect(() => {
    const same = previous.current.selected === selected && previous.current.repository === repository;
    previous.current = { selected, repository };
    if (open && selected) load(same ? current.current.parent : 0, same ? current.current.file : '');
    else { ++version.current; setDetail(null); setFile(''); setNotice(null); setLoading(false); }
    return () => { ++version.current; };
  }, [selected, repository, open, refreshVersion]);
  return <>
    <div id="detail-graph" aria-hidden="true">{row && <svg width={row.width} viewBox={`0 0 ${row.width} 1`} preserveAspectRatio="none">
      {row.output.map((lane, index) => <path key={index} d={`M${laneX(index)} 0V1`} stroke={lane.color} stroke-width={index === row.column && row.parents.length ? 3 : 1} vector-effect="non-scaling-stroke" />)}
    </svg>}</div>
    <section id="detail" aria-label="提交详情" style={{ '--detail-height': `${view?.detail || 480}px`, '--graph-width': `${row?.width || 0}px` }}>
      <div id="detail-header"><div id="detail-identity"><code id="detail-hash" title={selected}>{selected.slice(0, 12)}</code><div id="commit-refs" aria-label="分支与标签">{row?.references.map(ref => <RefBadge key={ref.name} reference={ref} refs={refs} />)}</div></div>
        <button id="expand-detail" class="step" disabled={!view?.ready} aria-pressed={!!view?.maximized} title={view?.maximized ? '恢复历史与详情布局' : '放大详情'} aria-label={view?.maximized ? '恢复历史与详情布局' : '放大详情'} onClick={maximize}><Icon name="expand-detail" /></button>
        <button id="close-detail" class="step" title="关闭提交详情" aria-label="关闭提交详情" onClick={close}><Icon name="close-detail" /></button>
      </div>
      <div id="detail-content">
        <section id="summary-pane" aria-label="提交信息" aria-busy={loading} style={{ '--summary-height': view?.summary != null ? `${view.summary}px` : undefined }}>
          <div id="detail-summary"><Notice id="detail-error" value={notice} />
            <p id="commit-message" class={loading ? 'skeleton-line' : ''}>{loading ? '' : detail ? detail.message ? detail.message.replace(/\\r\\n|\\[nr]/g, '\n') : '（无提交说明）' : ''}</p>
            <div id="commit-meta">{detail && <><span>{detail.author} &lt;{detail.email}&gt;</span><span>{new Date(detail.date).toLocaleString('zh-CN')}</span></>}</div>
            <label id="parent-label" hidden={!detail || detail.parents.length < 2}>对比父提交<Select id="parent" aria-label="选择对比的父提交" value={parent}
              items={detail?.parents.map((hash, index) => ({ label: `${index + 1} · ${hash.slice(0, 12)}`, value: index })) || []} onChange={event => load(Number(event.currentTarget.value))} /></label>
          </div>
        </section>
        <ResizeHandle id="summary" label="调整提交信息与变更文件大小" controls="summary-pane changes-pane" view={view} />
        <ChangesPane call={call} app={app} detail={detail} file={file} selectFile={setFile} view={view} hostTheme={hostTheme} fontSize={fontSize} canOpenFile={canOpenFile} />
      </div>
      <ResizeHandle id="detail" label="调整提交详情高度" controls="detail" view={view} />
    </section>
  </>;
}
function FileList({ detail, file, selectFile, view }: { detail: Detail | null; file: string; selectFile(value: string): void; view: PanelView | null }) {
  return <section id="files-pane" aria-label="文件列表" style={{ '--files-width': view?.files != null ? `${view.files}px` : undefined }}><div id="files" role="listbox" aria-label="变更文件" onKeyDown={event => {
    const button = (event.target as Element).closest('button'); if (!button) return;
    const next = event.key === 'ArrowDown' ? button.nextElementSibling : event.key === 'ArrowUp' ? button.previousElementSibling : null;
    if (next instanceof HTMLButtonElement) { event.preventDefault(); next.focus(); selectFile(next.dataset.path!); }
  }}>{detail?.files.map(item => {
    const title = item.oldPath ? `${item.oldPath} → ${item.path}` : item.path, slash = item.path.lastIndexOf('/');
    return <button key={item.path} data-path={item.path} role="option" aria-selected={file === item.path} tabIndex={file === item.path ? 0 : -1} title={title} aria-label={`${item.status[0]} ${title}`} onClick={() => selectFile(item.path)}>
      <span class="file-path">{item.path.slice(slash + 1)}</span>{slash !== -1 && <span class="file-directory">{item.path.slice(0, slash)}</span>}<span class={`file-status ${item.status[0]}`}>{item.status[0]}</span>
    </button>;
  })}</div></section>;
}
function ChangesPane({ call, app, detail, file, selectFile, view, hostTheme, fontSize, canOpenFile }: {
  call: Call; app: App; detail: Detail | null; file: string; selectFile(value: string): void; view: PanelView | null; hostTheme: string; fontSize?: number; canOpenFile: boolean;
}) {
  const [result, setResult] = useState<Diff | null>(null), [loading, setLoading] = useState(false), [notice, setNotice] = useState<NoticeValue>(null), [openNotice, setOpenNotice] = useState<NoticeValue>(null);
  const [opening, setOpening] = useState(false), [split, setSplit] = useState(false), [status, setStatus] = useState<Editor.DiffStatus>({ text: '', canNavigate: false });
  const version = useRef(0), editor = useRef<typeof Editor>(), editorPromise = useRef<Promise<typeof Editor> | null>(null), alive = useRef(true);
  const context = useRef({ hostTheme, fontSize }); context.current = { hostTheme, fontSize };
  async function loadEditor() {
    editorPromise.current ||= call('git_graph_editor', {}).then(({ script, style }) => {
      if (!alive.current) throw new Error('Git Graph 已关闭。');
      const sheet = document.createElement('style'); sheet.textContent = style; document.head.append(sheet);
      const element = document.createElement('script'); element.textContent = script; document.head.append(element); element.remove();
      const loaded = (globalThis as typeof globalThis & { GitGraphEditor: typeof Editor }).GitGraphEditor;
      if (!loaded?.showDiff) { sheet.remove(); throw new Error('差异编辑器加载失败。'); }
      editor.current = loaded; loaded.onStatus(setStatus); loaded.themeDiff(document.documentElement.style.colorScheme || document.documentElement.dataset.theme || '');
      if (context.current.fontSize != null) loaded.setCodeFontSize(context.current.fontSize);
      return loaded;
    }).catch(error => { editorPromise.current = null; throw error; });
    return editorPromise.current;
  }
  async function load() {
    const request = ++version.current;
    editor.current?.clearDiff(); setResult(null); setNotice(null); setOpenNotice(null); setOpening(false);
    if (!detail || !file) { setLoading(false); return; }
    setLoading(true);
    try {
      const [data] = await Promise.all([call('git_graph_diff', { hash: detail.hash, parent: detail.parent, path: file }), loadEditor()]);
      if (request === version.current) setResult(data);
    } catch (error) { if (request === version.current) setNotice({ message: message(error), retry: load }); }
    finally { if (request === version.current) setLoading(false); }
  }
  useLayoutEffect(() => { load(); return () => { ++version.current; }; }, [detail, file]);
  const reasons = result ? [result.original, result.modified].flatMap((side, index) => side.reason ? [`${index ? '目标' : '基准'}：${side.reason}`] : []) : [];
  const comparable = !!result && !reasons.length;
  useLayoutEffect(() => { if (result && comparable) { editor.current?.setSplit(split); editor.current?.showDiff(result); } }, [result]);
  useEffect(() => {
    if (editor.current) { editor.current.themeDiff(document.documentElement.style.colorScheme || document.documentElement.dataset.theme || ''); if (fontSize != null) editor.current.setCodeFontSize(fontSize); }
  }, [hostTheme, fontSize]);
  useEffect(() => () => { alive.current = false; ++version.current; editor.current?.onStatus(() => {}); editor.current?.disposeDiff(); }, []);
  async function openFile() {
    if (!detail || !file) return;
    const request = version.current; setOpening(true); setOpenNotice(null);
    try {
      const { path } = await call('git_graph_workspace_file', { hash: detail.hash, parent: detail.parent, path: file });
      if (request !== version.current) return;
      const result = await app.request({ method: 'openai/files/open', params: { path } }, z.object({ isError: z.boolean().optional() }).passthrough());
      if (result.isError) throw new Error('Codex 未能打开工作区文件。');
    } catch (error) { if (request === version.current) setOpenNotice({ message: message(error), retry: openFile }); }
    finally { if (request === version.current) setOpening(false); }
  }
  const item = detail?.files.find(item => item.path === file), title = item?.oldPath ? `${item.oldPath} → ${file}` : file || '选择文件查看差异';
  return <section id="changes-pane" aria-label="变更文件">
    <div id="changes-header"><div id="changes-heading"><span id="files-label">{detail ? `变更文件 · ${detail.files.length}${detail.parents.length > 1 ? ` · 相对父提交 ${detail.parent + 1}` : ''}` : '变更文件'}</span><span id="diff-title" title={title}>{title}</span></div>
      <button id="diff-mode" class="step" data-mode={split ? 'split' : 'inline'} disabled={!comparable} aria-label={split ? '切换为行内差异' : '切换为并排差异'} title={split ? '切换为行内差异' : '切换为并排差异'} onClick={() => { setSplit(!split); editor.current?.setSplit(!split); }}><Icon name="diff-mode" /></button>
      <button id="prev-change" class="step" disabled={!status.canNavigate} title="上一处差异" aria-label="上一处差异" onClick={() => editor.current?.goToDiff('previous')}><Icon name="prev-change" /></button>
      <button id="next-change" class="step" disabled={!status.canNavigate} title="下一处差异" aria-label="下一处差异" onClick={() => editor.current?.goToDiff('next')}><Icon name="next-change" /></button>
      <button id="open-file" class="step" hidden={!canOpenFile} disabled={!detail || !file || opening} title="在 Codex 中打开工作区文件（当前内容）" aria-label="在 Codex 中打开工作区文件" onClick={openFile}><Icon name="open-file" /></button>
    </div><Notice id="file-error" value={openNotice} />
    <div id="detail-body"><FileList detail={detail} file={file} selectFile={selectFile} view={view} /><ResizeHandle id="files" label="调整文件列表与差异大小" controls="files-pane diff-pane" view={view} />
      <section id="diff-pane" aria-label="文件差异" aria-busy={loading}><div id="diff-content">
        <div id="diff-revisions" hidden={!result}>{result && [result.original, result.modified].map((side, index) => <span key={index} id={index ? 'diff-modified' : 'diff-original'} title={`${side.hash || '空树'}\n${side.path}${side.mode ? `\n文件模式：${side.mode}` : ''}`}>
          {`${index ? '目标' : '基准'} ${side.hash?.slice(0, 7) || '空树'}${side.exists ? '' : ' · 文件不存在'}${side.mode && result.original.mode !== result.modified.mode ? ` · ${side.mode}` : ''}`}
        </span>)}</div>
        <div id="diff-body"><div id="diff-editor" hidden={!comparable} /><Notice id="diff-error" value={notice} />
          <div id="diff-skeleton" hidden={!loading} role="status" aria-label="正在加载文件差异"><span class="skeleton-line" /><span class="skeleton-line" /><span class="skeleton-line" /></div>
          <div id="diff-notice" hidden={!reasons.length && !(detail && !detail.files.length)} role="status">{reasons.join('\n') || (detail && !detail.files.length ? '相对所选父提交没有文件变更。' : '')}</div>
        </div><div id="diff-status" role="status" aria-live="polite">{status.text}</div>
      </div></section>
    </div>
  </section>;
}
render(<GitGraphApp />, $('root'));
