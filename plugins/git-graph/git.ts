import { execFile, type ExecFileException } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { error as messageError, msg, type Message } from './i18n.ts';

const exec = promisify(execFile);
const objectId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const maxTextSize = 2 * 1024 * 1024;

export type HistoryOptions = { repoPath: string; branch?: string; offset?: number; tips?: string[]; limit?: number; retain?: string[] };
export type CommitOptions = { repoPath: string; hash: string; parent?: number };
export type FileOptions = CommitOptions & { path: string };
export type CompareOptions = { repoPath: string; base: string; hash: string };
export type CompareFileOptions = CompareOptions & { path: string };
export type HistoryRef = { name: string; hash: string; upstream?: string };
export type RevisionFile = { hash: string | null; path: string; exists: boolean; mode: string | null; content: string; reason?: Message };

export function git(repo: string, args: string[], encoding?: 'utf8'): Promise<string>;
export function git(repo: string, args: string[], encoding: null): Promise<Buffer>;
export async function git(repo: string, args: string[], encoding: 'utf8' | null = 'utf8'): Promise<string | Buffer> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  try {
    const { stdout } = await exec('git', ['--no-pager', '--no-optional-locks', '--literal-pathspecs',
      '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-C', repo, ...args], {
      env: { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' }, encoding, maxBuffer: 16 * 1024 * 1024, timeout: 20000,
    });
    return stdout;
  } catch (caught) {
    const error = caught as ExecFileException & { stderr?: string | Buffer };
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw messageError('backend.git.outputLimit');
    if (error.killed) throw messageError('backend.git.timeout');
    throw messageError('backend.git.failure', { diagnostic: String(error.stderr || '').trim() || error.message }, error);
  }
}

