import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

const exec = promisify(execFile);
const objectId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export async function git(repo, args, encoding = 'utf8') {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  try {
    const { stdout } = await exec('git', ['--no-pager', '--no-optional-locks', '--literal-pathspecs',
      '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', repo, ...args], {
      env: { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' }, encoding, maxBuffer: 16 * 1024 * 1024, timeout: 20000,
    });
    return stdout;
  } catch (error) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('结果超过 16 MB，请选择单个文件或缩小历史范围。');
    if (error.killed) throw new Error('Git 查询超过 20 秒，请缩小范围后重试。');
    throw new Error(String(error.stderr || '').trim() || error.message, { cause: error });
  }
}

export async function repository(repoPath) {
  if (!isAbsolute(repoPath) || repoPath.includes('\0')) throw new Error('请输入本地仓库的绝对路径。');
  const path = await realpath(repoPath);
  const root = (await git(path, ['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
  return await realpath(root);
}

export async function repositoryInfo(repoPath) {
  const root = await repository(repoPath);
  const commonDir = await realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  const main = (await git(root, ['worktree', 'list', '--porcelain', '-z']))
    .split('\0').find(field => field.startsWith('worktree '));
  if (!main) throw new Error('Git 未返回主工作树。');
  return { root, commonDir, mainRoot: await realpath(main.slice('worktree '.length)) };
}

function parseCommits(raw) {
  if (!raw) return [];
  const fields = raw.replace(/\0$/, '').split('\0');
  if (fields.length % 6) throw new Error('Git 返回的提交记录格式无效。');
  const result = [];
  for (let i = 0; i < fields.length; i += 6) {
    const [hash, parentText, author, email, date, subject] = fields.slice(i, i + 6);
    result.push({ hash, parents: parentText ? parentText.split(' ') : [], author, email, date, subject });
  }
  return result;
}

export async function history({ repoPath, branch = '', offset = 0, tips, limit = 250 }) {
  const repo = await repository(repoPath);
  const refText = await git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(symref)%00%(objecttype)%00%(*objecttype)%00%(upstream)',
    'refs/heads', 'refs/remotes', 'refs/tags']);
  const refs = refText.trimEnd().split('\n').filter(Boolean).map(line => {
    const [name, hash, peeled, symbolic, type, peeledType, upstream] = line.split('\0');
    return { name, hash: peeled || hash, symbolic, type: peeledType || type, upstream };
  }).filter(ref => !ref.symbolic && ['commit', 'tag'].includes(ref.type));
  const headRaw = await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(error => {
    if (refs.length || error.cause?.code !== 1) throw error;
    return '';
  });
  const head = headRaw.trim();
  const headName = (await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(error => {
    if (error.cause?.code !== 1) throw error;
    return '';
  })).trim();
  const missingBranch = branch && !refs.some(ref => ref.name === branch) ? branch : '';
  if (missingBranch) { branch = ''; offset = 0; tips = undefined; }
  const selected = branch ? refs.filter(ref => ref.name === branch) : refs;
  const resolved = [];
  if (!tips) {
    for (const ref of selected) {
      const hash = ref.type === 'commit' ? ref.hash : (await git(repo, ['rev-parse', '--verify', `${ref.hash}^{commit}`])).trim();
      resolved.push(hash);
    }
    if (!branch && head) resolved.unshift(head);
  }
  const snapshot = tips || [...new Set(resolved)];
  if (snapshot.some(hash => !objectId.test(hash))) throw new Error('提交快照无效，请刷新。');
  const raw = snapshot.length ? await git(repo, ['log', '--topo-order', '--no-show-signature', '-z',
    '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s', `--skip=${offset}`, `--max-count=${limit + 1}`, ...snapshot, '--']) : '';
  const commits = parseCommits(raw);
  return { repo, head, headName, refs, branch, missingBranch, tips: snapshot, offset, commits: commits.slice(0, limit), hasMore: commits.length > limit };
}

async function verifyCommit(repo, hash) {
  if (!objectId.test(hash)) throw new Error('提交 ID 无效。');
  return (await git(repo, ['rev-parse', '--verify', `${hash}^{commit}`])).trim();
}

export function parseFiles(raw) {
  const parts = raw.split('\0');
  if (parts.at(-1) === '') parts.pop();
  const files = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    const oldPath = /^[RC]/.test(status) ? parts[i++] : null;
    const path = parts[i++];
    if (path == null) throw new Error('Git 返回的文件列表格式无效。');
    files.push({ status, path, oldPath });
  }
  return files;
}

