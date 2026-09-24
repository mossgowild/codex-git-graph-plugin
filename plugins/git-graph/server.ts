import { McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { history, commit, diff, workspaceFile, repository, repositoryInfo } from './git.ts';
import { readProjectRoots } from './project.ts';
import { createCodeFontSizeReader } from './codex.ts';
import { panelsSchema, storedPanelsSchema, type PanelLayout } from './layout.ts';
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

type Repository = { id: string; name: string; path: string; displayPath: string };
type GraphContext = { repositories: Repository[]; repositoryNotice?: string; contextCwd?: string };
type ToolContext = GraphContext & { repoPath: string; preferencesDirectory: string };

async function readPreference<S extends z.ZodType<object>>(directory: string, file: string, schema: S, label: string): Promise<z.output<S>> {
  try { return schema.parse(JSON.parse(await readFile(join(directory, file), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return schema.parse({});
    throw new Error(`读取${label}失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
async function writePreference(directory: string, file: string, value: object, label: string) {
  const temporary = join(directory, `${file}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(directory, file));
    } finally { await rm(temporary, { force: true }); }
  } catch (error) { throw new Error(`保存${label}失败：${error instanceof Error ? error.message : String(error)}`); }
}
async function readLayout({ preferencesDirectory: directory }: ToolContext) {
  return {
    panels: await readPreference(directory, 'panel-layout.json', storedPanelsSchema, '面板布局'),
  };
}
async function saveLayout({ panels, preferencesDirectory: directory }: ToolContext & { panels: PanelLayout }) {
  await writePreference(directory, 'panel-layout.json', panels, '面板布局');
  return { panels };
}
async function openGraph({ repositories, repositoryNotice, contextCwd = process.cwd() }: GraphContext) {
  const result = repositories.length ? await history({ repoPath: repositories[0].path }) : { repo: null };
  return { ...result, contextCwd, repositories, repositoryNotice };
}
const readCodeFontSize = createCodeFontSizeReader();
// Keep each schema paired with its operation when dispatching tools by name.
function defineTool<S extends z.ZodObject, R extends Record<string, unknown>>(definition: {
  title: string; description?: string; schema: S;
  run: (input: z.output<S> & ToolContext) => Promise<R>;
  annotations?: typeof annotations;
}) {
  return { ...definition, async invoke(args: unknown, directory: string, context: GraphContext) {
    const input = definition.schema.parse(args);
    let repoPath = context.repositories[0]?.path || process.cwd();
    if (input.repository) {
      const selected = context.repositories.find(repo => repo.id === input.repository);
      if (!selected) throw new Error('所选仓库不属于当前任务的项目，请重新打开 Git Graph。');
      repoPath = await repository(selected.path);
      if (repoPath !== selected.path) throw new Error('所选仓库路径已变化，请重新打开 Git Graph。');
    }
    return definition.run({ ...input, ...context, repoPath, preferencesDirectory: directory });
  } };
}

export const definitions = {
  git_graph_appearance: defineTool({ title: '读取 Codex 代码字号', schema: z.strictObject({}), run: readCodeFontSize }),
  git_graph: defineTool({ title: 'Git Graph', description: 'Browse Git history for the current Codex task working directory. Read-only.',
    schema: z.strictObject({}), run: openGraph }),
  git_graph_history: defineTool({ title: '读取提交历史', schema: z.strictObject({ repository: repositoryId, branch: z.string().max(1024).optional(),
    offset: z.number().int().min(0).max(1000000).optional(), tips: z.array(hash).max(10000).optional(),
    limit: z.number().int().min(1).max(500).optional() }), run: history }),
  git_graph_commit: defineTool({ title: '查看提交', schema: z.strictObject({ repository: repositoryId, hash, parent: z.number().int().min(0).optional() }), run: commit }),
  git_graph_diff: defineTool({ title: '查看文件差异', schema: z.strictObject({ repository: repositoryId, hash, parent: z.number().int().min(0).optional(),
    path: z.string().min(1).max(4096) }), run: diff }),
  git_graph_workspace_file: defineTool({ title: '定位工作区文件', schema: z.strictObject({ repository: repositoryId, hash, parent: z.number().int().min(0).optional(),
    path: z.string().min(1).max(4096) }), run: workspaceFile }),
  git_graph_layout: defineTool({ title: '读取 Git Graph 布局', schema: z.strictObject({}), run: readLayout }),
  git_graph_editor: defineTool({ title: '加载历史差异编辑器', schema: z.strictObject({}), run: async () => {
    const [script, style] = await Promise.all(['editor.js', 'editor.css'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
    return { script, style };
  } }),
  git_graph_save_layout: defineTool({ title: '保存 Git Graph 布局', description: 'Save global Git Graph panel layout in plugin data. Does not modify Git repositories.',
    schema: z.strictObject({ panels: panelsSchema }), run: saveLayout, annotations: { ...annotations, readOnlyHint: false } }),
};

export async function call(name: string, args: unknown, directory = preferencesDirectory,
  context: GraphContext = { repositories: [] }): Promise<CallToolResult> {
  try {
    if (!Object.hasOwn(definitions, name)) throw new Error('未知的 Git Graph 操作。');
    const data = await definitions[name as keyof typeof definitions].invoke(args, directory, context);
    return { content: [{ type: 'text', text: 'Git Graph 操作完成。' }], structuredContent: data };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
  }
}

export function createServer({ preferencesDirectory: directory = preferencesDirectory, projectRoots = readProjectRoots }: { preferencesDirectory?: string; projectRoots?: (threadId: string | undefined) => Promise<string[]> } = {}) {
  const contexts = new Map<string | undefined, GraphContext>();
  const server = new McpServer({ name: 'git-graph', title: 'Git Graph', version: '0.3.0', icons: [
    { src: lightIcon, mimeType: 'image/svg+xml', sizes: ['any'], theme: 'light' },
    { src: darkIcon, mimeType: 'image/svg+xml', sizes: ['any'], theme: 'dark' },
  ] });
  for (const [name, definition] of Object.entries(definitions)) {
    registerAppTool(server, name, { title: definition.title, description: definition.description || definition.title,
      inputSchema: definition.schema, annotations: definition.annotations || annotations,
      _meta: name === 'git_graph' ? {
        ui: { resourceUri, visibility: ['app', 'model'] },
        // Codex Desktop 26.908 supports these window entrypoints; keep standard MCP UI metadata too.
        'openai/ui': { entrypoints: [{ type: 'thread' }], preferredModelDisplayMode: 'fullscreen' },
      } : { ui: { visibility: ['app'] } },
    }, async (args: unknown, request: ServerContext) => {
      const threadId = z.string().optional().parse(request.mcpReq._meta?.threadId);
      let context = contexts.get(threadId);
      if (name === 'git_graph') {
        const notices = [];
        let roots: string[] = [];
        try { roots = await projectRoots(threadId); }
        catch (error) { notices.push(`无法读取项目目录：${error instanceof Error ? error.message : String(error)}`); }
        const identities = new Map<string, Awaited<ReturnType<typeof repositoryInfo>>>();
        for (const path of new Set(roots.length ? roots : [process.cwd()])) {
          try {
            const info = await repositoryInfo(path);
            if (!identities.has(info.commonDir)) identities.set(info.commonDir, info);
          } catch (error) {
            if (!/not a git repository/i.test(error instanceof Error ? String((error.cause as { stderr?: unknown } | undefined)?.stderr || '') : '')) notices.push(`${path}：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (roots.length) {
          try {
            const current = await repositoryInfo(process.cwd());
            if (identities.has(current.commonDir)) identities.set(current.commonDir, current);
          } catch {}
        }
        const repositories = [...identities.values()].map(({ root, commonDir, mainRoot }) => ({
          id: createHash('sha256').update(commonDir).digest('hex'),
          name: basename(mainRoot),
          path: root,
          displayPath: mainRoot,
        }));
        context = { repositories, repositoryNotice: notices.join('\n'), contextCwd: roots[0] || process.cwd() };
        contexts.set(threadId, context);
      }
      return call(name, args, directory, context);
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
