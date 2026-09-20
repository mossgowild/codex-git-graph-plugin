import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { withCodex } from './codex.mjs';

const projectSchema = z.object({ roots: z.array(z.object({ path: z.string().min(1) })) });

export async function readProjectRoots(threadId) {
  if (!threadId) return [];
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  return withCodex(async request => {
    const { thread } = await request('thread/read', { threadId, includeTurns: false });
    let projectId = thread.projectId;
    // Desktop still has tasks awaiting migration of their project assignment.
    if (!projectId) {
      let desktop;
      try { desktop = JSON.parse(await readFile(join(home, '.codex-global-state.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const assignment = desktop?.['thread-project-assignments']?.[threadId];
      if (assignment?.projectKind === 'local') {
        projectId = desktop['app-server-project-id-by-legacy-project-id-by-host']?.[`local:${home}`]?.[assignment.projectId];
        if (!projectId) throw new Error('当前任务的项目关联尚未迁移，请在 Codex 中重新关联项目。');
      }
    }
    if (!projectId) return [];
    const { project } = await request('project/read', { projectId });
    return projectSchema.parse(project).roots.map(root => root.path);
  });
}