export async function commit({ repoPath, hash, parent = 0 }) {
  const repo = await repository(repoPath);
  hash = await verifyCommit(repo, hash);
  const raw = await git(repo, ['show', '-s', '--no-show-signature',
    '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B', hash, '--']);
  const [id, parentText, author, email, date, message] = raw.split('\0');
  const parents = parentText ? parentText.split(' ') : [];
  if (!Number.isInteger(parent) || parent < 0 || parent >= Math.max(parents.length, 1)) throw new Error('父提交选择无效。');
  const base = parents[parent] || null;
  const args = base ? ['diff', '--name-status', '-z', '-M', base, hash, '--']
    : ['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', '-z', '-M', hash, '--'];
  const files = parseFiles(await git(repo, args));
  return { repo, hash: id, parents, parent, base, author, email, date, message: message.trimEnd(), files };
}

async function revisionFile(repo, hash, path, exists) {
  const revision = { hash, path, exists, mode: null, content: '' };
  if (!exists) return revision;
  const entry = await git(repo, ['ls-tree', '-z', hash, '--', path]);
  const tab = entry.indexOf('\t');
  if (tab === -1 || entry.slice(tab + 1) !== `${path}\0`) throw new Error('历史文件对象不存在。');
  const [mode, type, id] = entry.slice(0, tab).split(' ');
  revision.mode = mode;
  if (mode === '160000') return { ...revision, content: `Subproject commit ${id}\n` };
  if (type !== 'blob') throw new Error('所选历史路径不是文件。');
  const size = Number((await git(repo, ['cat-file', '-s', id])).trim());
  // ponytail: bound each full document to 2 MiB; a streamed viewer is needed for larger files.
  if (size > 2 * 1024 * 1024) return { ...revision, reason: '文件超过 2 MiB，未载入文本比较。' };
  const bytes = await git(repo, ['cat-file', 'blob', id], null);
  if (bytes.includes(0)) return { ...revision, reason: '二进制文件，无法显示文本差异。' };
  try { revision.content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { ...revision, reason: '文件不是有效的 UTF-8 文本，无法显示文本差异。' }; }
  return revision;
}

export async function diff(args) {
  const detail = await commit(args);
  const file = detail.files.find(file => file.path === args.path);
  if (!file) throw new Error('这个文件不在所选提交的变更中。');
  const [original, modified] = await Promise.all([
    revisionFile(detail.repo, detail.base, file.oldPath || file.path, Boolean(detail.base) && file.status[0] !== 'A'),
    revisionFile(detail.repo, detail.hash, file.path, file.status[0] !== 'D'),
  ]);
  return { hash: detail.hash, base: detail.base, ...file, original, modified };
}

export async function workspaceFile(args) {
  const detail = await commit(args);
  if (!detail.files.some(file => file.path === args.path)) throw new Error('这个文件不在所选提交的变更中。');
  let path;
  try { path = await realpath(resolve(detail.repo, args.path)); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error('当前工作区中已没有这个文件；仍可在这里查看历史差异。');
    throw error;
  }
  if (!path.startsWith(`${detail.repo}${sep}`)) throw new Error('文件指向当前仓库之外，不能从 Git Graph 打开。');
  if (!(await stat(path)).isFile()) throw new Error('所选路径不是普通文件。');
  return { path };
}
