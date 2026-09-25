import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { withCodex, type WithCodex } from './codex.ts';
import { repositoryInfo } from './git.ts';

const pathSchema = z.string().min(1).refine(path => isAbsolute(path) && !path.includes('\0'), '需要本地绝对路径');
const workspaceSchema = z.object({ cwd: pathSchema, projectSources: z.array(pathSchema), runtimeWorkspaceRoots: z.array(pathSchema) });
const workspaceStateSchema = z.object({ project: z.unknown(), pending: workspaceSchema.nullable(), applied: workspaceSchema.nullable() });
const threadSchema = z.object({ projectId: z.string().nullish(), cwd: pathSchema,
  environments: z.array(z.object({ cwd: pathSchema, runtimeWorkspaceRoots: z.array(pathSchema).nullish() })).nullish() });
const worktreeSchema = z.object({ root: pathSchema, workspaceRoot: pathSchema });

type DesktopState = {
  'selected-project'?: { type: string; projectId?: string };
  'thread-project-assignments'?: Record<string, { projectKind: string; projectId: string }>;
  'app-server-project-id-by-legacy-project-id-by-host'?: Record<string, Record<string, string>>;
  'electron-persisted-atom-state'?: Record<string, unknown>;
};
export type Workspace = { cwd: string; runtimeRoots: string[]; sourceRoots: string[];
  worktrees: z.infer<typeof worktreeSchema>[]; notices: string[] };
