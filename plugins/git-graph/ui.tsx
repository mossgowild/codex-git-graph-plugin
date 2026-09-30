import { render, type ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal, flushSync } from 'preact/compat';
import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';
import { layout, graphPaths, laneX, type GraphRow, type GraphRef, type SyntheticCommit } from './graph.ts';
import { panelsSchema } from './layout.ts';
import { createPanels, type PanelView } from './panels.ts';
import { Select, type SelectItem } from './select.tsx';
import { Icon } from './icons.tsx';
import { Tooltip } from './tooltip.tsx';
import type { definitions } from './server.ts';
import type { history, commit, diff, compare, compareDiff } from './git.ts';
import type * as Editor from './diff-editor.ts';
import { msg, format, toMessage, isMessage, resolveLocale, error as localizedError, type Locale, type Message, type MessageKey } from './i18n.ts';

type Tools = typeof definitions;
type Call = <K extends keyof Tools>(name: K, args: z.input<Tools[K]['schema']>, options?: Parameters<App['callServerTool']>[1]) => Promise<Awaited<ReturnType<Tools[K]['invoke']>>>;
type History = Awaited<ReturnType<typeof history>>;
type RangeDetail = Awaited<ReturnType<typeof compare>> & { target: 'incoming-changes' | 'outgoing-changes' };
type Detail = Awaited<ReturnType<typeof commit>> | RangeDetail;
type Diff = Awaited<ReturnType<typeof diff>> | Awaited<ReturnType<typeof compareDiff>>;
type Row = GraphRow<History['commits'][number] | SyntheticCommit>;
const isRange = (detail: Detail): detail is RangeDetail => 'target' in detail;
const fileKey = (_detail: Detail, file: Detail['files'][number]) => file.path;
const sameRefs = (a: History, b: History) => ['head', 'headName', 'refs', 'tips', 'currentRef', 'upstreamRef', 'baseRef', 'mergeBase'].every(key => JSON.stringify(a[key as keyof History]) === JSON.stringify(b[key as keyof History]));
type GraphResult = Awaited<ReturnType<Tools['git_graph']['invoke']>>;
type Repository = GraphResult['repositories'][number];
type HostContext = NonNullable<ReturnType<App['getHostContext']>>;
type NoticeValue = { message: Message | string; retry?: () => void; tone?: 'info' | 'error' } | null;
type HistoryNotice = NonNullable<NoticeValue> & { automatic?: true };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
let uiLocale: Locale = 'en';
const t = (key: MessageKey, params?: Message['params']) => format(msg(key, params), uiLocale);
const message = (value: unknown) => { const descriptor = toMessage(value); return descriptor.key === 'backend.external' ? msg('ui.externalError', { diagnostic: descriptor }) : descriptor; };
const rowSubject = (row: Row) => row.target === 'incoming-changes' ? t('ui.incoming') : row.target === 'outgoing-changes' ? t('ui.outgoing') : row.subject;
function toolError(result: { content?: { type: string; text?: string }[]; structuredContent?: unknown }) {
  const data = result.structuredContent;
  const descriptor = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
  return isMessage(descriptor) ? descriptor : msg('ui.queryFailure', { diagnostic: result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || msg('ui.openFailure') });
}
const refsLabel = (ref: { name: string }) => ref.name.replace(/^refs\/(heads|remotes|tags)\//, '');

function Notice({ id, value, dismiss }: { id: string; value: NoticeValue; dismiss?: () => void }) {
  const info = value?.tone === 'info';
  return <div class="notice-scope flex-none p-2" hidden={!value}><aside id={id} class="error" hidden={!value} data-tone={info ? 'info' : 'error'} role={info ? 'status' : 'alert'} aria-live={info ? 'polite' : 'assertive'}>
    <div class="notice-main flex w-full min-w-0 items-start gap-3 @min-[560px]:items-center"><span class="notice-icon flex flex-none pt-0.5 [&_svg]:size-[18px]"><Icon name={info ? 'notice-info' : 'notice-error'} /></span>
      <div class="notice-content flex min-w-0 flex-1 flex-col @min-[560px]:flex-row @min-[560px]:items-center @min-[560px]:justify-between @min-[560px]:gap-8"><span class="notice-message min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere leading-[1.625] text-pretty">{value && format(value.message, uiLocale)}</span>
        {value?.retry && <div class="notice-actions mt-2 flex self-start gap-2 @min-[560px]:mt-0 @min-[560px]:flex-none @min-[560px]:self-auto"><button id={`${id}-retry`} onClick={value.retry}>{t('ui.retry')}</button></div>}
      </div>
    </div>{dismiss && <button class="step" aria-label={t('ui.dismissNotice')} onClick={dismiss}><Icon name="dismiss-error" /></button>}
  </aside></div>;
}
function EmptyState({ id, hidden, title, description, class: sizing = 'min-h-full' }: { id: string; hidden?: boolean; title: string; description: string; class?: string }) {
  return <div id={id} class={`empty flex w-full flex-col items-center justify-center px-3 py-6 wrap-anywhere ${sizing}`} hidden={hidden} role="status"><div class="empty-content flex w-full max-w-[36rem] flex-col items-center justify-center gap-3 text-center">
    <div class="empty-illustration pointer-events-none flex items-center justify-center text-tertiary [&_svg]:h-18 [&_svg]:w-auto"><Icon name="empty-diff" /></div>
    <div class="empty-copy flex flex-col items-center gap-2"><strong class="text-ui-lg leading-6 font-ui-medium text-content">{title}</strong><span class="text-ui-sm leading-ui text-description whitespace-pre-wrap">{description}</span></div>
  </div></div>;
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
  for (const name of ['selected-surface', 'hover-surface', 'graph-current', 'graph-remote', 'graph-base', 'graph-1', 'graph-2', 'graph-3', 'graph-4', 'graph-5']) {
    document.documentElement.style.removeProperty(`--${name}`); painter.clearRect(0, 0, 1, 1);
    for (const value of ['var(--bg)', `var(--${name === 'selected-surface' ? 'selected' : name === 'hover-surface' ? 'color-background-primary-ghost-hover' : name})`]) {
      probe.style.color = value; painter.fillStyle = getComputedStyle(probe).color; painter.fillRect(0, 0, 1, 1);
    }
    document.documentElement.style.setProperty(`--${name}`, `rgb(${[...painter.getImageData(0, 0, 1, 1).data].slice(0, 3).join(',')})`);
  }
  probe.remove();
}
function refLabel(ref: GraphRef, refs: GraphRef[]): Message | string {
  const name = refsLabel(ref);
  if (refs.filter(other => refsLabel(other) === name).length < 2) return name;
  const kind = msg(ref.name.startsWith('refs/heads/') ? 'ui.local' : ref.name.startsWith('refs/remotes/') ? 'ui.remote' : 'ui.tag');
  return msg('ui.distinguishedRef', { kind, name });
}
function refName(ref: GraphRef, refs: GraphRef[]) { return format(refLabel(ref, refs), uiLocale); }
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
    const value: RowSearch = { refs: row.references.map(ref => parts(refName(ref, refs))), subject: parts(rowSubject(row) || t('ui.noSubject')), author: parts(row.author), matches: keys };
    if (pattern && !keys.length) for (const [label, text] of [['SHA', row.target === 'commit' ? row.hash : row.revision], [t('ui.email'), row.email], ...refs.filter(ref => ref.hash === row.hash).map(ref => [t('ui.reference'), refsLabel(ref)])]) {
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
function RefBadge({ reference: ref, refs, children, members, matchKeys = [], active }: { reference: Row['references'][number]; refs: GraphRef[]; children?: ComponentChildren; members?: Row['references']; matchKeys?: string[]; active?: string }) {
  return <span class="ref" data-tooltip={members ? members.map(ref => ref.name).join('\n') : ref.name} data-tooltip-overflow={members ? undefined : '.ref-name'}
    aria-label={members ? members.map(ref => refName(ref, refs)).join('，') : refName(ref, refs)} style={ref.color ? { '--ref-color': ref.color } : {}}
    data-match-keys={members && matchKeys.length ? matchKeys.join(' ') : undefined} data-search-match={members && matchKeys.length ? '' : undefined} data-active={members && active && matchKeys.includes(active) ? '' : undefined}>
    {members && members.length > 1 && <span>{members.length}</span>}{ref.icon && <Icon name={ref.icon} />}{!members && <span class="ref-name min-w-0 overflow-hidden text-ellipsis">{children ?? refName(ref, refs)}</span>}
  </span>;
}
function CommitRow({ row, selected, focused, open, first, refs, search, active, choose, onFocus }: {
  row: Row; selected: string; focused: string; open: boolean; first: boolean; refs: GraphRef[]; search: RowSearch; active: string; choose(hash: string, keyboard?: boolean): void; onFocus(hash: string): void;
}) {
  const paths = graphPaths(row, 30), edge = row.parents.length || row.input[row.column]?.hash === row.hash;
  const circle = (radius: number, width: number, hollow = false) => <circle cx={laneX(row.column)} cy={15} r={radius} stroke-width={width} fill={hollow ? 'var(--bg)' : row.color} />;
  const visible = row.references.map((reference, index) => ({ reference, parts: search.refs[index] })).filter(({ reference }) => reference.color);
  const primary = visible.shift(), groups = new Map<string, Map<Row['references'][number]['icon'], typeof visible>>();
  for (const item of visible) {
    const color = item.reference.color!, icon = item.reference.icon;
    if (!groups.has(color)) groups.set(color, new Map());
    const icons = groups.get(color)!;
    if (!icons.has(icon)) icons.set(icon, []);
    icons.get(icon)!.push(item);
  }
  return <button class={`commit-row${row.kind === 'HEAD' ? ' current' : ''}${row.target !== 'commit' ? ' io' : ''}${focused === row.hash ? ' is-focused' : ''}${search.matches.length ? ' is-match' : ''}`}
    data-hash={row.hash} data-selected={selected === row.hash ? '' : undefined} aria-expanded={open} aria-controls="detail-row"
    data-target={row.target} aria-label={`${rowSubject(row)}，${row.author}${row.target === 'commit' ? `，${row.hash.slice(0, 8)}` : ''}${row.references.length ? `，${row.references.map(ref => refName(ref, refs)).join('，')}` : ''}`}
    tabIndex={selected === row.hash || (!selected && first) ? 0 : -1}
    onClick={() => choose(row.hash)} onFocus={() => onFocus(row.hash)}>
    <svg class="graph mr-[4px] block h-[30px] flex-none self-stretch" style={{ width: row.width }} width={row.width} height={30} aria-hidden="true">
      {paths.map((path, index) => <path key={index} d={path.d} stroke={path.color} fill="none" stroke-width="1" stroke-linecap="round" class={edge && index === paths.length - 1 ? 'node-edge' : undefined} />)}
      {row.kind === 'HEAD' ? <>{circle(7, 2)}{circle(2, 4, true)}</> : row.target !== 'commit' ? <circle class="dashed-node" cx={laneX(row.column)} cy={15} r={5} stroke-width={1} stroke-dasharray="4,2" style={{ stroke: row.color }} fill="var(--row-bg)" /> : row.parents.length > 1 ? <>{circle(6, 2)}{circle(3, 2)}</> : circle(5, 2)}
    </svg>
    <span class="message flex min-w-0 flex-1 items-center gap-[8px] overflow-hidden"><span class="badges flex min-w-0 max-w-full flex-none items-center gap-[4px] overflow-x-auto overflow-y-hidden empty:hidden">
      {primary && <RefBadge reference={primary.reference} refs={refs}><Highlight parts={primary.parts} active={active} /></RefBadge>}
      {[...groups.values()].flatMap(icons => [...icons.values()].map(items => <RefBadge key={items[0].reference.name} reference={items[0].reference} refs={refs}
        members={items.map(item => item.reference)} matchKeys={items.flatMap(item => item.parts.flatMap(part => typeof part === 'string' ? [] : [part.key]))} active={active} />))}
    </span>
      <span class="subject flex-initial overflow-hidden text-ellipsis" data-tooltip={rowSubject(row)} data-tooltip-overflow=""><Highlight parts={search.subject} active={active} /></span>
      {search.context && <span class="search-context min-w-0 max-w-[45%] flex-initial overflow-hidden text-ellipsis text-ui-xs text-muted" data-tooltip={search.context.title}>{search.context.label} <span><Highlight parts={search.context.parts} active={active} /></span></span>}
    </span><span class="author ml-[12px] max-w-1/5 flex-initial overflow-hidden text-ellipsis text-ui-xs text-muted" data-tooltip={row.email ? `${row.author} <${row.email}>` : row.author} data-tooltip-overflow=""><Highlight parts={search.author} active={active} /></span>
  </button>;
}
function Header({ history, repositories, repository, pending, busy, initial, searchOpen, query, match, count, onBranch, onRepository, refresh, toggleSearch, search, step }: {
  history: History | null; repositories: Repository[]; repository: string; pending: { branch: string; repository: string } | null; busy: boolean; initial: boolean;
  searchOpen: boolean; query: string; match: number; count: number;
  onBranch(value: string): void; onRepository(value: string): void; refresh(): void; toggleSearch(): void; search(value: string): void; step(direction: number): void;
}) {
  const refs = history?.refs || [];
  const groups: SelectItem[] = [[t('ui.localBranches'), 'refs/heads/'], [t('ui.remoteBranches'), 'refs/remotes/'], [t('ui.tag'), 'refs/tags/']].map(([label, prefix]) => ({ label,
    options: refs.filter(ref => ref.name.startsWith(prefix)).map(ref => ({ label: refName(ref, refs), value: ref.name })) })).filter(group => group.options.length);
  const items = refs.length === 1 ? groups.flatMap(group => 'options' in group ? group.options : [group]) : [{ label: t('ui.allRefs'), value: '' }, ...groups];
  return <header id="header" class="flex-none border-0 border-b border-solid border-outline">
    <div id="toolbar-skeleton" class="flex min-h-10 items-center gap-[8px] px-app py-content" hidden={!initial} role="status" aria-label={t('ui.loadingHistory')}><span class="skeleton-line h-[16px] w-[112px]" aria-hidden="true" /><span class="skeleton-block ml-auto size-[28px]" aria-hidden="true" /></div>
    <div id="toolbar" class="flex min-h-10 items-center gap-1 px-app py-content" hidden={!history}>
      <Select id="repository" class="max-w-[34%]" aria-label={t('ui.repository')} icon="folder-light-16" value={pending?.repository ?? repository} disabled={repositories.length < 2}
        data-tooltip={repositories.find(repo => repo.id === repository)?.displayPath || history?.repo}
        items={repositories.map(repo => ({ label: repositories.some(other => other.id !== repo.id && other.name === repo.name) ? (repo.displayPath || repo.path) : repo.name, value: repo.id, title: repo.displayPath || repo.path }))}
        onChange={event => onRepository(event.currentTarget.value)} />
      <Select id="branch" class="max-w-1/2" aria-label={t('ui.branch')} icon="branch-light-16" items={items} value={pending?.branch ?? history?.branch ?? ''}
        disabled={refs.length < 2 || (!!pending && pending.repository !== repository)} onChange={event => onBranch(event.currentTarget.value)} />
      <span class="flex-1" /><button id="toggle-search" class="step" data-tooltip={t('ui.search')} aria-label={t('ui.search')} aria-controls="searchbar" aria-expanded={searchOpen} onClick={toggleSearch}><Icon name="toggle-search" /></button>
      <button id="refresh" class="step" data-tooltip={t('ui.refreshHint')} aria-label={t('ui.refresh')} onClick={refresh}><Icon name="refresh" /></button>
    </div>
    <div id="searchbar" class="flex items-center gap-1 px-app pb-2" hidden={!searchOpen} inert={busy && !!pending}>
      <div id="search-field" class="flex h-control min-w-0 flex-1 items-center gap-content rounded-control border border-solid border-outline bg-soft-alpha pl-control-x text-ui-md leading-[18px] text-muted [&>svg]:size-icon [&>svg]:flex-none"><Icon name="toggle-search" /><input id="search" class="h-full min-h-0 w-full flex-1 rounded-none border-0 bg-transparent p-0 pr-content text-content outline-none" type="text" aria-label={t('ui.searchLoaded')} placeholder={t('ui.searchPlaceholder')} value={query}
        onInput={event => search(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); } }} />
        {query.length > 0 && <button id="clear-search" type="button" aria-label={t('ui.clearSearch')} data-tooltip={t('ui.clearSearch')} onClick={() => { search(''); $('search').focus(); }}><Icon name="clear-search" /></button>}
      </div>
      <span id="search-count" class="text-ui-xs text-muted tabular-nums whitespace-nowrap empty:hidden" role="status">{query.trim() ? t('ui.loadedMatches', { current: match < 0 ? 0 : match + 1, count }) : ''}</span>
      <button class="step" id="prev-match" disabled={!count} data-tooltip={t('ui.previousMatch')} aria-label={t('ui.previousMatch')} onClick={() => step(-1)}><Icon name="prev-match" /></button>
      <button class="step" id="next-match" disabled={!count} data-tooltip={t('ui.nextMatch')} aria-label={t('ui.nextMatch')} onClick={() => step(1)}><Icon name="next-match" /></button>
    </div>
  </header>;
}
function ResizeHandle({ id, label, controls, view, hidden }: { id: string; label: string; controls: string; view: PanelView | null; hidden?: boolean }) {
  const handle = view?.handles[id];
  return <div id={`${id}-resize`} class="panel-resize" role="separator" tabIndex={view?.ready ? 0 : -1} hidden={hidden || handle?.hidden}
    aria-label={label} aria-controls={controls} aria-orientation={id === 'files' ? 'vertical' : 'horizontal'}
    aria-valuemin={handle?.min} aria-valuemax={handle?.max} aria-valuenow={handle?.now} aria-valuetext={t('ui.pixels', { size: handle?.now || 0 })} aria-disabled={!view?.ready}
    aria-description={t('ui.resizeHint')} />;
}

