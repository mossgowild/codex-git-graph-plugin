import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { withCodex, type WithCodex } from './codex.ts';

const projectSchema = z.object({ roots: z.array(z.object({ path: z.string().min(1) })) });

type DesktopState = {
  'selected-project'?: { type: string; projectId?: string };
  'thread-project-assignments'?: Record<string, { projectKind: string; projectId: string }>;
  'app-server-project-id-by-legacy-project-id-by-host'?: Record<string, Record<string, string>>;
};

async function readDesktopState(codexHome: string): Promise<DesktopState> {
  try { return JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function readProjectRoots(threadId: string | undefined, {
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), home = homedir(),
  readState = () => readDesktopState(codexHome), runWithCodex = withCodex,
}: { codexHome?: string; home?: string; readState?: () => Promise<DesktopState>; runWithCodex?: WithCodex } = {}) {
  let desktop: DesktopState | undefined;
  let useSelectedProject = !threadId;
  const state = async () => desktop ??= await readState();
  if (!threadId && (await state())?.['selected-project']?.type !== 'local') return [home];
  return runWithCodex(async request => {
    let projectId: string | null | undefined;
    if (threadId) {
      try { ({ thread: { projectId } } = z.object({ thread: z.object({ projectId: z.string().nullish() }) }).parse(await request('thread/read', { threadId, includeTurns: false }))); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== `thread not loaded: ${threadId}`) throw error;
        useSelectedProject = true;
      }
    }
    if (!projectId) {
      const data = await state();
      const assignment = threadId ? data?.['thread-project-assignments']?.[threadId] : undefined;
      const selected = useSelectedProject ? data?.['selected-project'] : undefined;
      const localProjectId = assignment?.projectKind === 'local' ? assignment.projectId
        : selected?.type === 'local' ? selected.projectId : undefined;
      if (localProjectId) {
        projectId = data['app-server-project-id-by-legacy-project-id-by-host']?.[`local:${codexHome}`]?.[localProjectId];
        if (!projectId) throw new Error('当前项目关联尚未迁移，请在 Codex 中重新选择项目。');
      }
    }
    if (!projectId) return [home];
    const { project } = z.object({ project: projectSchema }).parse(await request('project/read', { projectId }));
    const roots = project.roots.map(root => root.path);
    return roots.length ? roots : [home];
  });
}
