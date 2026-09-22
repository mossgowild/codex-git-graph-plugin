import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { withCodex } from './codex.mjs';

const projectSchema = z.object({ roots: z.array(z.object({ path: z.string().min(1) })) });

async function readDesktopState(codexHome) {
  try { return JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function readProjectRoots(threadId, {
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), home = homedir(),
  readState = () => readDesktopState(codexHome), runWithCodex = withCodex,
} = {}) {
  let desktop, useSelectedProject = !threadId;
  const state = async () => desktop ??= await readState();
  if (!threadId && (await state())?.['selected-project']?.type !== 'local') return [home];
  return runWithCodex(async request => {
    let projectId;
    if (threadId) {
      try { ({ thread: { projectId } } = await request('thread/read', { threadId, includeTurns: false })); }
      catch (error) {
        if (error.message !== `thread not loaded: ${threadId}`) throw error;
        useSelectedProject = true;
      }
    }
    if (!projectId) {
      const data = await state();
      const assignment = data?.['thread-project-assignments']?.[threadId];
      const selected = useSelectedProject ? data?.['selected-project'] : undefined;
      const localProjectId = assignment?.projectKind === 'local' ? assignment.projectId
        : selected?.type === 'local' ? selected.projectId : undefined;
      if (localProjectId) {
        projectId = data['app-server-project-id-by-legacy-project-id-by-host']?.[`local:${codexHome}`]?.[localProjectId];
        if (!projectId) throw new Error('当前项目关联尚未迁移，请在 Codex 中重新选择项目。');
      }
    }
    if (!projectId) return [home];
    const { project } = await request('project/read', { projectId });
    const roots = projectSchema.parse(project).roots.map(root => root.path);
    return roots.length ? roots : [home];
  });
}