export async function repository(repoPath: string) {
  if (!isAbsolute(repoPath) || repoPath.includes('\0')) throw messageError('backend.path.absolute');
  const path = await realpath(repoPath);
  const root = (await git(path, ['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
  return await realpath(root);
}

export async function repositoryInfo(repoPath: string) {
  const root = await repository(repoPath);
  const commonDir = await realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  return { root, commonDir };
}

function parseCommits(raw: string) {
  if (!raw) return [];
  const fields = raw.replace(/\0$/, '').split('\0');
  if (fields.length % 6) throw messageError('backend.git.invalidCommits');
  const result = [];
  for (let i = 0; i < fields.length; i += 6) {
    const [hash, parentText, author, email, date, subject] = fields.slice(i, i + 6);
    result.push({ hash, parents: parentText ? parentText.split(' ') : [], author, email, date, subject });
  }
  return result;
}

async function optionalGit(repo: string, args: string[]) {
  return git(repo, args).catch(error => {
    if ((error.cause as ExecFileException | undefined)?.code !== 1) throw error;
    return '';
  });
}

async function branchBase(repo: string, current: HistoryRef, refs: HistoryRef[], symbolic: { name: string; symbolic: string }[]) {
  const sameName = (a: string, b: string) => ['darwin', 'win32'].includes(process.platform) ? a.toLowerCase() === b.toLowerCase() : a === b;
  const findBranch = (name: string) => refs.find(ref => /^(refs\/heads\/|refs\/remotes\/)/.test(ref.name)
    && (sameName(ref.name, name) || sameName(ref.name, `refs/heads/${name}`) || sameName(ref.name, `refs/remotes/${name}`)));
  const remoteBranch = (ref: HistoryRef | undefined) => ref?.name.startsWith('refs/remotes/') ? ref : null;
  const configured = (await optionalGit(repo, ['config', '--get', `branch.${current.name.slice('refs/heads/'.length)}.vscode-merge-base`])).trim();
  const stored = remoteBranch(findBranch(configured));
  if (stored) return stored;
  const entries = (await git(repo, ['reflog', current.name, '--format=%gs', '--grep-reflog=branch: Created from *.']))
    .trimEnd().split('\n').filter(Boolean);
  if (entries.length === 1) {
    let sourceName = entries[0].match(/^branch: Created from (.*)$/)?.[1];
    if (sourceName === 'HEAD') {
      const checkouts = (await git(repo, ['reflog', 'HEAD', '--format=%gs'])).trimEnd().split('\n')
        .map(entry => entry.match(/^checkout: moving from ([^\s]+) to (.*)$/))
        .filter(match => match?.[2] === current.name.slice('refs/heads/'.length));
      sourceName = checkouts.at(-1)?.[1];
    }
    const source = sourceName ? findBranch(sourceName) : undefined;
    const fromReflog = remoteBranch(source) || (source?.upstream ? remoteBranch(findBranch(source.upstream)) : null);
    if (fromReflog) return fromReflog;
  }
  const remotes = (await git(repo, ['remote'])).trimEnd().split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  const defaultName = remote && symbolic.find(ref => ref.name === `refs/remotes/${remote}/HEAD`)?.symbolic;
  return defaultName ? remoteBranch(findBranch(defaultName)) : null;
}

export async function history({ repoPath, branch = '', offset = 0, tips, limit = 250, retain }: HistoryOptions) {
  const repo = await repository(repoPath);
  const refText = await git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(symref)%00%(objecttype)%00%(*objecttype)%00%(upstream)',
    'refs/heads', 'refs/remotes', 'refs/tags']);
  const allRefs = refText.trimEnd().split('\n').filter(Boolean).map(line => {
    const [name, hash, peeled, symbolic, type, peeledType, upstream] = line.split('\0');
    return { name, hash: peeled || hash, symbolic, type: peeledType || type, upstream };
  });
  const refs = allRefs.filter(ref => !ref.symbolic && ['commit', 'tag'].includes(ref.type));
  const head = (await optionalGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])).trim();
  const headRef = (await optionalGit(repo, ['symbolic-ref', '--quiet', 'HEAD'])).trim();
  const headName = headRef.replace(/^refs\/heads\//, '');
  const currentRef: HistoryRef | null = head ? refs.find(ref => ref.name === headRef) || { name: head, hash: head } : null;
  const upstreamRef: HistoryRef | null = currentRef?.upstream ? refs.find(ref => ref.name === currentRef.upstream) || null : null;
  const resolvedBase = currentRef?.name.startsWith('refs/heads/') ? await branchBase(repo, currentRef, refs, allRefs) : null;
  const baseRef = resolvedBase?.name !== upstreamRef?.name ? resolvedBase : null;
  const mergeBase = currentRef && upstreamRef ? (await optionalGit(repo, ['merge-base', currentRef.hash, upstreamRef.hash])).trim() || null : null;
  const missingBranch = branch && !refs.some(ref => ref.name === branch) ? branch : '';
  if (missingBranch) { branch = ''; offset = 0; tips = undefined; }
  if (!branch && refs.length === 1) branch = refs[0].name;
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
  if (snapshot.some(hash => !objectId.test(hash))) throw messageError('backend.git.invalidSnapshot');
  const raw = snapshot.length ? await git(repo, ['log', '--topo-order', '--no-show-signature', '-z',
    '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s', `--skip=${offset}`, `--max-count=${limit + 1}`, ...snapshot, '--']) : '';
  const commits = parseCommits(raw);
  const retained: string[] = [];
  if (retain) {
    if (retain.length > 2 || retain.some(hash => !objectId.test(hash))) throw messageError('backend.git.invalidRetained');
    for (const hash of new Set(retain)) {
      for (const tip of snapshot) {
        const reachable = await git(repo, ['merge-base', '--is-ancestor', hash, tip]).then(() => true).catch(error => {
          if ((error.cause as ExecFileException | undefined)?.code !== 1) throw error;
          return false;
        });
        if (reachable) { retained.push(hash); break; }
      }
    }
  }
  return { repo, head, headName, refs, branch, missingBranch, tips: snapshot, offset, commits: commits.slice(0, limit), hasMore: commits.length > limit,
    currentRef, upstreamRef, baseRef, mergeBase, ...(retain ? { retained } : {}) };
}

async function verifyCommit(repo: string, hash: string) {
  if (!objectId.test(hash)) throw messageError('backend.git.invalidHash');
  return (await git(repo, ['rev-parse', '--verify', `${hash}^{commit}`])).trim();
}

export function parseFiles(raw: string) {
  const parts = raw.split('\0');
  if (parts.at(-1) === '') parts.pop();
  const files = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    const oldPath = /^[RC]/.test(status) ? parts[i++] : null;
    const path = parts[i++];
    if (path == null) throw messageError('backend.git.invalidFiles');
    files.push({ status, path, oldPath });
  }
  return files;
}