export type Repository = { id: string; name: string; path: string; displayPath: string };
export type GraphContext = { repositories: Repository[]; defaultRepository?: string; repositoryNotice?: string; contextCwd?: string };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function readDesktopState(codexHome: string): Promise<DesktopState> {
  try { return JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

// Codex Desktop 26.917: read workspace transitions, live environments and persisted task context.
export async function readWorkspace(threadId: string | undefined, {
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), cwd = process.cwd(),
  readState = () => readDesktopState(codexHome), runWithCodex = withCodex,
}: { codexHome?: string; cwd?: string; readState?: () => Promise<DesktopState>; runWithCodex?: WithCodex } = {}): Promise<Workspace> {
  const desktop = await readState();
  const stored = threadId ? desktop['electron-persisted-atom-state']?.[`thread-workspace-state-v1:${threadId}`] : undefined;
  const state = stored == null ? null : workspaceStateSchema.parse(stored);
  const result: Workspace = { cwd, runtimeRoots: [cwd], sourceRoots: [], worktrees: [], notices: [] };
  if (!threadId && desktop['selected-project']?.type !== 'local') return result;
  return runWithCodex(async request => {
    let thread: z.infer<typeof threadSchema> | undefined;
    let useSelectedProject = !threadId;
    if (threadId) {
      try { thread = z.object({ thread: threadSchema }).parse(await request('thread/read', { threadId, includeTurns: false })).thread; }
      catch (error) {
        if (message(error) !== `thread not loaded: ${threadId}`) throw error;
        useSelectedProject = !state;
      }
    }
    const environment = thread?.environments?.[0];
    const workspace = state?.pending ?? (state?.project == null ? null : state.applied);
    result.cwd = state?.pending?.cwd ?? state?.applied?.cwd ?? environment?.cwd ?? thread?.cwd ?? cwd;
    result.runtimeRoots = state?.pending?.runtimeWorkspaceRoots ?? environment?.runtimeWorkspaceRoots
      ?? (environment ? [environment.cwd] : state?.applied?.runtimeWorkspaceRoots) ?? [result.cwd];
    let projectId = thread?.projectId;
    if (!projectId) {
      const assignment = threadId ? desktop['thread-project-assignments']?.[threadId] : undefined;
      const selected = useSelectedProject ? desktop['selected-project'] : undefined;
      const localProjectId = assignment?.projectKind === 'local' ? assignment.projectId
        : selected?.type === 'local' ? selected.projectId : undefined;
      if (localProjectId) {
        projectId = desktop['app-server-project-id-by-legacy-project-id-by-host']?.[`local:${codexHome}`]?.[localProjectId];
        if (!projectId) result.notices.push('当前项目关联尚未迁移，请在 Codex 中重新选择项目。');
      }
    }
    if (projectId) {
      try {
        const { project } = z.object({ project: z.object({ roots: z.array(z.object({ path: pathSchema })) }) }).parse(await request('project/read', { projectId }));
        result.sourceRoots = project.roots.map(root => root.path);
      } catch (error) { result.notices.push(`无法读取项目目录：${message(error)}`); }
    }
    if (state?.pending) result.sourceRoots = state.pending.projectSources;
    else if (!projectId && workspace) result.sourceRoots = workspace.projectSources;
    if (useSelectedProject && !thread && !workspace && result.sourceRoots.length) {
      result.cwd = result.sourceRoots[0]; result.runtimeRoots = result.sourceRoots;
    }
    if (threadId && thread) {
      try {
        let cursor: string | null = null;
        do {
          const page = z.object({ data: z.array(z.object({ attachmentType: z.string(), payload: z.unknown() })), nextCursor: z.string().nullable() })
            .parse(await request('thread/attachment/list', { threadId, cursor, limit: 100 }));
          for (const item of page.data) if (item.attachmentType === 'worktree') {
            const parsed = worktreeSchema.safeParse(item.payload);
            if (parsed.success) result.worktrees.push(parsed.data);
          }
          cursor = page.nextCursor;
        } while (cursor != null);
      } catch (error) { result.notices.push(`无法读取任务工作树：${message(error)}`); }
    }
    return result;
  });
}

const contains = (root: string, path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
export async function resolveRepositories(workspace: Workspace): Promise<GraphContext> {
  const notices = [...workspace.notices];
  const origins = new Map<string, Awaited<ReturnType<typeof repositoryInfo>>>();
  const paths = new Map<string, string>();
  for (const path of new Set([workspace.cwd, ...workspace.runtimeRoots, ...workspace.sourceRoots, ...workspace.worktrees.map(tree => tree.workspaceRoot)])) {
    try { paths.set(path, await realpath(path)); origins.set(path, await repositoryInfo(path)); }
    catch (error) {
      if (!/not a git repository/i.test(message(error))) notices.push(`${path}：${message(error)}`);
    }
  }
  const normalized = (path: string) => paths.get(path) ?? resolve(path);
  const cwd = normalized(workspace.cwd), runtimeRoots = workspace.runtimeRoots.map(normalized);
  const sourceRoots = workspace.sourceRoots.map(normalized);
  const groups = new Map<string, { root: string; commonDir: string; workspaceRoots: string[] }>();
  for (const path of [...workspace.runtimeRoots, ...workspace.sourceRoots]) {
    const origin = origins.get(path); if (!origin) continue;
    const group = groups.get(origin.root) ?? { ...origin, workspaceRoots: [] };
    group.workspaceRoots.push(normalized(path)); groups.set(origin.root, group);
  }
  // Keep distinct runtime worktrees; suppress only their source-only checkout counterparts.
  const runtimeCommon = new Set([...groups.values()].filter(repo => repo.workspaceRoots.some(path => runtimeRoots.includes(path))).map(repo => repo.commonDir));
  const candidates = [...groups.values()].filter(repo => repo.workspaceRoots.some(path => runtimeRoots.includes(path)) || !runtimeCommon.has(repo.commonDir));
  const sourceOrigins = workspace.sourceRoots.map(path => origins.get(path));
  const closest = (roots: string[], path: string) => roots.reduce((best, root, index) => contains(root, path) && (best < 0 || root.length > roots[best].length) ? index : best, -1);
  // Match Codex's project-directory → runtime-worktree mapping, including repeated subdirectories.
  const directories = (sourceRoots.length ? sourceRoots : runtimeRoots).map((source, index) => {
    const origin = sourceRoots.length ? sourceOrigins[index] : origins.get(workspace.runtimeRoots[index]);
    const rel = origin ? relative(origin.root, source) : null;
    const siblings = candidates.filter(repo => repo.commonDir === origin?.commonDir);
    const indexed = candidates.find(repo => repo.workspaceRoots.includes(runtimeRoots[index]));
    let preferred: typeof candidates[number] | undefined;
    if (sourceRoots.length && origin && rel != null && siblings.length > 1 && !sourceOrigins.some(item => item?.commonDir === origin.commonDir && item.root !== origin.root)) {
      const current = siblings[closest(siblings.map(repo => repo.root), cwd)];
      if (current) {
        const sameSources = sourceRoots.filter((_, i) => sourceOrigins[i]?.root === origin.root);
        const target = join(current.root, rel), sourceIndex = sameSources.indexOf(source);
        const others = siblings.filter(repo => repo !== current && repo.workspaceRoots.some(path => contains(path, join(repo.root, rel))));
        preferred = others.find(repo => repo.workspaceRoots.includes(join(repo.root, rel))) ?? others[0];
        if (current.workspaceRoots.some(path => contains(path, target) && (!preferred || path === target)
          || contains(target, path) && closest(sameSources, join(origin.root, relative(current.root, path))) === sourceIndex)
          && (closest(sameSources, join(origin.root, relative(current.root, cwd))) === sourceIndex || contains(cwd, target))) preferred = current;
      }
    }
    const repository = preferred ?? candidates.find(repo => repo.workspaceRoots.includes(source) || repo.root === origin?.root)
      ?? siblings.find(repo => repo === indexed) ?? siblings[0];
    return { repository };
  });
  const effective = new Map<string, { root: string; commonDir: string }>();
  for (const directory of directories) if (directory.repository) effective.set(directory.repository.root, directory.repository);
  for (const tree of workspace.worktrees) { const repo = origins.get(tree.workspaceRoot); if (repo) effective.set(repo.root, repo); }
  const current = origins.get(workspace.cwd);
  if (current) effective.set(current.root, current);
  const repositories = [...effective.values()].map(({ root }) => ({
    id: createHash('sha256').update(JSON.stringify(['local', root])).digest('hex'), name: basename(root), path: root, displayPath: root,
  }));
  const defaultRoot = current?.root ?? directories.find(dir => dir.repository)?.repository?.root;
  return { repositories, defaultRepository: repositories.find(repo => repo.path === defaultRoot)?.id, contextCwd: workspace.cwd, repositoryNotice: notices.join('\n') };
}
