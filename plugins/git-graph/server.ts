import { McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { history, commit, compare, diff, compareDiff, workspaceFile, worktree, worktreeDiff, worktreeFile, repository } from './git.ts';
import { createWatchers } from './watch.ts';
import { readWorkspace, resolveRepositories, type GraphContext, type Workspace } from './project.ts';
import { createAppearanceReader } from './codex.ts';
import { panelsSchema, storedPanelsSchema, type PanelLayout } from './layout.ts';
import { error as messageError, msg, format, toMessage, type Message } from './i18n.ts';
import lightIcon from './assets/git-branch.svg';
import darkIcon from './assets/git-branch-dark.svg';

const html = await readFile(new URL('./window.html', import.meta.url), 'utf8');
// Hosts cache UI by resource URI. Changed content must have a different identity.
const resourceUri = `ui://git-graph/window-${createHash('sha256').update(html).digest('hex').slice(0, 16)}.html`;
const hash = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const repositoryId = z.string().regex(/^[0-9a-f]{64}$/).optional();
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const preferencesDirectory = join(process.env.CODEX_HOME || join(homedir(), '.codex'),
  'plugins/data/git-graph-codex-git-graph');

type WatchSession = { watchers: ReturnType<typeof createWatchers>; threadId?: string; signal?: AbortSignal };
type ToolContext = GraphContext & { repoPath: string; preferencesDirectory: string; session?: WatchSession };

function watchSession({ session }: ToolContext) {
  if (!session) throw messageError('backend.watch.sessionRequired');
  return session;
}
async function authorizeWatch(context: ToolContext, watchId: string) {
  const session = watchSession(context), path = session.watchers.getRepoPath(session.threadId, watchId);
  try {
    if (!context.repositories.some(repo => repo.path === path) || await realpath(path) !== path) {
      throw messageError('backend.watch.outsideTask');
    }
  } catch (error) { session.watchers.stop(session.threadId, watchId); throw error; }
  return session;
}

async function readPreference<S extends z.ZodType<object>>(directory: string, file: string, schema: S, label: Message): Promise<z.output<S>> {
  try { return schema.parse(JSON.parse(await readFile(join(directory, file), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return schema.parse({});
    throw messageError('backend.preference.read', { label, diagnostic: toMessage(error) }, error);
  }
}
async function writePreference(directory: string, file: string, value: object, label: Message) {
  const temporary = join(directory, `${file}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(directory, file));
    } finally { await rm(temporary, { force: true }); }
  } catch (error) { throw messageError('backend.preference.save', { label, diagnostic: toMessage(error) }, error); }
}
async function readLayout({ preferencesDirectory: directory }: ToolContext) {
  return {
    panels: await readPreference(directory, 'panel-layout.json', storedPanelsSchema, msg('backend.preference.layout')),
  };
}
async function saveLayout({ panels, preferencesDirectory: directory }: ToolContext & { panels: PanelLayout }) {
  await writePreference(directory, 'panel-layout.json', panels, msg('backend.preference.layout'));
  return { panels };
}
async function openGraph({ repositories, repositoryNotice, contextCwd = process.cwd(), defaultRepository, selectedRepository: selected, branch }: GraphContext & { selectedRepository?: string; branch?: string }) {
  const repo = repositories.find(repo => repo.id === selected) ?? repositories.find(repo => repo.id === defaultRepository) ?? repositories[0];
  const result = repo ? await history({ repoPath: repo.path, branch: repo.id === selected ? branch : undefined }) : { repo: null };
  return { ...result, contextCwd, repositories, repositoryNotice };
}
const readAppearance = createAppearanceReader();
// Keep each schema paired with its operation when dispatching tools by name.
function defineTool<S extends z.ZodObject, R extends Record<string, unknown>>(definition: {
  title: string; description?: string; schema: S;
  run: (input: z.output<S> & ToolContext) => Promise<R>;
  annotations?: typeof annotations;
}) {
  return { ...definition, async invoke(args: unknown, directory: string, context: GraphContext, session?: WatchSession) {
    const parsed = definition.schema.safeParse(args);
    if (!parsed.success) throw messageError('backend.tool.invalidInput', { diagnostic: toMessage(parsed.error) }, parsed.error);
    const input = parsed.data;
    let repoPath = context.repositories.find(repo => repo.id === context.defaultRepository)?.path || context.repositories[0]?.path || process.cwd();
    if ('repository' in definition.schema.shape) {
      const selected = input.repository ? context.repositories.find(repo => repo.id === input.repository)
        : context.repositories.find(repo => repo.id === context.defaultRepository) ?? context.repositories[0];
      if (!selected) throw messageError('backend.repository.outsideTask');
      repoPath = await repository(selected.path);
      if (repoPath !== selected.path) throw messageError('backend.repository.pathChanged');
    }
    return definition.run({ ...input, ...context, repoPath, preferencesDirectory: directory, session });
  } };
}

export const definitions = {
  git_graph_appearance: defineTool({ title: format(msg('backend.tool.readAppearance'), 'en'), schema: z.strictObject({}), run: readAppearance }),
  git_graph: defineTool({ title: 'Git Graph', description: 'Browse Git history for the current Codex task working directory. Read-only.',
    schema: z.strictObject({ selectedRepository: repositoryId, branch: z.string().max(1024).optional() }), run: openGraph }),
  git_graph_history: defineTool({ title: format(msg('backend.tool.readHistory'), 'en'), schema: z.strictObject({ repository: repositoryId, branch: z.string().max(1024).optional(),
    offset: z.number().int().min(0).max(1000000).optional(), tips: z.array(hash).max(10000).optional(),
    retain: z.array(hash).max(2).optional(),
    limit: z.number().int().min(1).max(500).optional() }), run: history }),
  git_graph_commit: defineTool({ title: format(msg('backend.tool.readCommit'), 'en'), schema: z.strictObject({ repository: repositoryId, hash, parent: z.number().int().min(0).optional() }), run: commit }),
  git_graph_compare: defineTool({ title: format(msg('backend.tool.readRange'), 'en'), schema: z.strictObject({ repository: repositoryId, base: hash, hash }), run: compare }),
  git_graph_diff: defineTool({ title: format(msg('backend.tool.readDiff'), 'en'), schema: z.strictObject({ repository: repositoryId, hash, parent: z.number().int().min(0).optional(),
    path: z.string().min(1).max(4096) }), run: diff }),
  git_graph_compare_diff: defineTool({ title: format(msg('backend.tool.readRangeDiff'), 'en'), schema: z.strictObject({ repository: repositoryId, base: hash, hash,
    path: z.string().min(1).max(4096) }), run: compareDiff }),
  git_graph_workspace_file: defineTool({ title: format(msg('backend.tool.locateFile'), 'en'), schema: z.strictObject({ repository: repositoryId, hash, base: hash.optional(), parent: z.number().int().min(0).optional(),
    path: z.string().min(1).max(4096) }), run: workspaceFile }),
  git_graph_worktree: defineTool({ title: format(msg('backend.tool.readWorktree'), 'en'), schema: z.strictObject({ repository: repositoryId }), run: worktree }),
  git_graph_worktree_diff: defineTool({ title: format(msg('backend.tool.readWorktreeDiff'), 'en'), schema: z.strictObject({ repository: repositoryId, group: z.enum(['staged', 'changes']),
    path: z.string().min(1).max(4096) }), run: worktreeDiff }),
  git_graph_worktree_file: defineTool({ title: format(msg('backend.tool.locateWorktreeFile'), 'en'), schema: z.strictObject({ repository: repositoryId, group: z.enum(['staged', 'changes']),
    path: z.string().min(1).max(4096) }), run: worktreeFile }),
  git_graph_watch_start: defineTool({ title: format(msg('backend.tool.startWatch'), 'en'), schema: z.strictObject({ repository: repositoryId }),
    annotations: { ...annotations, idempotentHint: false }, run: async context => {
      const session = watchSession(context);
      return session.watchers.start(session.threadId, context.repoPath);
    } }),
  git_graph_watch_wait: defineTool({ title: format(msg('backend.tool.waitWatch'), 'en'), schema: z.strictObject({ watchId: z.uuid(), revision: z.number().int().min(0) }),
    run: async context => {
      const session = await authorizeWatch(context, context.watchId);
      return session.watchers.wait(session.threadId, context.watchId, context.revision, session.signal);
    } }),
  git_graph_watch_stop: defineTool({ title: format(msg('backend.tool.stopWatch'), 'en'), schema: z.strictObject({ watchId: z.uuid() }), run: async context => {
    const session = watchSession(context); session.watchers.stop(session.threadId, context.watchId);
    return { stopped: true };
  } }),
  git_graph_layout: defineTool({ title: format(msg('backend.tool.readLayout'), 'en'), schema: z.strictObject({}), run: readLayout }),
  git_graph_editor: defineTool({ title: format(msg('backend.tool.readEditor'), 'en'), schema: z.strictObject({ locale: z.enum(['en', 'zh-CN']) }), run: async ({ locale }) => {
    const [script, style] = await Promise.all([locale === 'zh-CN' ? 'editor.zh-cn.js' : 'editor.en.js', 'editor.css'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
    return { script, style };
  } }),
  git_graph_save_layout: defineTool({ title: format(msg('backend.tool.saveLayout'), 'en'), description: 'Save global Git Graph panel layout in plugin data. Does not modify Git repositories.',
    schema: z.strictObject({ panels: panelsSchema }), run: saveLayout, annotations: { ...annotations, readOnlyHint: false } }),
};

function failure(error: unknown): CallToolResult {
  const descriptor = toMessage(error);
  return { isError: true, content: [{ type: 'text', text: format(descriptor, 'en') }], structuredContent: { error: descriptor } };
}

export async function call(name: string, args: unknown, directory = preferencesDirectory,
  context: GraphContext = { repositories: [] }, session?: WatchSession): Promise<CallToolResult> {
  try {
    if (!Object.hasOwn(definitions, name)) throw messageError('backend.tool.unknown');
    const data = await definitions[name as keyof typeof definitions].invoke(args, directory, context, session);
    return { content: [{ type: 'text', text: format(msg('backend.tool.completed'), 'en') }], structuredContent: data };
  } catch (error) {
    return failure(error);
  }
}

export function createServer({ preferencesDirectory: directory = preferencesDirectory, readContext = readWorkspace }: { preferencesDirectory?: string; readContext?: (threadId: string | undefined) => Promise<Workspace> } = {}) {
  const contexts = new Map<string | undefined, Promise<GraphContext>>();
  const watchers = createWatchers();
  const server = new McpServer({ name: 'git-graph', title: 'Git Graph', version: '0.3.0', icons: [
    { src: lightIcon, mimeType: 'image/svg+xml', sizes: ['any'], theme: 'light' },
    { src: darkIcon, mimeType: 'image/svg+xml', sizes: ['any'], theme: 'dark' },
  ] });
  const inputClosed = () => { watchers.close(); void server.close().catch(error => server.server.onerror?.(error)); };
  process.stdin.once('end', inputClosed); process.stdin.once('close', inputClosed);
  server.server.onclose = () => {
    process.stdin.removeListener('end', inputClosed); process.stdin.removeListener('close', inputClosed);
    watchers.close();
  };
  for (const [name, definition] of Object.entries(definitions)) {
    registerAppTool(server, name, { title: definition.title, description: definition.description || definition.title,
      inputSchema: definition.schema as z.ZodObject, annotations: definition.annotations || annotations,
      _meta: name === 'git_graph' ? {
        ui: { resourceUri, visibility: ['app', 'model'] },
        // Codex Desktop 26.908 supports these window entrypoints; keep standard MCP UI metadata too.
        'openai/ui': { entrypoints: [{ type: 'thread' }], preferredModelDisplayMode: 'fullscreen' },
      } : { ui: { visibility: ['app'] } },
    }, async (args: unknown, request: ServerContext) => {
      const parsed = z.string().optional().safeParse(request.mcpReq._meta?.threadId);
      if (!parsed.success) return failure(messageError('backend.tool.invalidInput', { diagnostic: toMessage(parsed.error) }, parsed.error));
      const threadId = parsed.data;
      if (name === 'git_graph') contexts.set(threadId, Promise.resolve().then(() => readContext(threadId)).then(resolveRepositories));
      let context: GraphContext | undefined;
      try { if (name === 'git_graph' || 'repository' in definition.schema.shape || name === 'git_graph_watch_wait') context = await contexts.get(threadId); }
      catch (error) { return failure(messageError('backend.task.read', { diagnostic: toMessage(error) }, error)); }
      if (!context?.repositories.length && ('repository' in definition.schema.shape || name === 'git_graph_watch_wait')) {
        return failure(msg('backend.task.unopened'));
      }
      return call(name, args, directory, context, { watchers, threadId, signal: request.mcpReq.signal });
    });
  }
  registerAppResource(server, 'Git Graph', resourceUri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({ contents: [{
    uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html,
    _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
  }] }));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createServer().connect(new StdioServerTransport());
}