export async function commit({ repoPath, hash, parent = 0 }: CommitOptions) {
  const repo = await repository(repoPath);
  hash = await verifyCommit(repo, hash);
  const raw = await git(repo, ['show', '-s', '--no-show-signature',
    '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B', hash, '--']);
  const [id, parentText, author, email, date, message] = raw.split('\0');
  const parents = parentText ? parentText.split(' ') : [];
  if (!Number.isInteger(parent) || parent < 0 || parent >= Math.max(parents.length, 1)) throw messageError('backend.git.invalidParent');
  const base = parents[parent] || null;
  const args = base ? ['diff', '--name-status', '-z', '-M', base, hash, '--']
    : ['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', '-z', '-M', hash, '--'];
  const files = parseFiles(await git(repo, args));
  return { repo, hash: id, parents, parent, base, author, email, date, message: message.trimEnd(), files };
}

export async function compare({ repoPath, base, hash }: CompareOptions) {
  const repo = await repository(repoPath);
  [base, hash] = await Promise.all([verifyCommit(repo, base), verifyCommit(repo, hash)]);
  const files = parseFiles(await git(repo, ['diff', '--name-status', '-z', '-M', base, hash, '--']));
  return { repo, hash, base, parents: [] as string[], parent: 0, message: '', author: '', email: '', date: '', files };
}

async function revisionFile(repo: string, hash: string | null, path: string, exists: boolean): Promise<RevisionFile> {
  const revision: RevisionFile = { hash, path, exists, mode: null, content: '' };
  if (!exists) return revision;
  const entry = await git(repo, ['ls-tree', '-z', hash!, '--', path]);
  const tab = entry.indexOf('\t');
  if (tab === -1 || entry.slice(tab + 1) !== `${path}\0`) throw messageError('backend.file.missingObject');
  const [mode, type, id] = entry.slice(0, tab).split(' ');
  revision.mode = mode;
  if (mode === '160000') return { ...revision, content: `Subproject commit ${id}\n` };
  if (type !== 'blob') throw messageError('backend.file.notHistoricalFile');
  const size = Number((await git(repo, ['cat-file', '-s', id])).trim());
  // ponytail: bound each full document to 2 MiB; a streamed viewer is needed for larger files.
  if (size > maxTextSize) return { ...revision, reason: msg('backend.file.tooLarge') };
  const bytes = await git(repo, ['cat-file', 'blob', id], null);
  return revisionText(revision, bytes);
}

function revisionText(revision: RevisionFile, bytes: Buffer): RevisionFile {
  if (bytes.length > maxTextSize) return { ...revision, reason: msg('backend.file.tooLarge') };
  if (bytes.includes(0)) return { ...revision, reason: msg('backend.file.binary') };
  try { revision.content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { ...revision, reason: msg('backend.file.encoding') }; }
  return revision;
}

export async function diff(args: FileOptions) {
  const detail = await commit(args);
  return fileDiff(detail, args.path);
}

export async function compareDiff(args: CompareFileOptions) {
  const detail = await compare(args);
  return fileDiff(detail, args.path);
}

async function fileDiff(detail: { repo: string; hash: string; base: string | null; files: ReturnType<typeof parseFiles> }, path: string) {
  const file = detail.files.find(file => file.path === path);
  if (!file) throw messageError('backend.file.outsideRange');
  const [original, modified] = await Promise.all([
    revisionFile(detail.repo, detail.base, file.oldPath || file.path, Boolean(detail.base) && file.status[0] !== 'A'),
    revisionFile(detail.repo, detail.hash, file.path, file.status[0] !== 'D'),
  ]);
  return { hash: detail.hash, base: detail.base, ...file, original, modified };
}

export async function workspaceFile(args: FileOptions & { base?: string }) {
  if (args.base !== undefined && args.parent !== undefined) throw messageError('backend.file.baseAndParent');
  const detail = args.base === undefined ? await commit(args) : await compare({ ...args, base: args.base });
  if (!detail.files.some(file => file.path === args.path)) throw messageError('backend.file.outsideRange');
  return { path: await currentFilePath(detail.repo, args.path) };
}

async function currentFilePath(repo: string, relativePath: string) {
  let path;
  try { path = await realpath(resolve(repo, relativePath)); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw messageError('backend.file.missingWorkspace');
    throw error;
  }
  if (!path.startsWith(`${repo}${sep}`)) throw messageError('backend.file.outsideRepository');
  if (!(await stat(path)).isFile()) throw messageError('backend.file.notRegular');
  return path;
}