function GitGraphApp() {
  const [app] = useState(() => new App({ name: 'Git Graph', version: '0.3.0' }));
  const [locale, setLocale] = useState<Locale>(() => resolveLocale(app.getHostContext()?.locale, navigator.languages));
  uiLocale = locale;
  useLayoutEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const connected = useRef(false), historyVersion = useRef(0), layoutReady = useRef(false), saveVersion = useRef(0);
  const [ready, setReady] = useState(false), [visible, setVisible] = useState(!document.hidden), [watchAttempt, setWatchAttempt] = useState(0);
  const historyBusy = useRef(false), syncPending = useRef(false), syncQueue = useRef<Promise<void> | null>(null), synchronize = useRef<() => Promise<void>>();
  const stopWatching = useRef<() => Promise<void>>(async () => {});
  const saveQueue = useRef(Promise.resolve()), panels = useRef<ReturnType<typeof createPanels>>();
  const [panelView, setPanelView] = useState<PanelView | null>(null);
  const [history, setHistory] = useState<History | null>(null), historyRef = useRef(history); historyRef.current = history;
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const repository = repositories.find(repo => repo.path === history?.repo)?.id || '', repositoryRef = useRef(repository); repositoryRef.current = repository;
  const [selected, setSelected] = useState(''), selectedRef = useRef(selected); selectedRef.current = selected;
  const [focused, setFocused] = useState(''), [open, setOpen] = useState(false), openRef = useRef(false); openRef.current = open;
  const [refreshVersion, setRefreshVersion] = useState(0), [busy, setBusy] = useState(true), [initial, setInitial] = useState(true);
  const [pending, setPending] = useState<{ branch: string; repository: string } | null>(null);
  const [contextCwd, setContextCwd] = useState(''), [searchOpen, setSearchOpen] = useState(false), [query, setQuery] = useState(''), [matchKey, setMatchKey] = useState('');
  const [connectionNotice, setConnectionNotice] = useState<NoticeValue>(null), [fontNotice, setFontNotice] = useState<NoticeValue>(null);
  const [historyNotice, setHistoryNotice] = useState<HistoryNotice | null>(null), [repositoryNotice, setRepositoryNotice] = useState<NoticeValue>(null);
  const [branchNotice, setBranchNotice] = useState<NoticeValue>(null), [layoutNotice, setLayoutNotice] = useState<NoticeValue>(null);
  const [watchNotice, setWatchNotice] = useState<NoticeValue>(null);
  const [hostTheme, setHostTheme] = useState(''), [fontSize, setFontSize] = useState<number>(), [canOpenFile, setCanOpenFile] = useState(false);
  const [detailRow] = useState(() => { const el = document.createElement('div'); el.id = 'detail-row'; el.className = 'relative py-0.5 pr-[12px] pl-[calc(var(--graph-width,22px)+12px)]'; el.hidden = true; return el; });
  const parking = useRef<HTMLDivElement>(null), slots = useRef(new Map<string, HTMLDivElement>()), reveal = useRef(false), focusRow = useRef(false), searchFocus = useRef<string>();
  const readingPosition = useRef<{ top: number; hash?: string; offset: number; focus: HTMLElement | null }>();
  const graph = useMemo(() => layout(history?.commits || [], history || {}).rows, [history]);
  const search = useMemo(() => searchRows(graph, history?.refs || [], searchOpen ? query.trim() : ''), [graph, searchOpen, query, locale]);
  const match = Math.max(search.matches.length ? 0 : -1, search.matches.findIndex(item => item.key === matchKey));
  const active = search.matches[match]?.key || '';
  const park = () => { if (parking.current && detailRow.parentNode !== parking.current) parking.current.append(detailRow); };
  const call = useCallback(async <K extends keyof Tools,>(name: K, args: z.input<Tools[K]['schema']>, options?: Parameters<App['callServerTool']>[1]): Promise<Awaited<ReturnType<Tools[K]['invoke']>>> => {
    if (!connected.current) throw localizedError('ui.notConnected');
    const result = await app.callServerTool({ name, arguments: repositoryRef.current && ['git_graph_history', 'git_graph_commit', 'git_graph_diff', 'git_graph_compare', 'git_graph_compare_diff', 'git_graph_workspace_file', 'git_graph_watch_start'].includes(name)
      ? { repository: repositoryRef.current, ...args } : args }, options);
    if (result.isError) { const descriptor = toolError(result); throw Object.assign(new Error(format(descriptor, uiLocale)), { messageDescriptor: descriptor }); }
    if (!result.structuredContent) throw localizedError('ui.invalidData');
    return result.structuredContent as Awaited<ReturnType<Tools[K]['invoke']>>;
  }, [app]);
  const appearanceRefresh = useRef<Promise<void> | null>(null);
  const refreshAppearance = useCallback(() => {
    if (!connected.current || appearanceRefresh.current) return appearanceRefresh.current;
    appearanceRefresh.current = call('git_graph_appearance', {}).then(data => {
      if (connected.current) {
        const hover = z.object({ light: z.string(), dark: z.string() }).parse(data.ghostHover);
        document.documentElement.style.setProperty('--codex-hover-light', hover.light);
        document.documentElement.style.setProperty('--codex-hover-dark', hover.dark);
        for (const mode of ['light', 'dark'] as const) {
          const colors = z.object({ primarySoft: z.string(), textTertiary: z.string() }).parse(data.noticeColors[mode]);
          document.documentElement.style.setProperty(`--codex-primary-soft-${mode}`, colors.primarySoft);
          document.documentElement.style.setProperty(`--codex-text-tertiary-${mode}`, colors.textTertiary);
        }
        applyTheme({});
        setFontSize(z.number().min(8).max(24).parse(data.codeFontSize)); setFontNotice(null);
      }
    }).catch(error => { if (connected.current) setFontNotice({ message: msg('ui.appearanceFailure', { diagnostic: message(error) }), retry: refreshAppearance }); })
      .finally(() => { appearanceRefresh.current = null; });
    return appearanceRefresh.current;
  }, [call]);
  function closeDetail(reset = false) {
    setOpen(false); detailRow.hidden = true; park();
    if (reset) { setSelected(''); setFocused(''); } else focusRow.current = true;
  }
  function choose(hash: string, keyboard = false) {
    if (hash === selected && open && !keyboard) { closeDetail(); return; }
    setSelected(hash); setOpen(true); reveal.current = true; focusRow.current = keyboard;
    setMatchKey(search.matches.find(item => item.hash === hash)?.key || ''); refreshAppearance();
  }
  function accept(data: History, append = false, preserve = false) {
    const next = append && historyRef.current ? { ...data, commits: [...historyRef.current.commits, ...data.commits] } : data;
    if (JSON.stringify(next) !== JSON.stringify(historyRef.current)) {
      if (preserve) {
        const scroll = $('history-scroll'), top = scroll.getBoundingClientRect().top;
        const anchor = [...document.querySelectorAll<HTMLElement>('.commit-row')].find(row => row.getBoundingClientRect().bottom > top);
        readingPosition.current = { top: scroll.scrollTop, hash: anchor?.dataset.hash, offset: anchor ? anchor.getBoundingClientRect().top - top : 0, focus: document.activeElement instanceof HTMLElement ? document.activeElement : null };
      }
      historyRef.current = next; setHistory(next);
    }
    setContextCwd('');
    if (!append && selectedRef.current && !layout(next.commits, next).rows.some(row => row.hash === selectedRef.current)) closeDetail(true);
    if (data.missingBranch) setBranchNotice({ message: data.refs.length === 1 ? msg('ui.missingBranchOnly', { name: refsLabel({ name: data.missingBranch }), destination: refLabel(data.refs[0], data.refs) }) : msg('ui.missingBranchAll', { name: refsLabel({ name: data.missingBranch }) }), tone: 'info' });
  }
  async function loadHistory(append = false, branch = historyRef.current?.branch || '', targetRepo = repositoryRef.current) {
    if (append && (busy || !historyRef.current?.hasMore)) return;
    const version = ++historyVersion.current, current = historyRef.current, extending = append;
    const changingRepository = targetRepo !== repositoryRef.current, switching = changingRepository || branch !== current?.branch;
    if (changingRepository) await stopWatching.current();
    if (version !== historyVersion.current) return;
    if (switching) closeDetail(true);
    if (changingRepository) { setQuery(''); setMatchKey(''); }
    historyBusy.current = true; setBusy(true); setPending({ branch, repository: targetRepo }); setHistoryNotice(null); setBranchNotice(null);
    try {
      let data = await call('git_graph_history', { branch, ...(targetRepo ? { repository: targetRepo } : {}), ...(append && current ? { offset: current.commits.length, tips: current.tips } : {}) });
      if (version !== historyVersion.current) return;
      if (append && !data.missingBranch && current && !sameRefs(data, current)) {
        data = await readHistoryRange(branch, targetRepo, current.commits.length + data.commits.length, current); append = false;
        if (version !== historyVersion.current) return;
      }
      if (data.missingBranch) append = false;
      accept(data, append, extending);
      if (!append) { if (!extending) $('history-scroll').scrollTop = 0; setRefreshVersion(value => value + 1); }
    } catch (error) {
      if (version === historyVersion.current) setHistoryNotice({ message: message(error), retry: () => loadHistory(append, branch, targetRepo) });
    } finally { if (version === historyVersion.current) { historyBusy.current = false; setBusy(false); setPending(null); setInitial(false); if (changingRepository) setWatchAttempt(value => value + 1); if (syncPending.current) synchronize.current?.(); } }
  }
  async function readHistoryRange(branch: string, targetRepo: string, count: number, current = historyRef.current) {
    const selectedCommit = current && layout(current.commits, current).rows.find(row => row.hash === selectedRef.current && row.target === 'commit');
    const retain = [...new Set([current?.commits.at(-1)?.hash, selectedCommit?.hash].filter((hash): hash is string => !!hash))];
    let data = await call('git_graph_history', { repository: targetRepo, branch, retain, limit: Math.min(500, Math.max(1, count)) });
    const retained = data.retained || [], missingBranch = data.missingBranch;
    const commits = [...data.commits];
    while (data.hasMore && data.commits.length && (commits.length < count || retained.some(hash => !commits.some(commit => commit.hash === hash)))) {
      data = await call('git_graph_history', { repository: targetRepo, branch: data.branch, offset: commits.length, tips: data.tips, limit: Math.min(500, Math.max(250, count - commits.length)) });
      commits.push(...data.commits);
    }
    return { ...data, missingBranch: missingBranch || data.missingBranch, offset: 0, commits };
  }
  synchronize.current = () => {
    syncPending.current = true;
    if (historyBusy.current || syncQueue.current || !connected.current || document.hidden || !historyRef.current || !repositoryRef.current) return syncQueue.current || Promise.resolve();
    syncQueue.current = (async () => {
      while (syncPending.current && !historyBusy.current && connected.current && !document.hidden) {
        syncPending.current = false;
        const current = historyRef.current, targetRepo = repositoryRef.current, version = historyVersion.current;
        if (!current || !targetRepo) break;
        try {
          const probe = await call('git_graph_history', { repository: targetRepo, branch: current.branch, limit: 1 });
          const sameHistory = probe.branch === current.branch && sameRefs(probe, current);
          const data = sameHistory ? current : await readHistoryRange(current.branch, targetRepo, current.commits.length, current);
          if (version !== historyVersion.current || targetRepo !== repositoryRef.current || document.hidden) continue;
          accept(data, false, true); setHistoryNotice(value => value?.automatic ? null : value);
        } catch (error) {
          if (version === historyVersion.current && targetRepo === repositoryRef.current) setHistoryNotice(value => value && !value.automatic ? value : { automatic: true, message: message(error), retry: () => synchronize.current?.() });
        }
      }
    })().finally(() => { syncQueue.current = null; if (syncPending.current && !historyBusy.current && connected.current && !document.hidden) synchronize.current?.(); });
    return syncQueue.current;
  };
  async function refreshGraph() {
    const version = ++historyVersion.current;
    historyBusy.current = true; setBusy(true); setHistoryNotice(null); setBranchNotice(null);
    try {
      const data = await call('git_graph', { selectedRepository: repositoryRef.current || undefined, branch: historyRef.current?.branch });
      if (version !== historyVersion.current) return;
      const changed = data.repo !== historyRef.current?.repo;
      setRepositories(data.repositories);
      repositoryRef.current = data.repositories.find(repo => repo.path === data.repo)?.id || '';
      if (changed) { closeDetail(true); setQuery(''); setMatchKey(''); }
      if (data.repo && 'commits' in data) {
        const current = historyRef.current;
        const next = !changed && current && (current.commits.length > data.commits.length || !sameRefs(data, current))
          ? await readHistoryRange(data.branch, repositoryRef.current, current.commits.length) : data;
        if (version !== historyVersion.current) return;
        accept({ ...next, missingBranch: data.missingBranch || next.missingBranch }, false, !changed);
      }
      else { park(); setHistory(null); setContextCwd(data.contextCwd); setSearchOpen(false); }
      setRepositoryNotice(data.repositoryNotice ? { message: data.repositoryNotice, tone: 'info' } : null);
      setRefreshVersion(value => value + 1);
    } catch (error) { if (version === historyVersion.current) setHistoryNotice({ message: message(error), retry: refreshGraph }); }
    finally { if (version === historyVersion.current) { historyBusy.current = false; setBusy(false); setInitial(false); setPending(null); if (syncPending.current) synchronize.current?.(); } }
  }
  async function loadLayout() {
    try {
      const data = await call('git_graph_layout', {});
      if (!connected.current) return;
      layoutReady.current = true; panels.current?.load(panelsSchema.parse(data.panels)); setLayoutNotice(null);
    } catch (error) { if (connected.current) setLayoutNotice({ message: msg('ui.layoutReadFailure', { diagnostic: message(error) }), retry: loadLayout }); }
  }
  function saveLayout() {
    const preferences = panels.current!.preferences, version = ++saveVersion.current;
    saveQueue.current = saveQueue.current.then(async () => {
      try { await call('git_graph_save_layout', { panels: preferences }); if (version === saveVersion.current) setLayoutNotice(null); }
      catch (error) { if (version === saveVersion.current) setLayoutNotice({ message: msg('ui.layoutSaveFailure', { diagnostic: message(error) }), retry: saveLayout }); }
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
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-match-key="${item.key}"], [data-match-keys~="${item.key}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
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
    const position = readingPosition.current;
    if (position) {
      const scroll = $('history-scroll'), anchor = position.hash ? document.querySelector<HTMLElement>(`.commit-row[data-hash="${position.hash}"]`) : null;
      scroll.scrollTop = position.top;
      if (anchor) scroll.scrollTop += anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - position.offset;
      if (position.focus?.isConnected && document.activeElement !== position.focus) position.focus.focus({ preventScroll: true });
      readingPosition.current = undefined;
    }
    reveal.current = false;
  });
  useLayoutEffect(() => {
    panels.current = createPanels({ ready: () => layoutReady.current, save: saveLayout, changed: (view, sync) => sync ? flushSync(() => setPanelView(view)) : setPanelView(view) });
    return () => panels.current?.dispose();
  }, []);
  useEffect(() => {
    if (!ready || !visible || !repository) return;
    const controller = new AbortController(), targetRepo = repository;
    let stopped = false, stopPromise: Promise<void> | undefined;
    const starting = call('git_graph_watch_start', { repository: targetRepo });
    const stop = () => {
      stopped = true; controller.abort();
      return stopPromise ||= starting.then(data => call('git_graph_watch_stop', { watchId: data.watchId }), () => null).then(() => {}).catch(error => {
        if (connected.current && !document.hidden && repositoryRef.current === targetRepo) setWatchNotice({ message: msg('ui.watchStopFailure', { diagnostic: message(error) }), retry: () => { stopPromise = undefined; stop(); } });
      });
    };
    stopWatching.current = stop;
    (async () => {
      try {
        let data = await starting;
        if (stopped) return;
        setWatchNotice(null);
        await synchronize.current?.();
        while (!stopped && connected.current && !document.hidden && repositoryRef.current === targetRepo) {
          const event = await call('git_graph_watch_wait', { watchId: data.watchId, revision: data.revision }, { signal: controller.signal, timeout: 60000 });
          if (stopped || repositoryRef.current !== targetRepo) break;
          data = event;
          if (event.changed) await synchronize.current?.();
        }
      } catch (error) {
        if (!stopped && connected.current && repositoryRef.current === targetRepo) setWatchNotice({ message: msg('ui.watchFailure', { diagnostic: message(error) }), retry: () => setWatchAttempt(value => value + 1) });
      } finally { await stop(); }
    })();
    return () => { stop(); };
  }, [ready, visible, repository, watchAttempt]);
  useEffect(() => {
    const languageChanged = () => setLocale(resolveLocale(app.getHostContext()?.locale, navigator.languages));
    window.addEventListener('languagechange', languageChanged);
    app.onhostcontextchanged = context => { languageChanged(); applyTheme(context); setHostTheme(`${context.theme || document.documentElement.dataset.theme}:${Date.now()}`); refreshAppearance(); };
    app.ontoolresult = result => {
      ++historyVersion.current; historyBusy.current = false; setBusy(false); setInitial(false); setPending(null);
      if (result.isError) { setHistoryNotice({ message: toolError(result), retry: reloadInitial }); return; }
      const data = result.structuredContent as GraphResult | undefined;
      if (!data) return;
      closeDetail(true); setRepositories(data.repositories); repositoryRef.current = data.repositories.find(repo => repo.path === data.repo)?.id || '';
      if (data.repo && 'commits' in data) { park(); setHistory(data); setContextCwd(''); }
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
    const visibility = () => {
      setVisible(!document.hidden);
      if (document.hidden) stopWatching.current();
      else refreshAppearance();
    };
    window.addEventListener('focus', refreshAppearance); document.addEventListener('visibilitychange', visibility);
    const timer = setInterval(() => { if (!document.hidden && openRef.current) refreshAppearance(); }, 5000);
    app.onteardown = async () => { ++historyVersion.current; clearInterval(timer); await stopWatching.current(); await saveQueue.current; connected.current = false; render(null, $('root')); return {}; };
    let disposed = false;
    app.connect().then(() => {
      if (disposed) return;
      connected.current = true; setReady(true); languageChanged(); applyTheme(app.getHostContext() || {}); setHostTheme(`${document.documentElement.dataset.theme}:${Date.now()}`); refreshAppearance();
      setCanOpenFile(Boolean(app.getHostCapabilities()?.experimental?.['openai/files'])); loadLayout();
    }).catch(error => { if (!disposed) { setBusy(false); setInitial(false); setConnectionNotice({ message: msg('ui.connectionFailure', { diagnostic: message(error) }) }); } });
    const unload = () => { stopWatching.current(); };
    window.addEventListener('pagehide', unload);
    return () => { disposed = true; stopWatching.current(); connected.current = false; ++historyVersion.current; clearInterval(timer); window.removeEventListener('languagechange', languageChanged); window.removeEventListener('focus', refreshAppearance); window.removeEventListener('pagehide', unload); document.removeEventListener('visibilitychange', visibility); };
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
  return <main id="app" class="flex h-dvh flex-col overflow-hidden bg-panel">
    <Tooltip locale={locale} />
    <Header history={history} repositories={repositories} repository={repository} pending={pending} busy={busy} initial={initial} searchOpen={searchOpen} query={query} match={match} count={search.matches.length}
      onBranch={value => loadHistory(false, value)} onRepository={value => loadHistory(false, '', value)} refresh={refreshGraph} toggleSearch={() => toggleSearch(searchOpen && panelView?.maximized ? true : !searchOpen)} search={value => { setQuery(value); setMatchKey(''); }} step={step} />
    <Notice id="branch-notice" value={branchNotice} /><Notice id="connection-error" value={connectionNotice} /><Notice id="font-error" value={fontNotice} /><Notice id="layout-error" value={layoutNotice} /><Notice id="watch-error" value={watchNotice} />
    <div id="content" class="flex min-h-0 flex-1"><section id="history-pane" aria-label={t('ui.history')} aria-busy={busy} class={`flex min-h-0 min-w-0 flex-1 flex-col ${panelView?.maximized && open ? 'detail-maximized' : ''}`} style={{ '--history-viewport-width': `${panelView?.width || 0}px` }}>
      <Notice id="repository-notice" value={repositoryNotice} /><Notice id="history-error" value={historyNotice} dismiss={() => setHistoryNotice(null)} />
      <div id="history-body" class="flex min-h-0 min-w-0 flex-1 flex-col"><div id="history-scroll" class="relative flex-1 overflow-auto overflow-x-hidden py-0.5 [overflow-anchor:none]">
        <div id="history-skeleton" class="px-[8px] py-[4px]" hidden={!initial && !(busy && switching)} aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <div key={index} class="skeleton-row"><span class="skeleton-line" /></div>)}</div>
        <div id="history-table" class="w-full" hidden={busy && switching}><div id="rows" class="w-full" role="list" aria-label={t('ui.commitList')} onKeyDown={event => {
          const row = (event.target as Element).closest<HTMLElement>('.commit-row'); if (!row) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            const badges = row.querySelector<HTMLElement>('.badges');
            if (badges && badges.scrollWidth > badges.clientWidth) {
              event.preventDefault(); badges.scrollBy({ left: badges.clientWidth * (event.key === 'ArrowLeft' ? -1 : 1) });
            }
            return;
          }
          const index = graph.findIndex(item => item.hash === row.dataset.hash);
          const target = event.key === 'ArrowDown' ? graph[index + 1] : event.key === 'ArrowUp' ? graph[index - 1] : event.key === 'Home' ? graph[0] : event.key === 'End' ? graph.at(-1) : null;
          if (target) { event.preventDefault(); choose(target.hash, true); }
        }}>{graph.map((row, index) => <div key={row.hash} class={`commit-entry min-w-0${open && selected === row.hash ? ' is-open' : ''}`} role="listitem">
          <CommitRow row={row} selected={selected} focused={focused} open={open && selected === row.hash} first={index === 0} refs={history!.refs} search={search.rows.get(row.hash)!} active={active} choose={choose} onFocus={setFocused} />
          <div class="detail-slot" ref={el => { if (el) slots.current.set(row.hash, el); else slots.current.delete(row.hash); }} />
        </div>)}</div></div>
        <button id="load-more" class="mx-auto my-[8px] flex text-muted" hidden={!history?.hasMore || switching} disabled={busy} onClick={() => loadHistory(true)}>{t('ui.loadMore')}</button>
        <EmptyState id="empty" hidden={busy || !!history?.commits.length || !!historyNotice || !!connectionNotice}
          title={contextCwd ? t('ui.noRepository') : t('ui.noCommits')} description={contextCwd || t('ui.firstCommit')} />
      </div></div>
    </section><div ref={parking} id="detail-parking" hidden /></div>
    {createPortal(<CommitDetail locale={locale} call={call} app={app} selected={selected} open={open} visible={visible} repository={repository} refreshVersion={refreshVersion} row={graph.find(row => row.hash === selected)} refs={history?.refs || []}
      view={panelView} setFileView={value => panels.current?.setFileView(value)} close={() => closeDetail()} maximize={() => panels.current?.setMaximized(!panelView?.maximized)} hostTheme={hostTheme} fontSize={fontSize} canOpenFile={canOpenFile} />, detailRow)}
  </main>;
}

function CommitDetail({ locale, call, app, selected, open, visible, repository, refreshVersion, row, refs, view, setFileView, close, maximize, hostTheme, fontSize, canOpenFile }: {
  locale: Locale; call: Call; app: App; selected: string; open: boolean; visible: boolean; repository: string; refreshVersion: number; row?: Row; refs: GraphRef[];
  view: PanelView | null; setFileView(value: PanelView['fileView']): void; close(): void; maximize(): void; hostTheme: string; fontSize?: number; canOpenFile: boolean;
}) {
  const [detail, setDetail] = useState<Detail | null>(null), [file, setFile] = useState(''), [parent, setParent] = useState(0);
  const detailRef = useRef(detail); detailRef.current = detail;
  const [loading, setLoading] = useState(false), [notice, setNotice] = useState<NoticeValue>(null), version = useRef(0);
  const previous = useRef({ selected: '', repository: '' }), current = useRef({ parent, file }); current.current = { parent, file };
  async function load(parentIndex: number, selectedFile = '', preserve = false) {
    const request = ++version.current;
    setParent(parentIndex); if (!preserve) setDetail(null); setFile(selectedFile); setLoading(!preserve); setNotice(null);
    try {
      let result: Detail;
      if (row && row.target !== 'commit') {
        if (!row.base) throw localizedError('ui.missingBase');
        result = { ...await call('git_graph_compare', { base: row.base, hash: row.revision }), target: row.target };
      } else result = await call('git_graph_commit', { hash: selected, parent: parentIndex });
      if (request !== version.current) return;
      const previousFile = detailRef.current?.files.find(item => fileKey(detailRef.current!, item) === selectedFile);
      const samePath = previousFile ? result.files.filter(item => item.path === previousFile.path || item.oldPath === previousFile.path) : [];
      const selectedItem = result.files.find(item => fileKey(result, item) === selectedFile)
        || (samePath.length === 1 ? samePath[0] : undefined) || result.files[0];
      if (JSON.stringify(result) !== JSON.stringify(detailRef.current)) setDetail(result);
      setFile(selectedItem ? fileKey(result, selectedItem) : '');
    } catch (error) { if (request === version.current) setNotice({ message: message(error), retry: () => load(parentIndex, selectedFile, preserve) }); }
    finally { if (request === version.current) setLoading(false); }
  }
  useLayoutEffect(() => {
    const same = previous.current.selected === selected && previous.current.repository === repository;
    previous.current = { selected, repository };
    if (open && selected) load(same ? current.current.parent : 0, same ? current.current.file : '', same && !!detailRef.current);
    else { ++version.current; setDetail(null); setFile(''); setNotice(null); setLoading(false); }
    return () => { ++version.current; };
  }, [selected, repository, open, refreshVersion, row?.base, row?.revision, row?.target]);
  const showSummary = row?.target === 'commit', detailNotice = <Notice id="detail-error" value={notice} />;
  return <>
    <div id="detail-graph" class="pointer-events-none absolute inset-y-0 left-[8px] w-(--graph-width,20px) [&_svg]:block [&_svg]:h-full" aria-hidden="true">{row && <svg width={row.width} viewBox={`0 0 ${row.width} 1`} preserveAspectRatio="none">
      {row.output.map((lane, index) => <path key={index} d={`M${laneX(index)} 0V1`} stroke={lane.color} stroke-width={index === row.column && row.parents.length ? 3 : 1} vector-effect="non-scaling-stroke" />)}
    </svg>}</div>
    <section id="detail" class="sticky left-0 flex min-h-0 min-w-0 flex-col rounded-panel border-0 bg-panel p-card shadow-panel" aria-label={row?.target === 'commit' ? t('ui.commitDetail') : t('ui.rangeDetail')} style={{ '--detail-height': `${view?.detail || 480}px`, '--graph-width': `${row?.width || 0}px` }}>
      <div id="detail-header" class="flex min-h-control flex-none flex-wrap items-center gap-1 [&_button]:text-ui-xs [&_button]:text-muted"><div id="detail-identity" class="flex min-w-0 flex-1 flex-wrap items-center gap-x-control-x gap-y-1 px-content"><code id="detail-hash" class="max-w-full flex-none truncate text-ui-xs text-muted" data-tooltip={row?.target === 'commit' ? selected : undefined}>{row && row.target !== 'commit' ? rowSubject(row) : selected.slice(0, 12)}</code><div id="commit-refs" class="flex min-w-0 flex-wrap items-baseline gap-x-[6px] gap-y-[4px] text-ui-xs text-muted empty:hidden" aria-label={t('ui.refs')}>{row?.references.map(ref => <RefBadge key={ref.name} reference={ref} refs={refs} />)}</div></div>
        <button id="expand-detail" class="step" disabled={!view?.ready} aria-pressed={!!view?.maximized} data-tooltip={view?.maximized ? t('ui.restoreLayout') : t('ui.expandDetail')} aria-label={view?.maximized ? t('ui.restoreLayout') : t('ui.expandDetail')} onClick={maximize}><Icon name="expand-detail" /></button>
        <button id="close-detail" class="step" data-tooltip={t('ui.closeDetail')} aria-label={t('ui.closeDetail')} onClick={close}><Icon name="close-detail" /></button>
      </div>
      <div id="detail-content" class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-busy={loading}>
        <section id="summary-pane" class="flex min-h-0 min-w-0 flex-none flex-col overflow-hidden" hidden={!showSummary} aria-label={t('ui.commitInfo')} aria-busy={loading} style={{ '--summary-height': view?.summary != null ? `${view.summary}px` : undefined }}>
          <div id="detail-summary" class="min-h-0 flex-1 overflow-auto px-content pt-card pb-content">{showSummary && detailNotice}
            <p id="commit-message" class={`whitespace-pre-wrap wrap-anywhere leading-[1.6] ${loading ? 'skeleton-line mx-0 mt-[4px] mb-[16px] h-[14px] w-[64%]' : 'm-0 mb-[8px]'}`}>{loading ? '' : detail && !isRange(detail) ? detail.message ? detail.message.replace(/\\r\\n|\\[nr]/g, '\n') : t('ui.noMessage') : ''}</p>
            <div id="commit-meta" hidden={!!detail && isRange(detail)} class="flex min-w-0 items-baseline gap-[12px] text-ui-xs leading-[1.7] text-muted whitespace-nowrap [&_span]:min-w-0 [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span:last-child]:flex-none">{detail && !isRange(detail) && <><span>{detail.author} &lt;{detail.email}&gt;</span><span>{new Date(detail.date).toLocaleString(uiLocale)}</span></>}</div>
            <label id="parent-label" class="mt-[8px] flex items-center gap-[6px] text-muted" hidden={!detail || isRange(detail) || detail.parents.length < 2}>{t('ui.parentLabel')}<Select id="parent" aria-label={t('ui.parentSelect')} value={parent}
              items={detail?.parents.map((hash, index) => ({ label: `${index + 1} · ${hash.slice(0, 12)}`, value: index })) || []} onChange={event => load(Number(event.currentTarget.value))} /></label>
          </div>
        </section>
        <ResizeHandle id="summary" label={t('ui.resizeSummary')} controls="summary-pane changes-pane" view={view} hidden={!showSummary} />
        {!showSummary && detailNotice}
        <ChangesPane locale={locale} call={call} app={app} detail={detail} file={file} selectFile={setFile} open={open} visible={visible} view={view} setFileView={setFileView} hostTheme={hostTheme} fontSize={fontSize} canOpenFile={canOpenFile} />
      </div>
      <ResizeHandle id="detail" label={t('ui.resizeDetail')} controls="detail" view={view} />
    </section>
  </>;
}
function FileList({ detail, file, selectFile, view }: { detail: Detail | null; file: string; selectFile(value: string): void; view: PanelView | null }) {
  type Node = { path: string; name: string; item?: Detail['files'][number]; children?: Node[] };
  const mode = view?.fileView ?? 'list', tree = mode === 'tree';
  const [collapsed, setCollapsed] = useState(new Set<string>()), [focused, setFocused] = useState('');
  const container = useRef<HTMLDivElement>(null), buttons = useRef(new Map<string, HTMLButtonElement>()), hadFocus = useRef(false);
  hadFocus.current = !!container.current?.contains(document.activeElement);
  const roots = useMemo(() => {
    const nodes: Node[] = [], directories = new Map<string, Node>();
    for (const item of detail?.files || []) {
      const parts = item.path.split('/'); let children = nodes;
      for (let index = 0; index < parts.length - 1; index++) {
        const path = parts.slice(0, index + 1).join('/'); let directory = directories.get(path);
        if (!directory) { directory = { path, name: parts[index], children: [] }; directories.set(path, directory); children.push(directory); }
        children = directory.children!;
      }
      children.push({ path: item.path, name: parts.at(-1)!, item });
    }
    const sort = (nodes: Node[]) => {
      nodes.sort((a, b) => Number(!!b.children) - Number(!!a.children) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const node of nodes) if (node.children) sort(node.children);
    };
    sort(nodes); return nodes;
  }, [detail?.files]);
  const rows = useMemo(() => {
    const rows: { node: Node; key: string; level: number; parent: string; position: number; size: number }[] = [];
    const visit = (nodes: Node[], level: number, parent: string) => nodes.forEach((node, index) => {
      const key = `${node.children ? 'd' : 'f'}:${node.path}`;
      rows.push({ node, key, level, parent, position: index + 1, size: nodes.length });
      if (node.children && !collapsed.has(node.path)) visit(node.children, level + 1, key);
    });
    if (tree) visit(roots, 1, '');
    else visit((detail?.files || []).map(item => ({ path: item.path, name: item.path.slice(item.path.lastIndexOf('/') + 1), item })), 1, '');
    return rows;
  }, [roots, detail?.files, tree, collapsed]);
  const focusKey = rows.some(row => row.key === focused) ? focused : rows.find(row => row.node.item?.path === file)?.key
    || rows.findLast(row => row.node.children && file.startsWith(`${row.node.path}/`))?.key || rows[0]?.key;
  useLayoutEffect(() => { setCollapsed(new Set()); setFocused(''); }, [detail?.repo, detail?.hash, detail?.base, detail?.parent]);
  useLayoutEffect(() => { setFocused(`f:${file}`); }, [file]);
  useLayoutEffect(() => {
    if (tree) setCollapsed(previous => new Set([...previous].filter(path => !file.startsWith(`${path}/`))));
  }, [tree]);
  useLayoutEffect(() => {
    if (hadFocus.current && !container.current?.contains(document.activeElement) && focusKey) buttons.current.get(focusKey)?.focus();
  }, [rows, focusKey]);
  const toggle = (path: string) => setCollapsed(previous => { const next = new Set(previous); if (!next.delete(path)) next.add(path); return next; });
  const focus = (row: typeof rows[number] | undefined) => {
    if (!row) return;
    setFocused(row.key); buttons.current.get(row.key)?.focus();
    if (row.node.item) selectFile(row.node.path);
  };
  return <section id="files-pane" class="flex min-h-0 min-w-0 w-(--files-width,220px) flex-none flex-col overflow-hidden" aria-label={t('ui.fileList')} style={{ '--files-width': view?.files != null ? `${view.files}px` : undefined }}><div id="files" ref={container} class="min-h-0 flex-1 overflow-auto pt-0 pr-[6px] pb-[4px] pl-[3px]" role={tree ? 'tree' : 'listbox'} aria-label={tree ? t('ui.fileTree') : t('ui.files')} onKeyDown={event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button) return;
    const key = button.dataset.directory != null ? `d:${button.dataset.directory}` : `f:${button.dataset.file}`;
    const index = rows.findIndex(row => row.key === key), row = rows[index]; if (!row) return;
    let next: typeof row | undefined;
    if (event.key === 'ArrowDown') next = rows[index + 1];
    else if (event.key === 'ArrowUp') next = rows[index - 1];
    else if (tree && event.key === 'Home') next = rows[0];
    else if (tree && event.key === 'End') next = rows.at(-1);
    else if (tree && event.key === 'ArrowRight') {
      if (row.node.children) { if (collapsed.has(row.node.path)) toggle(row.node.path); else next = rows[index + 1]; }
    } else if (tree && event.key === 'ArrowLeft') {
      if (row.node.children && !collapsed.has(row.node.path)) toggle(row.node.path);
      else next = rows.find(item => item.key === row.parent);
    } else return;
    event.preventDefault(); focus(next);
  }}>{rows.map(({ node, key, level, position, size }) => {
    const item = node.item, directory = !!node.children, slash = node.path.lastIndexOf('/');
    const title = item?.oldPath ? `${item.oldPath} → ${node.path}` : node.path;
    return <button class={`flex w-full justify-start gap-[8px] rounded-item px-[6px] py-[4px] text-left text-ui-sm aria-selected:bg-selected ${tree ? 'items-center' : ''}`} key={key} ref={el => { if (el) buttons.current.set(key, el); else buttons.current.delete(key); }}
      data-path={item?.path} data-file={item?.path} data-directory={directory ? node.path : undefined} data-status={item?.status}
      role={tree ? 'treeitem' : 'option'} aria-level={tree ? level : undefined} aria-posinset={tree ? position : undefined} aria-setsize={tree ? size : undefined}
      aria-expanded={directory ? !collapsed.has(node.path) : undefined} aria-selected={directory ? undefined : file === node.path} tabIndex={key === focusKey ? 0 : -1}
      style={tree ? { paddingLeft: `${6 + (level - 1) * 12}px` } : undefined} data-tooltip={title} data-tooltip-overflow={item?.oldPath ? undefined : '.file-path, .file-directory'}
      aria-label={directory ? t('ui.directory', { path: node.path }) : `${item!.status[0]} ${title}`} onFocus={() => setFocused(key)} onClick={() => { setFocused(key); if (directory) toggle(node.path); else selectFile(node.path); }}>
      {tree && <span class="flex size-[12px] flex-none items-center justify-center [&_svg]:block [&_svg]:size-[12px]" aria-hidden="true">{directory && <span class={collapsed.has(node.path) ? '' : 'rotate-90'}><Icon name="tree-chevron" /></span>}</span>}
      <span class="file-path min-w-0 truncate">{node.name}</span>{!tree && slash !== -1 && <span class="file-directory min-w-0 max-w-[45%] truncate text-ui-xs text-muted">{node.path.slice(0, slash)}</span>}
      {item && <span class={`file-status ml-auto flex-none font-code text-ui-xs ${item.status[0]} ${item.status[0] === 'A' ? 'text-success' : item.status[0] === 'D' ? 'text-danger' : 'text-muted'}`}>{item.status[0]}</span>}
    </button>;
  })}</div></section>;
}
function ChangesPane({ locale, call, app, detail, file, selectFile, open, visible, view, setFileView, hostTheme, fontSize, canOpenFile }: {
  locale: Locale; call: Call; app: App; detail: Detail | null; file: string; selectFile(value: string): void; open: boolean; visible: boolean; view: PanelView | null; setFileView(value: PanelView['fileView']): void; hostTheme: string; fontSize?: number; canOpenFile: boolean;
}) {
  const [result, setResult] = useState<Diff | null>(null), [loading, setLoading] = useState(false), [notice, setNotice] = useState<NoticeValue>(null), [openNotice, setOpenNotice] = useState<NoticeValue>(null);
  const [opening, setOpening] = useState(false), [split, setSplit] = useState(false), [status, setStatus] = useState<Editor.DiffStatus>({ text: '', canNavigate: false });
  const [editorLoading, setEditorLoading] = useState(false);
  const version = useRef(0), openVersion = useRef(0), bindingVersion = useRef(0), alive = useRef(true);
  const editor = useRef<typeof Editor>(), activeLocale = useRef<Locale>();
  const runtimes = useRef(new Map<Locale, { api: typeof Editor; sheet: HTMLStyleElement }>());
  const resources = useRef(new Map<Locale, Promise<{ script: string; style: string }>>());
  const resultRef = useRef(result); resultRef.current = result;
  const resultTarget = useRef(''), renderedTarget = useRef('');
  const savedView = useRef<{ target: string; view?: Editor.DiffView }>();
  const item = detail?.files.find(item => fileKey(detail, item) === file), path = item?.path || '';
  const diffTarget = detail && item ? JSON.stringify([detail.repo, detail.hash, detail.base, detail.parent, item.status, path]) : '';
  const lastTarget = useRef(''), preserveView = useRef(false);
  const reasons = result ? [result.original, result.modified].flatMap((side, index) => side.reason ? [t('ui.reason', { label: index ? msg('ui.modified') : msg('ui.original'), reason: side.reason })] : []) : [];
  const comparable = !!result && !reasons.length;
  const context = useRef({ locale, fontSize, split, result, comparable, diffTarget, open, visible });
  context.current = { locale, fontSize, split, result, comparable, diffTarget, open, visible };
  function syncOptions(api: typeof Editor) {
    api.themeDiff(document.documentElement.style.colorScheme || document.documentElement.dataset.theme || '');
    if (context.current.fontSize != null) api.setCodeFontSize(context.current.fontSize);
    api.setSplit(context.current.split);
  }
  function releaseLanguage() {
    if (editor.current) {
      savedView.current = { target: renderedTarget.current, view: editor.current.saveDiffView() };
      editor.current.onStatus(() => {}); editor.current.disposeDiff(); editor.current = undefined;
    }
    activeLocale.current = undefined;
    setStatus({ text: '', canNavigate: false });
  }
  async function resource(language: Locale) {
    let pending = resources.current.get(language);
    if (!pending) {
      pending = call('git_graph_editor', { locale: language }).catch(error => { resources.current.delete(language); throw error; });
      resources.current.set(language, pending);
    }
    return pending;
  }
  async function bindEditor() {
    const snapshot = context.current, request = ++bindingVersion.current;
    const valid = () => alive.current && request === bindingVersion.current && context.current.locale === snapshot.locale && context.current.diffTarget === snapshot.diffTarget;
    if (editor.current && activeLocale.current !== snapshot.locale) releaseLanguage();
    if (!snapshot.result || !snapshot.comparable || resultTarget.current !== snapshot.diffTarget) {
      editor.current?.clearDiff(); setStatus({ text: '', canNavigate: false }); setEditorLoading(false); return;
    }
    if (!snapshot.open || !snapshot.visible) { setEditorLoading(false); return; }
    setNotice(null); setEditorLoading(true);
    try {
      let runtime = runtimes.current.get(snapshot.locale);
      if (!runtime) {
        const data = await resource(snapshot.locale);
        if (!valid()) return;
        // A second bundle sets global NLS during evaluation; no old editor may remain alive.
        releaseLanguage();
        const sheet = document.createElement('style'); sheet.dataset.editorLocale = snapshot.locale; sheet.textContent = data.style; document.head.append(sheet);
        const element = document.createElement('script'); element.textContent = data.script;
        try {
          document.head.append(element);
          const api = (globalThis as typeof globalThis & { GitGraphEditor: typeof Editor }).GitGraphEditor;
          if (!api?.activate || !api.saveDiffView || !api.showDiff) throw localizedError('ui.editorLoadFailure');
          runtime = { api, sheet }; runtimes.current.set(snapshot.locale, runtime);
        } catch (error) { sheet.remove(); throw error; }
        finally { element.remove(); }
      }
      if (!valid()) return;
      // Both standalone theme services emit global selectors, so keep their styles identical.
      for (const { api } of runtimes.current.values()) syncOptions(api);
      const api = runtime.api; api.activate(); editor.current = api; activeLocale.current = snapshot.locale;
      api.onStatus(value => { if (valid() && editor.current === api) setStatus(value); });
      const restore = savedView.current?.target === snapshot.diffTarget ? savedView.current.view : undefined;
      api.showDiff(snapshot.result, restore || preserveView.current); savedView.current = undefined;
      renderedTarget.current = snapshot.diffTarget; $('diff-editor').lang = snapshot.locale;
    } catch (error) { if (valid()) setNotice({ message: message(error), retry: bindEditor }); }
    finally { if (valid()) setEditorLoading(false); }
  }
  async function load() {
    const request = ++version.current;
    const preserve = !!detail && !!path && lastTarget.current === diffTarget && !!resultRef.current;
    lastTarget.current = diffTarget; preserveView.current = preserve;
    if (!preserve) { resultTarget.current = ''; editor.current?.clearDiff(); resultRef.current = null; setResult(null); }
    setNotice(null);
    if (!detail || !path) { resultTarget.current = ''; setResult(null); setLoading(false); return; }
    setLoading(!preserve);
    try {
      const data = isRange(detail) ? await call('git_graph_compare_diff', { base: detail.base, hash: detail.hash, path }) : await call('git_graph_diff', { hash: detail.hash, parent: detail.parent, path });
      if (request !== version.current) return;
      resultTarget.current = diffTarget;
      if (JSON.stringify(data) !== JSON.stringify(resultRef.current)) setResult(data);
    } catch (error) { if (request === version.current) setNotice({ message: message(error), retry: load }); }
    finally { if (request === version.current) setLoading(false); }
  }
  useLayoutEffect(() => { load(); return () => { ++version.current; }; }, [detail, file]);
  useLayoutEffect(() => {
    ++openVersion.current; setOpenNotice(null); setOpening(false);
    return () => { ++openVersion.current; };
  }, [diffTarget]);
  useLayoutEffect(() => { bindEditor(); return () => { ++bindingVersion.current; }; }, [result, locale, open, visible]);
  useEffect(() => { for (const { api } of runtimes.current.values()) syncOptions(api); }, [hostTheme, fontSize, split]);
  useEffect(() => () => {
    alive.current = false; ++version.current; ++bindingVersion.current;
    for (const { api, sheet } of runtimes.current.values()) { api.onStatus(() => {}); api.disposeDiff(); sheet.remove(); }
    runtimes.current.clear(); resources.current.clear();
  }, []);
  async function openFile() {
    if (!detail || !path) return;
    const request = ++openVersion.current; setOpening(true); setOpenNotice(null);
    try {
      if (!canOpenFile) throw localizedError('ui.noFileOpening');
      const { path: absolutePath } = await call('git_graph_workspace_file', isRange(detail) ? { base: detail.base, hash: detail.hash, path } : { hash: detail.hash, parent: detail.parent, path });
      if (request !== openVersion.current) return;
      const result = await app.request({ method: 'openai/files/open', params: { path: absolutePath } }, z.object({ isError: z.boolean().optional() }).passthrough());
      if (result.isError) throw localizedError('ui.fileOpenFailure');
    } catch (error) { if (request === openVersion.current) setOpenNotice({ message: message(error), retry: openFile }); }
    finally { if (request === openVersion.current) setOpening(false); }
  }
  const chooseFile = (value: string) => {
    selectFile(value);
  };
  const title = item?.oldPath ? `${item.oldPath} → ${path}` : path || t('ui.selectFile');
  const empty = !!detail && !detail.files.length;
  return <section id="changes-pane" class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('ui.files')}>
    <div id="changes-header" class="flex min-h-9 flex-none flex-wrap items-center gap-1 py-card"><div id="changes-heading" class="flex min-w-0 flex-1 items-center gap-content px-content py-card text-muted [&_span]:truncate"><span id="files-label" class="min-w-0 max-w-1/2 flex-initial text-ui-xs">{detail ? t(detail.parents.length > 1 ? 'ui.filesParent' : 'ui.filesCount', { count: detail.files.length, parent: detail.parent + 1 }) : t('ui.files')}</span><span id="diff-title" class="min-w-0 flex-1 truncate text-ui-xs text-muted" hidden={empty} data-tooltip={title} data-tooltip-overflow="">{title}</span></div>
      <button id="file-view" class="step" data-mode={view?.fileView ?? 'list'} disabled={!view?.ready} aria-label={t(view?.fileView === 'tree' ? 'ui.listView' : 'ui.treeView')} data-tooltip={t(view?.fileView === 'tree' ? 'ui.listView' : 'ui.treeView')} onClick={() => setFileView(view?.fileView === 'tree' ? 'list' : 'tree')}><Icon name={view?.fileView === 'tree' ? 'list-view' : 'tree-view'} /></button>
      <button id="diff-mode" class="step" data-mode={split ? 'split' : 'inline'} disabled={!comparable || !editor.current || editorLoading} aria-label={split ? t('ui.inline') : t('ui.split')} data-tooltip={split ? t('ui.inline') : t('ui.split')} onClick={() => { setSplit(!split); editor.current?.setSplit(!split); }}><Icon name="diff-mode" /></button>
      <button id="prev-change" class="step" disabled={!status.canNavigate} data-tooltip={t('ui.previousChange')} aria-label={t('ui.previousChange')} onClick={() => editor.current?.goToDiff('previous')}><Icon name="prev-change" /></button>
      <button id="next-change" class="step" disabled={!status.canNavigate} data-tooltip={t('ui.nextChange')} aria-label={t('ui.nextChange')} onClick={() => editor.current?.goToDiff('next')}><Icon name="next-change" /></button>
      <button id="open-file" class="step" hidden={!canOpenFile} disabled={!detail || !file || opening} data-tooltip={t('ui.openFileHint')} aria-label={t('ui.openFile')} onClick={openFile}><Icon name="open-file" /></button>
    </div><Notice id="file-error" value={openNotice} />
    <EmptyState id="changes-empty" class="min-h-0 flex-1 overflow-auto" hidden={!empty} title={t('ui.noFiles')} description={detail && isRange(detail) ? t('ui.noRangeFiles') : t('ui.noParentFiles')} />
    <div id="detail-body" class="flex min-h-0 min-w-0 flex-1" hidden={empty}><FileList detail={detail} file={file} selectFile={chooseFile} view={view} /><ResizeHandle id="files" label={t('ui.resizeFiles')} controls="files-pane diff-pane" view={view} />
      <section id="diff-pane" class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label={t('ui.fileDiff')} aria-busy={loading || editorLoading}><div id="diff-content" class="flex min-h-0 min-w-0 flex-1 flex-col">
        <div id="diff-revisions" class="flex flex-wrap gap-x-[16px] gap-y-[4px] px-[6px] py-[4px] text-ui-xs text-muted [&_span]:wrap-anywhere" hidden={!result}>{result && [result.original, result.modified].map((side, index) => <span key={index} id={index ? 'diff-modified' : 'diff-original'} data-tooltip={`${side.hash || t('ui.emptyTree')}\n${side.path}${side.mode ? `\n${t('ui.fileMode', { mode: side.mode })}` : ''}`}>
          {t('ui.revision', { label: index ? msg('ui.modified') : msg('ui.original'), hash: side.hash?.slice(0, 7) || msg('ui.emptyTree'), missing: side.exists ? '' : msg('ui.missingSuffix'), mode: side.mode && result.original.mode !== result.modified.mode ? ` · ${side.mode}` : '' })}
        </span>)}</div>
        <div id="diff-body" class="relative min-h-[80px] flex-1"><div id="diff-editor" class="absolute inset-0" hidden={!comparable} /><Notice id="diff-error" value={notice} />
          <div id="diff-skeleton" class="p-[16px] [&_.skeleton-line]:mb-[14px] [&_.skeleton-line]:h-[12px] [&_.skeleton-line]:w-3/4 [&_.skeleton-line:nth-child(2)]:w-[55%]" hidden={!loading && !editorLoading} role="status" aria-label={t('ui.loadingDiff')}><span class="skeleton-line" /><span class="skeleton-line" /><span class="skeleton-line" /></div>
          <EmptyState id="diff-notice" class="h-full min-h-full overflow-auto" hidden={!reasons.length} title={t('ui.unavailableDiff')} description={reasons.join('\n')} />
        </div><div id="diff-status" class="min-h-[22px] shrink-0 px-[6px] py-[3px] text-ui-xs text-muted" role="status" aria-live="polite">{status.text}</div>
      </div></section>
    </div>
  </section>;
}
render(<GitGraphApp />, $('root'));
