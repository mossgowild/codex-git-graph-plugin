import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile, readFile, rename, rm, copyFile, realpath, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type CallToolRequest } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { git, history, commit, diff, repository, workspaceFile, compare, compareDiff, worktree, worktreeDiff, worktreeFile, parseWorktreeStatus } from './git.ts';
import { createAppearanceReader, type WithCodex } from './codex.ts';
import { layout, graphPaths, colors, incomingId, outgoingId, uncommittedId, type GraphCommit } from './graph.ts';
import { readWorkspace, resolveRepositories } from './project.ts';
import type { definitions } from './server.ts';
import { z } from 'zod';
import { catalog, msg, format, resolveLocale, isMessage, toMessage, joinMessages, error as messageError, type MessageKey } from './i18n.ts';

const isErrorKey = (key: MessageKey) => (error: unknown) => toMessage(error).key === key;

test('shared messages preserve locale precedence, catalog parameters and diagnostics after JSON roundtrip', () => {
  for (const [key, translations] of Object.entries(catalog)) {
    assert.match(key, /^(backend|ui|editor)\./);
    assert.equal(typeof translations.en, 'string'); assert.equal(typeof translations['zh-CN'], 'string');
    const parameters = (text: string) => [...new Set(text.match(/\{\w+\}/g))].sort();
    assert.deepEqual(parameters(translations.en), parameters(translations['zh-CN']), `${key} shares parameters in both languages`);
  }
  assert.equal(resolveLocale('zh-Hans-CN', ['en-US']), 'zh-CN');
  assert.equal(resolveLocale('en-GB', ['zh-CN']), 'en');
  assert.equal(resolveLocale('fr-FR', ['zh-CN']), 'en', 'unsupported host locale does not change to a browser locale');
  assert.equal(resolveLocale(undefined, ['zh-CN']), 'zh-CN');
  assert.equal(resolveLocale('zh-TW', ['zh-CN']), 'en');
  const original = new Error('EACCES original diagnostic');
  const failure = messageError('backend.preference.read', { label: msg('backend.preference.layout'), diagnostic: toMessage(original) }, original);
  const restored = JSON.parse(JSON.stringify(toMessage(failure)));
  assert.ok(isMessage(restored));
  assert.equal(format(restored, 'en'), 'Could not read panel layout: EACCES original diagnostic');
  assert.equal(format(restored, 'zh-CN'), '读取面板布局失败：EACCES original diagnostic');
  assert.equal(failure.cause, original);
  assert.ok(isMessage(msg('backend.external', { diagnostic: [true, null, restored] })));
  assert.equal(format(joinMessages([restored, 'untranslated external text']), 'zh-CN'), '读取面板布局失败：EACCES original diagnostic\nuntranslated external text');
  assert.equal(isMessage({ key: 'unknown.key' }), false);
  assert.equal(isMessage({ key: 'backend.external', params: { diagnostic: {} } }), false);
  assert.equal(format(msg('ui.incoming'), 'zh-CN'), '传入的更改');
  assert.equal(format(msg('ui.outgoing'), 'zh-CN'), '传出的更改');
});

const uiMetadata = z.object({ ui: z.object({ resourceUri: z.string().optional(), visibility: z.array(z.string()).optional() }),
  'openai/ui': z.object({ entrypoints: z.array(z.object({ type: z.string() })) }).optional() });

async function callTool<K extends keyof typeof definitions>(client: Client, params: Omit<CallToolRequest['params'], 'name'> & { name: K }) {
  const result = await client.callTool(params);
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object');
  return { ...result, structuredContent: result.structuredContent as Awaited<ReturnType<typeof definitions[K]['run']>> };
}

function checkGraph(commits: GraphCommit[]) {
  const graph = layout(commits);
  for (const [index, row] of graph.rows.entries()) {
    assert.deepEqual(row.input, graph.rows[index - 1]?.output || [], 'adjacent rows share lanes and colors');
    for (const parent of row.parents) {
      assert.ok(row.output.some(lane => lane.hash === parent), 'every parent has an outgoing lane');
      const destination = graph.rows.findIndex(row => row.hash === parent);
      if (destination >= 0) {
        assert.ok(destination > index, 'topological order');
        for (let next = index + 1; next <= destination; next++) {
          assert.ok(graph.rows[next].input.some(lane => lane.hash === parent), 'parent persists until its commit');
        }
      }
    }
  }
}

test('VS Code swimlanes converge at the ancestor, compact lanes, and share semantic reference colors', () => {
  const commits = ([['A',['C']],['B',['C']],['C',['D']],['D',[]]] as [string, string[]][]).map(([hash, parents]) => ({hash, parents}));
  const { rows } = layout(commits);
  assert.deepEqual(rows.map(row => row.column), [0,1,0,0]);
  assert.deepEqual(rows.map(row => row.output.map(lane => lane.hash)), [['C'],['C','C'],['D'],[]]);
  assert.deepEqual(rows[1].output.map(lane => lane.color), [colors[0],colors[1]]);
  assert.ok(graphPaths(rows[2]).some(path => path.d === 'M22 0A11 11 0 0 1 11 11H11' && path.color === colors[1]));
  const merge = layout([{hash:'M',parents:['L','R']},{hash:'L',parents:['O']},{hash:'R',parents:['O']},{hash:'O',parents:[]}]).rows;
  assert.ok(graphPaths(merge[0]).some(path => path.d === 'M11 11A11 11 0 0 1 22 22M11 11H11'));
  const separateRoots = [{hash:'A',parents:['C']},{hash:'B',parents:[]},{hash:'C',parents:[]}];
  checkGraph(separateRoots);
  const disconnected = ([['a',['x']],['b',['y']],['x',[]],['z',[]],['y',[]]] as [string, string[]][]).map(([hash,parents])=>({hash,parents}));
  const roots = layout(disconnected).rows;
  assert.equal(roots[2].color, roots[2].input[roots[2].column].color, 'root node keeps its incoming lineage color');
  assert.notEqual(roots[2].color, roots[2].output[0].color, 'compacting a passing lane does not recolor the root');
  assert.deepEqual(roots[2].output.map(lane=>lane.hash), ['y']);
  assert.equal(roots[3].input[roots[3].column], undefined, 'isolated root has no incoming edge');
  assert.equal(graphPaths(roots[3]).length, 1, 'isolated root only has an unrelated passing edge');
  checkGraph(disconnected);
  const refs = [
    {name:'refs/heads/topic',hash:'A'},
    {name:'refs/heads/main',hash:'B',upstream:'refs/remotes/origin/main'},
    {name:'refs/remotes/origin/main',hash:'C'},
    {name:'refs/heads/alias',hash:'B'}, {name:'refs/heads/alias2',hash:'B'},
    {name:'refs/tags/v1',hash:'B'},
  ];
  const semantic = layout(commits, {refs, currentRef: refs[1], upstreamRef: refs[2]}).rows;
  assert.equal(semantic[1].kind, 'HEAD');
  assert.equal(semantic[1].color, 'var(--graph-current)');
  assert.equal(semantic[2].color, 'var(--graph-remote)');
  assert.equal(semantic[1].references[0].name, 'refs/heads/main');
  assert.ok(semantic[1].references.every(ref => ref.color === semantic[1].color));
  assert.equal(layout(commits, {refs, branch:'refs/tags/v1'}).rows[0].references[0].color, undefined);
  assert.ok(graphPaths(rows[2], 28).some(path => path.d === 'M22 0V3A11 11 0 0 1 11 14H11'));
  assert.ok(graphPaths(merge[0], 28).some(path => path.d === 'M11 14A11 11 0 0 1 22 25V28M11 14H11'));
  checkGraph(commits);
});

test('native sync graph respects loaded anchors, reference filters and the merged incoming exception', () => {
  const currentRef = { name: 'refs/heads/main', hash: 'L' }, upstreamRef = { name: 'refs/remotes/origin/main', hash: 'R' };
  const options = { refs: [currentRef, upstreamRef], currentRef, upstreamRef, mergeBase: 'B', offset: 7 };
  const commits = [{ hash: 'L', parents: ['B'] }, { hash: 'R', parents: ['B'] }, { hash: 'B', parents: [] }];
  const before = structuredClone({ options, commits });
  const rows = layout(commits, options).rows;
  assert.deepEqual(rows.map(row => row.hash), [outgoingId, 'L', 'R', incomingId, 'B']);
  const outgoing = rows.find(row => row.target === outgoingId)!;
  const incoming = rows.find(row => row.target === incomingId)!;
  assert.equal(outgoing.base, 'B'); assert.equal(outgoing.revision, 'L');
  assert.equal(incoming.base, 'B'); assert.equal(incoming.revision, 'R');
  assert.deepEqual(incoming.references, []); assert.deepEqual(outgoing.references, []);
  assert.equal(rows.filter(row => row.target === 'commit').length, commits.length, 'synthetic rows do not count as real commits');
  assert.deepEqual({ options, commits }, before, 'insertion keeps source commits, references and paging offset unchanged');
  for (const source of commits) assert.deepEqual(rows.find(row => row.hash === source.hash)?.parents, source.parents);
  const targets = (source = commits, scope: NonNullable<Parameters<typeof layout>[1]> = options) => layout(source, scope).rows.filter(row => row.target !== 'commit').map(row => row.target);
  assert.deepEqual(targets(commits.slice(0, 2)), [outgoingId], 'incoming waits until the common ancestor is loaded');
  assert.deepEqual(targets(commits.slice(1)), [incomingId], 'outgoing waits until the current tip is loaded');
  assert.deepEqual(targets(commits, { ...options, branch: currentRef.name }), [outgoingId]);
  assert.deepEqual(targets(commits, { ...options, branch: upstreamRef.name }), [incomingId]);
  assert.deepEqual(targets(commits, { ...options, branch: 'refs/tags/other' }), []);
  assert.deepEqual(targets(commits, { ...options, upstreamRef: { ...upstreamRef, hash: currentRef.hash } }), []);
  assert.deepEqual(layout(commits, { ...options, mergeBase: null }).rows.filter(row => row.target !== 'commit'), []);
  assert.deepEqual(layout(commits, { ...options, upstreamRef: null }).rows.filter(row => row.target !== 'commit'), []);
  const merged = [{ hash: 'L', parents: ['B'] }, { hash: 'R', parents: ['X', 'B'] }, { hash: 'B', parents: [] }, { hash: 'X', parents: [] }];
  assert.deepEqual(targets(merged), [outgoingId], 'the last pre-base row with exactly two parents including base suppresses incoming');
  const multiParent = [{ hash: 'L', parents: ['B'] }, { hash: 'R', parents: ['X', 'Y', 'B'] }, { hash: 'B', parents: [] }, { hash: 'X', parents: [] }, { hash: 'Y', parents: [] }];
  assert.deepEqual(targets(multiParent), [outgoingId, incomingId], 'the native suppression condition is specific to exactly two parents');
  const ahead = [{ hash: 'L', parents: ['B'] }, { hash: 'B', parents: [] }];
  assert.deepEqual(targets(ahead, { ...options, upstreamRef: { ...upstreamRef, hash: 'B' } }), [outgoingId]);
  const behind = [{ hash: 'R', parents: ['B'] }, { hash: 'B', parents: [] }];
  assert.deepEqual(targets(behind, { ...options, currentRef: { ...currentRef, hash: 'B' } }), [incomingId]);
});

test('native incoming reconnects only the upstream lineage and preserves true comparison parents', () => {
  const currentRef = { name: 'refs/heads/main', hash: 'L' }, upstreamRef = { name: 'refs/remotes/origin/main', hash: 'R' };
  const commits = [{ hash: 'L', parents: ['B'] }, { hash: 'R', parents: ['B'] }, { hash: 'X', parents: ['O'] }, { hash: 'B', parents: ['O'] }, { hash: 'O', parents: [] }];
  const source = structuredClone(commits);
  const options = { refs: [currentRef, upstreamRef], currentRef, upstreamRef, mergeBase: 'B' };
  const rows = layout(commits, options).rows, before = rows.find(row => row.hash === 'X')!;
  for (const lanes of [before.input, before.output]) {
    assert.ok(lanes.some(lane => lane.hash === incomingId && lane.color === 'var(--graph-remote)'));
    assert.ok(lanes.some(lane => lane.hash === 'B' && lane.color === 'var(--graph-current)'));
    assert.ok(!lanes.some(lane => lane.hash === incomingId && lane.color !== 'var(--graph-remote)'));
  }
  assert.deepEqual(commits, source);
  assert.deepEqual(before.parents, ['O']); assert.equal(before.base, 'O'); assert.equal(before.revision, 'X');
  assert.deepEqual(rows.find(row => row.hash === 'R')?.parents, ['B']);
  assert.equal(rows.find(row => row.hash === 'R')?.base, 'B');
  assert.ok(rows.every(row => graphPaths(row).every(path => path.color && !path.d.includes('NaN'))));
});

test('uncommitted graph preserves native sync anchors, real parents and reference filtering', () => {
  const currentRef = { name: 'refs/heads/main', hash: 'L' }, upstreamRef = { name: 'refs/remotes/origin/main', hash: 'R' };
  const options = { refs: [currentRef, upstreamRef, { name: 'refs/tags/same', hash: 'L' }, { name: 'refs/remotes/origin/same', hash: 'L' }],
    head: 'L', headName: 'main', currentRef, upstreamRef, mergeBase: 'B', uncommitted: true, offset: 7 };
  const commits = [{ hash: 'L', parents: ['B'] }, { hash: 'R', parents: ['B'] }, { hash: 'B', parents: [] }], before = structuredClone({ commits, options });
  const targets = (rows: ReturnType<typeof layout>['rows']) => rows.filter(row => row.target === incomingId || row.target === outgoingId).map(row => [row.target, row.base, row.revision]);
  for (const branch of ['', currentRef.name]) {
    const rows = layout(commits, { ...options, branch }).rows;
    assert.deepEqual(rows.find(row => row.hash === uncommittedId)?.parents, ['L']);
    assert.deepEqual(targets(rows), targets(layout(commits, { ...options, branch, uncommitted: false }).rows));
    for (const commit of commits) assert.deepEqual(rows.find(row => row.hash === commit.hash)?.parents, commit.parents);
    assert.equal(rows.filter(row => row.target === 'commit').length, commits.length);
  }
  for (const branch of ['refs/tags/same', 'refs/remotes/origin/same', 'refs/heads/other']) assert.ok(!layout(commits, { ...options, branch }).rows.some(row => row.hash === uncommittedId));
  assert.ok(!layout(commits, { ...options, uncommitted: false }).rows.some(row => row.hash === uncommittedId));
  const unborn = layout([], { headName: 'main', uncommitted: true, branch: 'refs/heads/main' }).rows;
  assert.deepEqual(unborn.map(row => [row.hash, row.parents, row.base, row.revision]), [[uncommittedId, [], null, '']]);
  const detached = { head: 'L', currentRef: { name: 'L', hash: 'L' }, uncommitted: true };
  assert.ok(layout(commits, detached).rows.some(row => row.hash === uncommittedId));
  assert.ok(!layout(commits, { ...detached, branch: 'refs/tags/same' }).rows.some(row => row.hash === uncommittedId));
  const baseOnly = layout([{ hash: 'B', parents: [] }], { ...options, head: 'B', currentRef: { ...currentRef, hash: 'B' } }).rows;
  assert.deepEqual(baseOnly.map(row => row.hash), [uncommittedId, 'B'], 'the workspace edge to a loaded base never manufactures an incoming anchor');
  assert.deepEqual({ commits, options }, before, 'virtual insertion preserves source data and pagination');
});

test('native reference priority and icons distinguish current, upstream, base and other references', () => {
  const currentRef = { name: 'refs/heads/main', hash: 'A' }, upstreamRef = { name: 'refs/remotes/origin/main', hash: 'A' };
  const baseRef = { name: 'refs/remotes/origin/base', hash: 'A' };
  const refs = [{ name: 'refs/tags/v1', hash: 'A' }, { name: 'refs/heads/alias', hash: 'A' }, baseRef, upstreamRef, currentRef,
    { name: 'refs/remotes/origin/HEAD', hash: 'A' }, { name: 'refs/heads/outside', hash: 'B' }];
  const commits = [{ hash: 'A', parents: ['B'] }, { hash: 'B', parents: [] }];
  const rows = layout(commits, { refs, currentRef, upstreamRef, baseRef }).rows;
  assert.deepEqual(rows[0].references.slice(0, 3).map(ref => ref.name), [currentRef.name, upstreamRef.name, baseRef.name]);
  assert.deepEqual(rows[0].references.map(ref => ref.icon), ['target', 'cloud', 'cloud', 'tag', 'git-branch']);
  assert.deepEqual(rows[0].references.slice(0, 3).map(ref => ref.color), ['var(--graph-current)', 'var(--graph-remote)', 'var(--graph-base)']);
  assert.ok(!rows[0].references.some(ref => ref.name === 'refs/remotes/origin/HEAD'));
  const filtered = layout(commits, { refs, currentRef, upstreamRef, baseRef, branch: 'refs/heads/alias' }).rows;
  assert.equal(filtered[0].references.find(ref => ref.name === 'refs/tags/v1')?.color, undefined);
  assert.ok(filtered[0].references.find(ref => ref.name === 'refs/heads/alias')?.color);
  const localUpstream = { name: 'refs/heads/tracked-local', hash: 'B' };
  const local = layout(commits, { refs: [currentRef, localUpstream], currentRef, upstreamRef: localUpstream }).rows;
  assert.equal(local[1].references[0].icon, 'git-branch', 'local dot upstream does not get a remote cloud icon');
});

test('uncommitted status and grouped diffs preserve index, renames, intent-to-add and bounded special files', async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'git-graph-uncommitted-')));
  try {
    await git(repo, ['init', '-b', 'main']);
    for (const [key, value] of [['user.name', 'Worktree Test'], ['user.email', 'worktree@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null'], ['core.autocrlf', 'false'], ['core.filemode', 'true']]) await git(repo, ['config', key, value]);
    for (const [path, text] of [['mixed.txt', 'HEAD\n'], ['old.txt', 'rename\n'], ['delete.txt', 'deleted\n'], ['mode.txt', 'mode\n'], ['.gitignore', 'ignored*\n']]) await writeFile(join(repo, path), text);
    await symlink('/outside/original', join(repo, 'link')); await git(repo, ['add', '-A']); await git(repo, ['commit', '-m', 'Initial']);
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim(), renamed = ':(glob)*中文\tnew\nfile.txt';
    await rename(join(repo, 'old.txt'), join(repo, renamed)); await git(repo, ['add', '--', 'old.txt', renamed]);
    await writeFile(join(repo, renamed), 'rename\nworktree\n');
    await writeFile(join(repo, 'mixed.txt'), 'INDEX\n'); await git(repo, ['add', '--', 'mixed.txt']); await writeFile(join(repo, 'mixed.txt'), 'HEAD\n');
    await rm(join(repo, 'delete.txt')); await chmod(join(repo, 'mode.txt'), 0o755);
    await rm(join(repo, 'link')); await symlink('/outside/modified', join(repo, 'link'));
    await mkdir(join(repo, 'new')); await writeFile(join(repo, 'new', 'space file.txt'), 'untracked\n');
    await writeFile(join(repo, 'ignored-secret'), 'ignored\n'); await writeFile(join(repo, 'intent.txt'), 'intent\n'); await git(repo, ['add', '-N', '--', 'intent.txt']);
    await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 1])); await writeFile(join(repo, 'invalid.txt'), Buffer.from([0xff]));
    await writeFile(join(repo, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
    const before = await readFile(join(repo, '.git/index')), headBefore = await readFile(join(repo, '.git/HEAD'));
    const detail = await worktree({ repoPath: repo }); assert.equal(detail.head, head); assert.equal(detail.headName, 'main');
    assert.equal(detail.files.filter(file => file.path === 'mixed.txt').length, 2, 'the two phases remain visible even when HEAD and worktree cancel');
    assert.ok(!detail.files.some(file => file.path === 'ignored-secret'));
    assert.deepEqual(detail.files.filter(file => file.path === 'intent.txt').map(file => [file.group, file.status, file.original.id]), [['changes', 'A', null]]);
    const read = (group: 'staged' | 'changes', path: string) => worktreeDiff({ repoPath: repo, group, path });
    const staged = await read('staged', 'mixed.txt'), changes = await read('changes', 'mixed.txt');
    assert.equal(staged.headName, 'main'); assert.equal(changes.headName, 'main');
    assert.deepEqual([staged.original.source, staged.original.content, staged.modified.source, staged.modified.content], ['head', 'HEAD\n', 'index', 'INDEX\n']);
    assert.deepEqual([changes.original.source, changes.original.content, changes.modified.source, changes.modified.content], ['index', 'INDEX\n', 'worktree', 'HEAD\n']);
    const moved = await read('staged', renamed), edited = await read('changes', renamed);
    assert.equal(moved.status, 'R100'); assert.equal(moved.original.path, 'old.txt'); assert.equal(moved.modified.path, renamed);
    assert.equal(moved.original.content, moved.modified.content); assert.equal(edited.original.path, renamed); assert.equal(edited.oldPath, null);
    assert.deepEqual([edited.original.content, edited.modified.content], ['rename\n', 'rename\nworktree\n']);
    for (const path of ['intent.txt', 'new/space file.txt']) {
      const added = await read('changes', path); assert.equal(added.original.source, 'empty'); assert.equal(added.original.exists, false); assert.equal(added.modified.source, 'worktree');
    }
    const deleted = await read('changes', 'delete.txt'); assert.equal(deleted.original.content, 'deleted\n'); assert.equal(deleted.modified.exists, false); assert.equal(deleted.modified.source, 'empty');
    const mode = await read('changes', 'mode.txt'); assert.equal(mode.original.content, mode.modified.content); assert.deepEqual([mode.original.mode, mode.modified.mode], ['100644', '100755']);
    const link = await read('changes', 'link'); assert.deepEqual([link.original.content, link.modified.content, link.modified.mode], ['/outside/original', '/outside/modified', '120000']);
    for (const [path, key] of [['binary.bin', 'backend.file.binary'], ['invalid.txt', 'backend.file.encoding'], ['large.txt', 'backend.file.tooLarge']] as const) assert.equal((await read('changes', path)).modified.reason?.key, key);
    assert.equal((await worktreeFile({ repoPath: repo, group: 'changes', path: 'new/space file.txt' })).path, await realpath(join(repo, 'new/space file.txt')));
    await assert.rejects(worktreeFile({ repoPath: repo, group: 'changes', path: 'link' }), isErrorKey('backend.file.missingWorkspace'));
    for (const path of ['../outside', 'intent.txt\0', '/etc/passwd']) await assert.rejects(read('changes', path), isErrorKey('backend.file.outsideRange'));
    await assert.rejects(read('staged', 'intent.txt'), isErrorKey('backend.file.outsideRange'));
    assert.deepEqual(await readFile(join(repo, '.git/index')), before); assert.deepEqual(await readFile(join(repo, '.git/HEAD')), headBefore);
    await git(repo, ['checkout', '-b', 'same-head']); const sameHead = await read('changes', 'mixed.txt');
    assert.equal(sameHead.head, head); assert.equal(sameHead.headName, 'same-head', 'a different branch at the same commit has its own diff identity');
    const raw = await git(repo, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--renames']);
    for (const malformed of [raw.slice(0, -1), raw + '? ../outside\0', raw + '? intent.txt\0', raw.replace('# branch.oid ', '# broken.oid ')]) assert.throws(() => parseWorktreeStatus(malformed), isErrorKey('backend.worktree.invalidStatus'));
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('uncommitted unborn, conflicts, linked worktrees and submodules keep their real source semantics', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'git-graph-worktree-states-'))), unborn = join(directory, 'unborn'), repo = join(directory, 'main'), linked = join(directory, 'linked');
  try {
    for (const path of [unborn, repo]) {
      await mkdir(path); await git(path, ['init', '-b', 'main']);
      for (const [key, value] of [['user.name', 'Worktree Test'], ['user.email', 'worktree@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) await git(path, ['config', key, value]);
    }
    await writeFile(join(unborn, 'staged.txt'), 'staged\n'); await git(unborn, ['add', '--', 'staged.txt']); await writeFile(join(unborn, 'untracked.txt'), 'new\n');
    const initial = await worktree({ repoPath: unborn }); assert.equal(initial.head, ''); assert.equal(initial.headName, 'main');
    const unbornHistory = await history({ repoPath: unborn, branch: 'refs/heads/main' }); assert.equal(unbornHistory.branch, 'refs/heads/main'); assert.equal(unbornHistory.missingBranch, ''); assert.deepEqual(unbornHistory.refs, []);
    const unbornDiff = await worktreeDiff({ repoPath: unborn, group: 'staged', path: 'staged.txt' }); assert.equal(unbornDiff.headName, 'main'); assert.equal(unbornDiff.original.source, 'empty'); assert.equal(unbornDiff.modified.source, 'index'); assert.equal(unbornDiff.modified.content, 'staged\n');
    await writeFile(join(repo, 'conflict.txt'), 'base\n'); await git(repo, ['add', '-A']); await git(repo, ['commit', '-m', 'Base']);
    await git(repo, ['worktree', 'add', '--detach', linked, 'HEAD']); await writeFile(join(linked, 'new.txt'), 'linked\n');
    assert.equal((await worktree({ repoPath: linked })).headName, ''); const linkedDiff = await worktreeDiff({ repoPath: linked, group: 'changes', path: 'new.txt' }); assert.equal(linkedDiff.headName, ''); assert.equal(linkedDiff.modified.content, 'linked\n');
    const detachedHistory = await history({ repoPath: linked }); assert.equal(detachedHistory.branch, '', 'a detached workspace keeps the all filter with only one unrelated local branch');
    assert.ok(!(await worktree({ repoPath: repo })).files.some(file => file.path === 'new.txt'));
    await git(repo, ['checkout', '-b', 'other']); await writeFile(join(repo, 'conflict.txt'), 'theirs\n'); await git(repo, ['add', '-A']); await git(repo, ['commit', '-m', 'Theirs']);
    await git(repo, ['checkout', 'main']); await writeFile(join(repo, 'conflict.txt'), 'ours\n'); await git(repo, ['add', '-A']); await git(repo, ['commit', '-m', 'Ours']);
    await assert.rejects(git(repo, ['merge', 'other']), isErrorKey('backend.git.failure'));
    const index = await readFile(join(repo, '.git/index')), conflicted = await worktree({ repoPath: repo });
    assert.deepEqual(conflicted.files.map(file => [file.group, file.status, file.path]), [['changes', 'U', 'conflict.txt']]);
    const conflict = await worktreeDiff({ repoPath: repo, group: 'changes', path: 'conflict.txt' });
    assert.equal(conflict.original.source, 'index'); assert.equal(conflict.original.reason?.key, 'backend.worktree.conflict'); assert.equal(conflict.original.content, '');
    assert.equal((await worktreeFile({ repoPath: repo, group: 'changes', path: 'conflict.txt' })).path, join(repo, 'conflict.txt'));
    await assert.rejects(worktreeDiff({ repoPath: repo, group: 'staged', path: 'conflict.txt' }), isErrorKey('backend.file.outsideRange'));
    assert.deepEqual(await readFile(join(repo, '.git/index')), index);
    const zero = '0'.repeat(40), id = 'a'.repeat(40);
    for (const xy of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
      const parsed = parseWorktreeStatus(`# branch.oid ${id}\0# branch.head main\0u ${xy} N... 100644 100644 100644 100644 ${id} ${id} ${zero} conflict.txt\0`);
      assert.deepEqual(parsed.files.map(file => [file.group, file.status, file.original.id]), [['changes', 'U', null]]);
    }
    await git(repo, ['merge', '--abort']); const vendor = join(repo, 'vendor'); await mkdir(vendor); await git(vendor, ['init', '-b', 'main']);
    for (const [key, value] of [['user.name', 'Submodule Test'], ['user.email', 'submodule@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) await git(vendor, ['config', key, value]);
    await writeFile(join(vendor, 'file.txt'), 'old\n'); await git(vendor, ['add', '-A']); await git(vendor, ['commit', '-m', 'Old']); const old = (await git(vendor, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['update-index', '--add', '--cacheinfo', `160000,${old},vendor`]); await git(repo, ['commit', '-m', 'Gitlink']);
    await writeFile(join(vendor, 'file.txt'), 'new\n'); await git(vendor, ['add', '-A']); await git(vendor, ['commit', '-m', 'New']); const next = (await git(vendor, ['rev-parse', 'HEAD'])).trim();
    const pointer = await worktreeDiff({ repoPath: repo, group: 'changes', path: 'vendor' }); assert.equal(pointer.original.content, `Subproject commit ${old}\n`); assert.equal(pointer.modified.content, `Subproject commit ${next}\n`); assert.equal(pointer.modified.reason, undefined);
    await writeFile(join(vendor, 'file.txt'), 'dirty\n'); await writeFile(join(vendor, 'untracked.txt'), 'new\n');
    const dirty = await worktreeDiff({ repoPath: repo, group: 'changes', path: 'vendor' }); assert.equal(dirty.modified.reason, undefined); assert.equal(dirty.modified.content, `Subproject commit ${next}-dirty\n`);
    assert.equal((await worktree({ repoPath: repo })).files.find(file => file.path === 'vendor')?.submodule, 'SCMU');
    await rm(join(vendor, 'untracked.txt'));
    assert.equal((await worktree({ repoPath: repo })).files.find(file => file.path === 'vendor')?.submodule, 'SCM.');
    assert.equal((await worktreeDiff({ repoPath: repo, group: 'changes', path: 'vendor' })).modified.content, `Subproject commit ${next}-dirty\n`, 'a changed pointer and tracked dirty state remain comparable');
    await git(vendor, ['restore', '--worktree', '--', 'file.txt']); await writeFile(join(vendor, 'untracked.txt'), 'new\n');
    assert.equal((await worktree({ repoPath: repo })).files.find(file => file.path === 'vendor')?.submodule, 'SC.U');
    assert.equal((await worktreeDiff({ repoPath: repo, group: 'changes', path: 'vendor' })).modified.content, `Subproject commit ${next}-dirty\n`, 'a changed pointer and untracked dirty state remain comparable');
    await git(repo, ['update-index', '--cacheinfo', `160000,${next},vendor`]);
    const staged = await worktreeDiff({ repoPath: repo, group: 'staged', path: 'vendor' }); assert.equal(staged.modified.source, 'index'); assert.equal(staged.modified.content, `Subproject commit ${next}\n`);
    const dirtyOnly = await worktreeDiff({ repoPath: repo, group: 'changes', path: 'vendor' }); assert.equal(dirtyOnly.original.content, `Subproject commit ${next}\n`); assert.equal(dirtyOnly.modified.content, `Subproject commit ${next}-dirty\n`); assert.equal(dirtyOnly.modified.reason, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('uncommitted reads reject concurrent staging, deletion and replaced parent symlinks', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'git-graph-worktree-race-'))), repo = join(directory, 'repo'), bin = join(directory, 'bin'), outside = join(directory, 'outside');
  const savedEnvironment = { PATH: process.env.PATH, GRAPH_STATE_GIT: process.env.GRAPH_STATE_GIT, GRAPH_STATE_MARKER: process.env.GRAPH_STATE_MARKER, GRAPH_STATE_ACTION: process.env.GRAPH_STATE_ACTION, GRAPH_STATE_REPO: process.env.GRAPH_STATE_REPO, GRAPH_STATE_OUTSIDE: process.env.GRAPH_STATE_OUTSIDE };
  try {
    await mkdir(repo); await mkdir(bin); await mkdir(outside); await mkdir(join(repo, 'src')); await writeFile(join(outside, 'file.txt'), 'external secret\n');
    await git(repo, ['init', '-b', 'main']);
    for (const [key, value] of [['user.name', 'Race Test'], ['user.email', 'race@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) await git(repo, ['config', key, value]);
    await writeFile(join(repo, 'src', 'file.txt'), 'base\n'); await git(repo, ['add', '-A']); await git(repo, ['commit', '-m', 'Base']);
    const binary = (await promisify(execFile)('/usr/bin/which', ['git'])).stdout.trim(), marker = join(directory, 'changed');
    await writeFile(join(bin, 'git'), `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const args = process.argv.slice(2), result = cp.spawnSync(process.env.GRAPH_STATE_GIT, args);
if (args.includes('status') && !fs.existsSync(process.env.GRAPH_STATE_MARKER)) {
  fs.writeFileSync(process.env.GRAPH_STATE_MARKER, 'changed');
  const repo = process.env.GRAPH_STATE_REPO, file = path.join(repo, 'src/file.txt');
  if (process.env.GRAPH_STATE_ACTION === 'stage') { fs.writeFileSync(file, 'next index\\n'); cp.spawnSync(process.env.GRAPH_STATE_GIT, ['-C', repo, 'add', '--', 'src/file.txt']); }
  else if (process.env.GRAPH_STATE_ACTION === 'delete') fs.unlinkSync(file);
  else { fs.renameSync(path.join(repo, 'src'), path.join(repo, 'saved')); fs.symlinkSync(process.env.GRAPH_STATE_OUTSIDE, path.join(repo, 'src')); }
}
process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });
    Object.assign(process.env, { GRAPH_STATE_GIT: binary, GRAPH_STATE_MARKER: marker, GRAPH_STATE_REPO: repo, GRAPH_STATE_OUTSIDE: outside });
    for (const action of ['stage', 'delete', 'escape']) {
      await git(repo, ['restore', '--staged', '--worktree', '--', 'src/file.txt']); await writeFile(join(repo, 'src', 'file.txt'), 'modified\n'); await rm(marker, { force: true });
      process.env.GRAPH_STATE_ACTION = action; process.env.PATH = `${bin}:${savedEnvironment.PATH}`;
      try { await assert.rejects(worktreeDiff({ repoPath: repo, group: 'changes', path: 'src/file.txt' }), isErrorKey(action === 'escape' ? 'backend.file.outsideRepository' : 'backend.worktree.changed')); }
      finally { process.env.PATH = savedEnvironment.PATH; if (action === 'escape') { await rm(join(repo, 'src')); await rename(join(repo, 'saved'), join(repo, 'src')); } }
    }
  } finally {
    for (const [key, value] of Object.entries(savedEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});

test('real Git history, merge parents, renames, paths, pagination, read-only state and MCP window contract', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'git graph 测试-'));
  const worktree = `${repo}-linked`;
  const noGit = await mkdtemp(join(tmpdir(), 'git graph empty-'));
  const runner = join(noGit, 'server.mjs');
  const client = new Client({ name: 'git-graph-test', version: '1.0.0' });
  const linkedClient = new Client({ name: 'git-graph-linked-test', version: '1.0.0' });
  const emptyClient = new Client({ name: 'git-graph-empty-test', version: '1.0.0' });
  try {
    await writeFile(runner, `import { createServer } from ${JSON.stringify(new URL('./dist/server.mjs', import.meta.url).href)};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server/stdio'))};
await createServer({ readContext: async () => ({ cwd: process.cwd(), runtimeRoots: [process.cwd()], sourceRoots: [], worktrees: [], notices: [] }) }).connect(new StdioServerTransport());`);
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.name', 'Graph Test']);
    await git(repo, ['config', 'user.email', 'graph@example.invalid']);
    assert.equal((await history({ repoPath: repo })).commits.length, 0);
    await writeFile(join(repo, 'alpha.txt'), 'one\ntwo\nthree\n');
    await git(repo, ['add', '--', 'alpha.txt']); await git(repo, ['commit', '-m', 'Initial commit']);
    const root = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const singleBranch = await history({ repoPath: repo });
    assert.equal(singleBranch.refs.length, 1);
    assert.equal(singleBranch.branch, 'refs/heads/main');
    assert.deepEqual(singleBranch.tips, [root]);
    await git(repo, ['checkout', '-b', 'feature']);
    await writeFile(join(repo, 'feature.txt'), 'feature\n');
    await git(repo, ['add', '--', 'feature.txt']); await git(repo, ['commit', '-m', '<img src=x onerror=alert(1)> feature']);
    const feature = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['checkout', 'main']);
    await writeFile(join(repo, 'alpha.txt'), 'one\ntwo changed\nthree\n');
    await git(repo, ['add', '--', 'alpha.txt']); await git(repo, ['commit', '-m', 'Update alpha']);
    await git(repo, ['merge', '--no-ff', 'feature', '-m', 'Merge feature']);
    const merge = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const strange = 'renamed\t中文\nfile.txt';
    await rename(join(repo, 'alpha.txt'), join(repo, strange));
    await git(repo, ['add', '-A']); await git(repo, ['commit', '-m', 'Rename alpha']);
    await git(repo, ['tag', '-a', 'v1.0', '-m', 'version one']);
    const latest = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await writeFile(join(repo, 'untracked.txt'), 'do not touch');
    const before = await git(repo, ['status', '--porcelain=v1', '-z']);
    const indexBefore = await readFile(join(repo, '.git/index'));
    const logBefore = await readFile(join(repo, '.git/logs/HEAD'));
    const all = await history({ repoPath: repo });
    assert.equal(all.commits.length, 5);
    assert.equal(all.head, latest);
    assert.equal(all.refs.find(ref => ref.name === 'refs/tags/v1.0')?.hash, latest);
    checkGraph(all.commits);
    await git(repo, ['branch', '--set-upstream-to=feature', 'main']);
    const tracked = await history({ repoPath: repo });
    assert.equal(tracked.refs.find(ref => ref.name === 'refs/heads/main')?.upstream, 'refs/heads/feature');
    const first = await history({ repoPath: repo, limit: 2 });
    assert.equal(first.hasMore, true);
    const next = await history({ repoPath: repo, limit: 3, offset: 2, tips: first.tips });
    assert.deepEqual([...first.commits, ...next.commits].map(c => c.hash), all.commits.map(c => c.hash));
    checkGraph(first.commits);
    const branch = await history({ repoPath: repo, branch: 'refs/heads/feature' });
    assert.deepEqual(branch.commits.map(c => c.hash), [feature, root]);
    const detail = await commit({ repoPath: repo, hash: merge });
    assert.equal(detail.parents.length, 2);
    assert.deepEqual(detail.files.map(file => file.path), ['feature.txt']);
    assert.deepEqual((await commit({ repoPath: repo, hash: merge, parent: 1 })).files.map(file => file.path), ['alpha.txt']);
    const renamed = await commit({ repoPath: repo, hash: latest });
    assert.deepEqual(renamed.files, [{ status: 'R100', oldPath: 'alpha.txt', path: strange }]);
    const renameDiff = await diff({ repoPath: repo, hash: latest, path: strange });
    assert.equal(renameDiff.original.path, 'alpha.txt');
    assert.equal(renameDiff.modified.path, strange);
    assert.equal(renameDiff.original.content, renameDiff.modified.content);
    const rootDiff = await diff({ repoPath: repo, hash: root, path: 'alpha.txt' });
    assert.equal(rootDiff.original.exists, false);
    assert.equal(rootDiff.original.content, '');
    assert.equal(rootDiff.modified.content, 'one\ntwo\nthree\n');
    assert.equal((await workspaceFile({ repoPath: repo, hash: latest, path: strange })).path, await realpath(join(repo, strange)));
    await assert.rejects(workspaceFile({ repoPath: repo, hash: root, path: 'alpha.txt' }), isErrorKey('backend.file.missingWorkspace'));
    await assert.rejects(workspaceFile({ repoPath: repo, hash: latest, path: '../outside' }), isErrorKey('backend.file.outsideRange'));
    await assert.rejects(diff({ repoPath: repo, hash: root, path: '../../etc/passwd' }), isErrorKey('backend.file.outsideRange'));
    await assert.rejects(commit({ repoPath: repo, hash: '--output=x' }), isErrorKey('backend.git.invalidHash'));
    await assert.rejects(commit({ repoPath: repo, hash: root, parent: 1 }), isErrorKey('backend.git.invalidParent'));
    await assert.rejects(repository('relative/path'), isErrorKey('backend.path.absolute'));
    assert.equal(await git(repo, ['status', '--porcelain=v1', '-z']), before);
    assert.deepEqual(await readFile(join(repo, '.git/index')), indexBefore);
    assert.deepEqual(await readFile(join(repo, '.git/logs/HEAD')), logBefore);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [runner], cwd: repo }));
    const icons = client.getServerVersion()?.icons;
    assert.ok(icons);
    assert.deepEqual(icons.map(icon => icon.theme), ['light', 'dark']);
    for (const icon of icons) {
      assert.equal(icon.mimeType, 'image/svg+xml');
      assert.match(icon.src, /^data:image\/svg\+xml[;,]/);
      const asset = `./assets/git-branch${icon.theme === 'dark' ? '-dark' : ''}.svg`;
      assert.equal(await (await fetch(icon.src)).text(), await readFile(new URL(asset, import.meta.url), 'utf8'));
    }
    const tools = await client.listTools();
    for (const name of ['git_graph_commit', 'git_graph_diff', 'git_graph_workspace_file']) {
      const schema = tools.tools.find(tool => tool.name === name)!.inputSchema;
      assert.deepEqual(Object.keys(schema.properties!).sort(), name === 'git_graph_commit' ? ['hash', 'parent', 'repository']
        : name === 'git_graph_workspace_file' ? ['base', 'hash', 'parent', 'path', 'repository'] : ['hash', 'parent', 'path', 'repository']);
      assert.equal(schema.additionalProperties, false);
    }
    for (const name of ['git_graph_compare', 'git_graph_compare_diff']) {
      const tool = tools.tools.find(tool => tool.name === name)!;
      assert.deepEqual(Object.keys(tool.inputSchema.properties!).sort(), name === 'git_graph_compare' ? ['base', 'hash', 'repository'] : ['base', 'hash', 'path', 'repository']);
      assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.annotations?.readOnlyHint, true);
    }
    for (const name of ['git_graph_worktree', 'git_graph_worktree_diff', 'git_graph_worktree_file']) {
      const tool = tools.tools.find(tool => tool.name === name)!;
      assert.deepEqual(Object.keys(tool.inputSchema.properties!).sort(), name === 'git_graph_worktree' ? ['repository'] : ['group', 'path', 'repository']);
      assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.annotations?.readOnlyHint, true);
      assert.deepEqual(uiMetadata.parse(tool._meta).ui.visibility, ['app']);
    }
    assert.ok(!tools.tools.some(tool => tool.name.startsWith('git_graph_working_')));
    const tool = tools.tools.find(tool => tool.name === 'git_graph');
    assert.ok(tool);
    const metadata = uiMetadata.parse(tool._meta);
    assert.deepEqual(metadata['openai/ui']?.entrypoints, [{ type: 'thread' }]);
    assert.equal(tool.annotations?.readOnlyHint, true);
    const opened = await callTool(client, { name: 'git_graph', arguments: {} });
    assert.equal(opened.isError, undefined);
    assert.ok('commits' in opened.structuredContent);
    assert.equal(opened.structuredContent.commits.length, 5);
    const current = await callTool(client, { name: 'git_graph', arguments: {} });
    assert.equal(current.structuredContent.repo, await repository(repo));
    assert.ok('commits' in current.structuredContent);
    assert.equal(current.structuredContent.commits[0].hash, latest);
    assert.equal((await callTool(client, { name: 'git_graph_history', arguments: {} })).structuredContent.head, latest);
    const working = (await callTool(client, { name: 'git_graph_worktree', arguments: {} })).structuredContent;
    assert.deepEqual(working.files.map(file => [file.group, file.path]), [['changes', 'untracked.txt']]);
    assert.equal((await callTool(client, { name: 'git_graph_worktree_diff', arguments: { group: 'changes', path: 'untracked.txt' } })).structuredContent.modified.content, 'do not touch');
    assert.equal((await callTool(client, { name: 'git_graph_worktree_file', arguments: { group: 'changes', path: 'untracked.txt' } })).structuredContent.path, await realpath(join(repo, 'untracked.txt')));
    for (const arguments_ of [{ group: 'staged', path: 'untracked.txt' }, { group: 'changes', path: '../outside' }, { group: 'other', path: 'untracked.txt' }, { group: 'changes', path: 'untracked.txt', repoPath: noGit }, { group: 'changes', path: 'untracked.txt', repository: 'f'.repeat(64) }]) {
      for (const name of ['git_graph_worktree_diff', 'git_graph_worktree_file']) assert.equal((await client.callTool({ name, arguments: arguments_ })).isError, true);
    }
    assert.deepEqual(await readFile(join(repo, '.git/index')), indexBefore);
    assert.equal((await callTool(client, { name: 'git_graph_commit', arguments: { hash: merge } })).structuredContent.parents.length, 2);
    assert.equal((await callTool(client, { name: 'git_graph_diff', arguments: { hash: root, path: 'alpha.txt' } })).structuredContent.modified.content, 'one\ntwo\nthree\n');
    assert.equal((await callTool(client, { name: 'git_graph_workspace_file', arguments: { hash: latest, path: strange } })).structuredContent.path, await realpath(join(repo, strange)));
    assert.deepEqual((await callTool(client, { name: 'git_graph_compare', arguments: { base: merge, hash: latest } })).structuredContent.files, renamed.files);
    assert.equal((await callTool(client, { name: 'git_graph_compare_diff', arguments: { base: merge, hash: latest, path: strange } })).structuredContent.original.content, renameDiff.original.content);
    for (const arguments_ of [{ base: '--output=x', hash: latest }, { base: root, hash: 'outgoing' }, { base: root, hash: latest, repoPath: noGit }]) {
      assert.equal((await client.callTool({ name: 'git_graph_compare', arguments: arguments_ })).isError, true);
    }
    assert.equal((await client.callTool({ name: 'git_graph_compare_diff', arguments: { base: root, hash: latest, path: '../outside' } })).isError, true);
    assert.equal((await client.callTool({ name: 'git_graph_workspace_file', arguments: { base: merge, hash: latest, path: strange, parent: 0 } })).isError, true);
    for (const name of ['git_graph', 'git_graph_history', 'git_graph_commit', 'git_graph_diff', 'git_graph_workspace_file']) {
      const changed = await client.callTool({ name, arguments: { repoPath: noGit, ...(['git_graph_commit', 'git_graph_diff', 'git_graph_workspace_file'].includes(name) ? { hash: root } : {}), ...(['git_graph_diff', 'git_graph_workspace_file'].includes(name) ? { path: 'alpha.txt' } : {}) } });
      assert.equal(changed.isError, true, 'the task repository cannot be overridden');
    }
    const resource = await client.readResource({ uri: metadata.ui.resourceUri! });
    assert.ok('text' in resource.contents[0]);
    assert.match(resource.contents[0].text, /Git Graph/);
    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    const denied = await client.callTool({ name: 'git_graph_diff', arguments: { hash: root, path: '../outside' } });
    assert.equal(denied.isError, true);
    await writeFile(join(noGit, 'external.txt'), 'outside repository');
    await rename(join(repo, strange), join(repo, 'saved.txt'));
    await symlink(join(noGit, 'external.txt'), join(repo, strange));
    await assert.rejects(workspaceFile({ repoPath: repo, hash: latest, path: strange }), isErrorKey('backend.file.outsideRepository'));
    await assert.rejects(workspaceFile({ repoPath: repo, base: merge, hash: latest, path: strange }), isErrorKey('backend.file.outsideRepository'));
    await rm(join(repo, strange)); await rename(join(repo, 'saved.txt'), join(repo, strange));
    await git(repo, ['worktree', 'add', '--detach', worktree, feature]);
    await linkedClient.connect(new StdioClientTransport({ command: process.execPath,
      args: [runner], cwd: worktree }));
    const linked = await callTool(linkedClient, { name: 'git_graph', arguments: {} });
    assert.equal(linked.structuredContent.repo, await repository(worktree));
    assert.equal(linked.structuredContent.repositories.length, 1);
    assert.equal(linked.structuredContent.repositories[0].displayPath, await repository(worktree));
    assert.ok('head' in linked.structuredContent);
    assert.equal(linked.structuredContent.head, feature);
    const refreshed = (await callTool(client, { name: 'git_graph', arguments: {} })).structuredContent;
    assert.ok('head' in refreshed);
    assert.equal(refreshed.head, latest);
    await emptyClient.connect(new StdioClientTransport({ command: process.execPath,
      args: [runner], cwd: noGit }));
    const empty = await callTool(emptyClient, { name: 'git_graph', arguments: {} });
    assert.equal(empty.isError, undefined);
    assert.equal(empty.structuredContent.repo, null);
    assert.ok(empty.structuredContent.contextCwd.endsWith(noGit.split('/').at(-1)!));
  } finally {
    await client.close();
    await linkedClient.close(); await emptyClient.close();
    await rm(worktree, { recursive: true, force: true });
    await rm(noGit, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('graph edges preserve ancestry across multi-parent DAGs and partial histories', () => {
  let seed = 49213;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let run = 0; run < 30; run++) {
    const commits = Array.from({ length: 80 }, (_, i) => ({ hash: String(i), parents: i === 79 ? [] :
      [...new Set(Array.from({ length: 1 + Math.floor(random() * 3) }, () => String(i + 1 + Math.floor(random() * (79 - i)))))] }));
    checkGraph(commits); checkGraph(commits.slice(0, 25));
  }
});

test('commit diff reads exact blobs and represents missing, binary, large and special files', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'git-graph-revisions-'));
  try {
    await git(repo, ['init', '-b', 'main']);
    for (const [key, value] of [['user.name', 'Graph Test'], ['user.email', 'graph@example.invalid'],
      ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null'], ['core.autocrlf', 'false']]) await git(repo, ['config', key, value]);
    const save = async (message: string) => {
      await git(repo, ['add', '-A']); await git(repo, ['commit', '-m', message]);
      return (await git(repo, ['rev-parse', 'HEAD'])).trim();
    };
    const path = ':(glob)*中文\tfile.txt';
    await writeFile(join(repo, path), 'original\n');
    await writeFile(join(repo, 'deleted.txt'), 'delete me\n');
    await writeFile(join(repo, 'eol.txt'), '\uFEFFone\r\ntwo');
    const base = await save('Original files');
    await writeFile(join(repo, path), 'modified\n');
    await rm(join(repo, 'deleted.txt'));
    await writeFile(join(repo, 'empty.txt'), '');
    await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 1, 2]));
    await writeFile(join(repo, 'invalid.txt'), Buffer.from([0xff, 0xfe]));
    await writeFile(join(repo, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
    await writeFile(join(repo, 'eol.txt'), 'one\ntwo');
    await symlink('/outside/repository', join(repo, 'link'));
    const target = await save('Changed files');
    const detail = await commit({ repoPath: repo, hash: target });
    assert.equal(detail.base, base);
    assert.deepEqual((await compare({ repoPath: repo, base, hash: target })).files, detail.files);
    const read = (path: string) => diff({ repoPath: repo, hash: target, path });
    for (const file of detail.files) assert.deepEqual(await compareDiff({ repoPath: repo, base, hash: target, path: file.path }), await read(file.path));
    const changed = await read(path);
    assert.equal(changed.original.content, 'original\n');
    assert.equal(changed.modified.content, 'modified\n');
    const removed = await read('deleted.txt');
    assert.equal(removed.original.content, 'delete me\n');
    assert.equal(removed.modified.exists, false);
    const added = await read('empty.txt');
    assert.equal(added.original.exists, false);
    assert.equal(added.modified.exists, true);
    assert.equal(added.modified.content, '');
    assert.match(format((await read('binary.bin')).modified.reason!, 'zh-CN'), /二进制/);
    assert.match(format((await read('invalid.txt')).modified.reason!, 'zh-CN'), /UTF-8/);
    assert.match(format((await read('large.txt')).modified.reason!, 'zh-CN'), /2 MiB/);
    const eol = await read('eol.txt');
    assert.equal(eol.original.content, '\uFEFFone\r\ntwo');
    assert.equal(eol.modified.content, 'one\ntwo');
    const link = await read('link');
    assert.equal(link.modified.mode, '120000');
    assert.equal(link.modified.content, '/outside/repository');
    await assert.rejects(read('../outside'), isErrorKey('backend.file.outsideRange'));
    await assert.rejects(read('eol.txt\0'), isErrorKey('backend.file.outsideRange'));
    // Mode-only and submodule changes must remain visible even without a text hunk.
    await git(repo, ['update-index', '--chmod=+x', '--', path]);
    await git(repo, ['update-index', '--add', '--cacheinfo', `160000,${base},vendor`]);
    await git(repo, ['commit', '-m', 'Modes and submodule']);
    const modeCommit = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const mode = await diff({ repoPath: repo, hash: modeCommit, path });
    assert.equal(mode.original.content, mode.modified.content);
    assert.equal(mode.original.mode, '100644');
    assert.equal(mode.modified.mode, '100755');
    const submodule = await diff({ repoPath: repo, hash: modeCommit, path: 'vendor' });
    assert.equal(submodule.modified.content, `Subproject commit ${base}\n`);
    assert.equal(submodule.modified.mode, '160000');
    assert.deepEqual(await compareDiff({ repoPath: repo, base: target, hash: modeCommit, path: 'vendor' }), submodule);
    assert.deepEqual(await compareDiff({ repoPath: repo, base: target, hash: modeCommit, path }), mode);
    assert.deepEqual((await compare({ repoPath: repo, base: target, hash: target })).files, []);
    await assert.rejects(compare({ repoPath: repo, base: '--output=x', hash: target }), isErrorKey('backend.git.invalidHash'));
    await assert.rejects(compare({ repoPath: repo, base, hash: 'f'.repeat(40) }));
    await assert.rejects(compareDiff({ repoPath: repo, base, hash: target, path: '../outside' }), isErrorKey('backend.file.outsideRange'));
    await assert.rejects(compareDiff({ repoPath: repo, base, hash: target, path: `${path}\0` }), isErrorKey('backend.file.outsideRange'));
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('history retains reachable selections after new commits and excludes anchors removed by rewritten tips', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'git-graph-retained-'));
  try {
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.name', 'Graph Test']); await git(repo, ['config', 'user.email', 'graph@example.invalid']);
    await writeFile(join(repo, 'file.txt'), 'base'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'Base']);
    const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await writeFile(join(repo, 'file.txt'), 'selected'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'Selected']);
    const selected = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await writeFile(join(repo, 'file.txt'), 'new tip'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'New tip']);
    const refreshed = await history({ repoPath: repo, limit: 1, retain: [selected, base] });
    assert.deepEqual(refreshed.retained, [selected, base]);
    assert.equal(refreshed.commits.length, 1); assert.equal(refreshed.offset, 0);
    assert.ok(!refreshed.commits.some(commit => commit.hash === selected), 'reachability does not inject anchors into a page');
    assert.deepEqual((await history({ repoPath: repo, tips: refreshed.tips, offset: 1, limit: 1 })).commits.map(commit => commit.hash), [selected]);
    await git(repo, ['reset', '--hard', base]);
    await writeFile(join(repo, 'file.txt'), 'rewritten'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'Rewritten tip']);
    const rewritten = await history({ repoPath: repo, limit: 1, retain: [selected, base] });
    assert.deepEqual(rewritten.retained, [base], 'an unreachable previous selection must not keep requesting more pages');
    assert.ok(!('retained' in await history({ repoPath: repo })), 'ordinary history calls preserve their contract');
    await assert.rejects(history({ repoPath: repo, retain: ['invalid'] }), isErrorKey('backend.git.invalidRetained'));
    await assert.rejects(history({ repoPath: repo, retain: ['f'.repeat(40)] }), /Not a valid|bad object|fatal:/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('history reads native sync ancestry, local upstreams and missing states without changing Git', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'git-graph-sync-'));
  const outside = await mkdtemp(join(tmpdir(), 'git-graph-sync-outside-'));
  try {
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.name', 'Graph Test']); await git(repo, ['config', 'user.email', 'graph@example.invalid']);
    const save = async (message: string) => {
      await git(repo, ['add', '-A']); await git(repo, ['commit', '-m', message]);
      return (await git(repo, ['rev-parse', 'HEAD'])).trim();
    };
    const read = async () => {
      const config = await readFile(join(repo, '.git/config'));
      const index = await readFile(join(repo, '.git/index'));
      const log = await readFile(join(repo, '.git/logs/HEAD'));
      const refs = await git(repo, ['for-each-ref']);
      const value = await history({ repoPath: repo });
      assert.deepEqual(await readFile(join(repo, '.git/config')), config);
      assert.deepEqual(await readFile(join(repo, '.git/index')), index);
      assert.deepEqual(await readFile(join(repo, '.git/logs/HEAD')), log);
      assert.equal(await git(repo, ['for-each-ref']), refs);
      assert.ok(!('uncommitted' in value));
      return value;
    };
    await writeFile(join(repo, 'common.txt'), 'base\n'); const base = await save('Base');
    await git(repo, ['remote', 'add', 'origin', '/not-contacted']);
    await git(repo, ['update-ref', 'refs/remotes/origin/main', base]);
    await git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    const untracked = await read();
    assert.equal(untracked.currentRef?.name, 'refs/heads/main');
    assert.equal(untracked.upstreamRef, null); assert.equal(untracked.mergeBase, null);
    assert.equal(untracked.baseRef?.name, 'refs/remotes/origin/main');
    await git(repo, ['branch', '--set-upstream-to=origin/main', 'main']);
    const equal = await read();
    assert.equal(equal.upstreamRef?.hash, base); assert.equal(equal.mergeBase, base); assert.equal(equal.baseRef, null);
    await git(repo, ['tag', 'main', base]);
    await git(repo, ['update-ref', 'refs/remotes/origin/base', base]);
    await git(repo, ['config', 'branch.main.vscode-merge-base', 'origin/base']);
    const ambiguous = await read();
    assert.equal(ambiguous.headName, 'main'); assert.equal(ambiguous.currentRef?.name, 'refs/heads/main');
    assert.equal(ambiguous.currentRef?.hash, base); assert.equal(ambiguous.upstreamRef?.name, 'refs/remotes/origin/main');
    assert.equal(ambiguous.baseRef?.name, 'refs/remotes/origin/base'); assert.equal(ambiguous.mergeBase, base);
    await git(repo, ['tag', '-d', 'main']); await git(repo, ['config', '--unset', 'branch.main.vscode-merge-base']);
    await writeFile(join(repo, 'local.txt'), 'local\n'); await writeFile(join(repo, 'common.txt'), 'temporary\n');
    await save('Local'); await writeFile(join(repo, 'common.txt'), 'base\n'); const local = await save('Revert temporary edit');
    const ahead = await read();
    assert.equal(ahead.currentRef?.hash, local); assert.equal(ahead.upstreamRef?.hash, base); assert.equal(ahead.mergeBase, base);
    const range = await compare({ repoPath: repo, base, hash: local });
    assert.deepEqual(range.files.map(file => file.path), ['local.txt'], 'aggregate net range excludes reverted intermediate edits');
    assert.deepEqual(range.parents, []); assert.equal(range.parent, 0); assert.equal(range.message, '');
    assert.equal((await workspaceFile({ repoPath: repo, base, hash: local, path: 'local.txt' })).path, await realpath(join(repo, 'local.txt')));
    await assert.rejects(workspaceFile({ repoPath: repo, hash: local, path: 'local.txt' }), isErrorKey('backend.file.outsideRange'), 'the tip commit alone does not contain earlier range changes');
    await assert.rejects(workspaceFile({ repoPath: repo, base, hash: local, path: '../outside' }), isErrorKey('backend.file.outsideRange'));
    await assert.rejects(workspaceFile({ repoPath: repo, base, hash: local, path: 'local.txt\0' }), isErrorKey('backend.file.outsideRange'));
    await assert.rejects(workspaceFile({ repoPath: repo, base, hash: local, path: 'local.txt', parent: 0 }), isErrorKey('backend.file.baseAndParent'));
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await rm(join(repo, 'local.txt')); await symlink(join(outside, 'secret.txt'), join(repo, 'local.txt'));
    await assert.rejects(workspaceFile({ repoPath: repo, base, hash: local, path: 'local.txt' }), isErrorKey('backend.file.outsideRepository'));
    await rm(join(repo, 'local.txt')); await writeFile(join(repo, 'local.txt'), 'local\n');
    await git(repo, ['checkout', '-b', 'remote-tip']); await writeFile(join(repo, 'remote.txt'), 'remote\n');
    const remoteAhead = await save('Remote ahead'); await git(repo, ['checkout', 'main']);
    await git(repo, ['update-ref', 'refs/remotes/origin/main', remoteAhead]);
    assert.equal((await read()).mergeBase, local, 'behind-only common ancestor is the local tip');
    await git(repo, ['checkout', '-b', 'diverged', base]); await writeFile(join(repo, 'remote.txt'), 'fork\n');
    const remoteFork = await save('Remote fork'); await git(repo, ['checkout', 'main']);
    await git(repo, ['update-ref', 'refs/remotes/origin/main', remoteFork]);
    await writeFile(join(repo, 'untracked.txt'), 'not a graph node');
    const diverged = await read(); assert.equal(diverged.mergeBase, base);
    assert.deepEqual((await compare({ repoPath: repo, base, hash: remoteFork })).files.map(file => file.path), ['remote.txt']);
    const page = await history({ repoPath: repo, limit: 1 });
    assert.equal(page.commits.length, 1); assert.equal(page.offset, 0); assert.equal(page.mergeBase, base);
    assert.ok(!page.commits.some(commit => commit.hash.startsWith('scm-graph-')));
    await git(repo, ['branch', 'local-upstream', base]);
    await git(repo, ['branch', '--set-upstream-to=local-upstream', 'main']);
    const localUpstream = await read();
    assert.equal(localUpstream.upstreamRef?.name, 'refs/heads/local-upstream'); assert.equal(localUpstream.mergeBase, base);
    await git(repo, ['branch', '--set-upstream-to=origin/main', 'main']);
    const tree = (await git(repo, ['rev-parse', `${base}^{tree}`])).trim();
    const unrelated = (await git(repo, ['commit-tree', tree, '-m', 'Unrelated root'])).trim();
    await git(repo, ['update-ref', 'refs/remotes/origin/main', unrelated]);
    assert.equal((await read()).mergeBase, null, 'unrelated histories have no invented common ancestor');
    await git(repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const missing = await read(); assert.equal(missing.upstreamRef, null); assert.equal(missing.mergeBase, null);
    await git(repo, ['checkout', '--detach', local]);
    const detached = await read(); assert.equal(detached.currentRef?.name, local);
    assert.equal(detached.upstreamRef, null); assert.equal(detached.baseRef, null); assert.equal(detached.mergeBase, null);
    await git(repo, ['checkout', '--orphan', 'unborn']);
    const unborn = await read(); assert.equal(unborn.head, ''); assert.ok(unborn.refs.length > 0);
    assert.equal(unborn.currentRef, null); assert.equal(unborn.upstreamRef, null); assert.equal(unborn.baseRef, null); assert.equal(unborn.mergeBase, null);
  } finally { await rm(repo, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('base reference reads native config, creation and checkout reflogs, then symbolic remote HEAD', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'git-graph-base-'));
  try {
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.name', 'Graph Test']); await git(repo, ['config', 'user.email', 'graph@example.invalid']);
    await writeFile(join(repo, 'file.txt'), 'base'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'Base']);
    const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    for (const remote of ['aardvark', 'origin']) {
      await git(repo, ['remote', 'add', remote, '/not-contacted']);
      await git(repo, ['update-ref', `refs/remotes/${remote}/default`, base]);
      await git(repo, ['symbolic-ref', `refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/default`]);
    }
    await git(repo, ['update-ref', 'refs/remotes/origin/source', base]);
    const readBase = async () => {
      const config = await readFile(join(repo, '.git/config'));
      const value = await history({ repoPath: repo });
      assert.deepEqual(await readFile(join(repo, '.git/config')), config, 'native base inference does not persist configuration here');
      return value.baseRef?.name || null;
    };
    assert.equal(await readBase(), 'refs/remotes/origin/default', 'origin takes precedence over the first remote');
    await git(repo, ['config', 'branch.main.vscode-merge-base', 'origin/source']);
    assert.equal(await readBase(), 'refs/remotes/origin/source');
    await git(repo, ['config', 'branch.main.vscode-merge-base', 'ORIGIN/SOURCE']);
    assert.equal(await readBase(), ['darwin', 'win32'].includes(process.platform) ? 'refs/remotes/origin/source' : 'refs/remotes/origin/default');
    await git(repo, ['config', 'branch.main.vscode-merge-base', 'main']);
    assert.equal(await readBase(), 'refs/remotes/origin/default', 'a stored local branch is not a native base');
    await git(repo, ['config', 'branch.main.vscode-merge-base', 'origin/missing']);
    assert.equal(await readBase(), 'refs/remotes/origin/default', 'an absent configured ref does not invent a base');
    await git(repo, ['checkout', '-b', 'explicit', 'origin/source']);
    await git(repo, ['branch', '--unset-upstream', 'explicit']);
    assert.equal(await readBase(), 'refs/remotes/origin/source', 'explicit remote creation source precedes default');
    await git(repo, ['branch', '--set-upstream-to=origin/source', 'explicit']);
    await git(repo, ['checkout', '-b', 'from-head']);
    assert.equal(await readBase(), 'refs/remotes/origin/source', 'creation from HEAD resolves its oldest checkout source and upstream');
    await git(repo, ['checkout', 'main']); await git(repo, ['branch', '--set-upstream-to=explicit', 'main']);
    await git(repo, ['checkout', '-b', 'from-local-upstream']);
    assert.equal(await readBase(), 'refs/remotes/origin/default', 'local dot upstream is not a remote base inference');
    await git(repo, ['remote', 'remove', 'origin']);
    assert.equal(await readBase(), 'refs/remotes/aardvark/default');
    await git(repo, ['symbolic-ref', '--delete', 'refs/remotes/aardvark/HEAD']);
    assert.equal(await readBase(), null, 'a missing symbolic remote HEAD never guesses main/master');
    await git(repo, ['remote', 'remove', 'aardvark']);
    assert.equal(await readBase(), null);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('changed UI content gets a new host cache identity', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'git-graph-resource-')));
  const uris = [];
  try {
    await copyFile(new URL('./dist/server.mjs', import.meta.url), join(directory, 'server.mjs'));
    for (const html of ['<p>Original theme</p>', '<p>Updated theme</p>']) {
      await writeFile(join(directory, 'window.html'), html);
      const client = new Client({ name: 'resource-cache-test', version: '1.0.0' });
      try {
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(directory, 'server.mjs')] }));
        const { tools } = await client.listTools();
        const uri = uiMetadata.parse(tools.find(tool => tool.name === 'git_graph')?._meta).ui.resourceUri!;
        const content = (await client.readResource({ uri })).contents[0];
        assert.ok('text' in content);
        assert.equal(content.text, html);
        uris.push(uri);
      } finally { await client.close(); }
    }
    assert.notEqual(uris[0], uris[1], 'a host must not reuse the previous UI after an update');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('panel layout persists across MCP processes and repositories with bounded app-only writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'git-graph-layout-'));
  const data = join(directory, 'data');
  const settings = join(data, 'panel-layout.json');
  const legacy = join(data, 'column-widths.json');
  const runner = join(directory, 'server.mjs');
  const clients: Client[] = [];
  try {
    await writeFile(runner, `import { createServer } from ${JSON.stringify(new URL('./dist/server.mjs', import.meta.url).href)};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server/stdio'))};
await createServer({ preferencesDirectory: ${JSON.stringify(data)} }).connect(new StdioServerTransport());`);
    const connect = async (cwd: string) => {
      const client = new Client({ name: 'layout-test', version: '1.0.0' });
      clients.push(client);
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [runner], cwd }));
      return client;
    };
    await mkdir(data);
    await writeFile(legacy, '{broken legacy layout');
    const first = await connect(import.meta.dirname);
    const { tools } = await first.listTools();
    const save = tools.find(tool => tool.name === 'git_graph_save_layout');
    assert.ok(save);
    assert.equal(save.annotations?.readOnlyHint, false);
    assert.equal(save.annotations?.destructiveHint, false);
    assert.deepEqual(uiMetadata.parse(save._meta).ui.visibility, ['app']);
    assert.ok(tools.filter(tool => tool !== save).every(tool => tool.annotations?.readOnlyHint));
    assert.deepEqual((await callTool(first, { name: 'git_graph_layout', arguments: {} })).structuredContent, { panels: {} });
    const panels = { detailHeight: 380, filesWidth: 180, summaryHeight: 144, detailMaximized: true, fileView: 'tree' };
    assert.ok(!(await callTool(first, { name: 'git_graph_save_layout', arguments: { panels } })).isError);
    await first.close();
    const second = await connect(directory);
    assert.deepEqual((await callTool(second, { name: 'git_graph_layout', arguments: {} })).structuredContent, { panels });
    assert.ok(!(await callTool(second, { name: 'git_graph_save_layout', arguments: { panels } })).isError);
    await writeFile(settings, JSON.stringify({ ...panels, historyCollapsed: true, changesCollapsed: true, detailCollapsed: true, filesCollapsed: true, diffCollapsed: false, summaryCollapsed: true }));
    assert.deepEqual((await callTool(second, { name: 'git_graph_layout', arguments: {} })).structuredContent.panels, panels);
    assert.ok(!(await callTool(second, { name: 'git_graph_save_layout', arguments: { panels } })).isError);
    const savedPanels = await readFile(settings, 'utf8');
    assert.deepEqual(JSON.parse(savedPanels), panels);
    for (const args of [{}, { widths: {} }, { panels: {}, widths: {} },
      { panels: { detailHeight: -1 } }, { panels: { filesWidth: 1 } },
      { panels: { detailMaximized: 'true' } }, { panels: { summaryCollapsed: true } },
      { panels: { summaryHeight: 63 } }, { panels: { summaryHeight: 10001 } },
      { panels: { filesWidth: 96.5 } }, { panels: { repoPath: directory } },
      { panels: { fileView: 'grid' } }, { panels: { fileView: null } },
      { panels: {}, preferencesDirectory: directory }, { panels: {}, repoPath: directory }]) {
      assert.equal((await second.callTool({ name: 'git_graph_save_layout', arguments: args })).isError, true);
      assert.equal(await readFile(settings, 'utf8'), savedPanels);
    }
    const listPanels = { ...panels, fileView: 'list' };
    assert.ok(!(await callTool(second, { name: 'git_graph_save_layout', arguments: { panels: listPanels } })).isError);
    assert.deepEqual((await callTool(second, { name: 'git_graph_layout', arguments: {} })).structuredContent.panels, listPanels);
    assert.equal(await readFile(legacy, 'utf8'), '{broken legacy layout');
    await writeFile(settings, '{broken');
    const invalid = await second.callTool({ name: 'git_graph_layout', arguments: {} });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.content[0].type, 'text');
    assert.ok('text' in invalid.content[0]);
    const descriptor = z.object({ error: z.unknown() }).parse(invalid.structuredContent).error;
    assert.equal(toMessage(descriptor).key, 'backend.preference.read');
    assert.match(format(toMessage(descriptor), 'zh-CN'), /读取面板布局失败/);
    assert.equal(await readFile(settings, 'utf8'), '{broken');
    assert.ok(!(await callTool(second, { name: 'git_graph_save_layout', arguments: { panels: {} } })).isError);
    await second.close();
    const third = await connect(import.meta.dirname);
    assert.deepEqual((await callTool(third, { name: 'git_graph_layout', arguments: {} })).structuredContent, { panels: {} });
    await rm(data, { recursive: true }); await writeFile(data, 'not a directory');
    assert.equal((await third.callTool({ name: 'git_graph_save_layout', arguments: { panels } })).isError, true);
    assert.equal(await readFile(data, 'utf8'), 'not a directory');
  } finally {
    for (const client of clients) await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('project repositories route every Git operation and isolate task scopes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'git-graph-project-'));
  const first = await mkdtemp(join(directory, 'web-'));
  const second = await mkdtemp(join(directory, 'app-'));
  const empty = await mkdtemp(join(directory, 'documents-'));
  const outside = await mkdtemp(join(directory, 'outside-'));
  const linked = join(directory, 'web-linked');
  const runner = join(directory, 'server.mjs'), scopes = join(directory, 'scopes.json');
  const client = new Client({ name: 'project-test', version: '1.0.0' });
  try {
    const heads = [];
    for (const [repo, contents] of [[first, 'web'], [second, 'app']]) {
      await git(repo, ['init', '-b', 'main']);
      await git(repo, ['config', 'user.name', 'Graph Test']);
      await git(repo, ['config', 'user.email', 'graph@example.invalid']);
      await writeFile(join(repo, 'file.txt'), contents);
      await git(repo, ['add', '.']); await git(repo, ['commit', '-m', contents]);
      heads.push((await git(repo, ['rev-parse', 'HEAD'])).trim());
    }
    await git(outside, ['init', '-b', 'main']);
    await git(first, ['worktree', 'add', '--detach', linked, heads[0]]);
    const workspace = { cwd: second, runtimeRoots: [first, linked, second, first, empty], sourceRoots: [], worktrees: [], notices: [] };
    await writeFile(scopes, JSON.stringify(workspace));
    await writeFile(runner, `import { createServer } from ${JSON.stringify(new URL('./dist/server.mjs', import.meta.url).href)};
import { readFile } from 'node:fs/promises';
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server/stdio'))};
await createServer({ preferencesDirectory: ${JSON.stringify(join(directory, 'data'))}, readContext: async threadId => threadId === 'multi' ? JSON.parse(await readFile(${JSON.stringify(scopes)}, 'utf8')) : ({ cwd: ${JSON.stringify(directory)}, runtimeRoots: [${JSON.stringify(directory)}], sourceRoots: [], worktrees: [], notices: [] }) }).connect(new StdioServerTransport());`);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [runner], cwd: outside }));
    const call = (name: string, args: Record<string, unknown> = {}, threadId = 'multi') => client.callTool({ name, arguments: args, _meta: { threadId } });
    const read = <K extends keyof typeof definitions>(name: K, args: Record<string, unknown> = {}, threadId = 'multi') => callTool(client, { name, arguments: args, _meta: { threadId } });
    const opened = (await read('git_graph')).structuredContent;
    assert.equal(opened.repositories.length, 3, 'keep distinct runtime worktrees and omit non-Git folders');
    assert.equal(opened.repo, await realpath(second), 'task cwd selects the default repository');
    assert.deepEqual(opened.repositories.map(repo => repo.displayPath), [await realpath(first), await realpath(linked), await realpath(second)]);
    assert.ok(opened.repositories.every(repo => repo.path !== outside), 'ignore an unrelated process cwd');
    const selected = opened.repositories[2].id;
    const selectedArgs = { repository: selected, hash: heads[1] };
    assert.equal((await read('git_graph_history', { repository: selected })).structuredContent.head, heads[1]);
    assert.equal((await read('git_graph_commit', selectedArgs)).structuredContent.message, 'app');
    assert.equal((await read('git_graph_diff', { ...selectedArgs, path: 'file.txt' })).structuredContent.modified.content, 'app');
    assert.equal((await read('git_graph_workspace_file', { ...selectedArgs, path: 'file.txt' })).structuredContent.path, await realpath(join(second, 'file.txt')));
    assert.equal((await read('git_graph_history')).structuredContent.head, heads[1], 'default follows task cwd, not first repository or process cwd');
    const home = (await read('git_graph', {}, 'home')).structuredContent;
    assert.equal(home.repo, null);
    assert.equal(home.contextCwd, directory);
    assert.equal((await call('git_graph_history', {}, 'home')).isError, true, 'non-Git tasks cannot fall through to the process repository');
    assert.equal((await call('git_graph_history', {}, 'unopened')).isError, true);
    assert.equal((await read('git_graph', { selectedRepository: opened.repositories[1].id })).structuredContent.repo, await realpath(linked), 'refresh preserves a valid worktree selection');
    assert.equal((await read('git_graph', { selectedRepository: 'f'.repeat(64) })).structuredContent.repo, await realpath(second), 'stale selection returns to task cwd');
    const scope = { cwd: linked, runtimeRoots: [linked, second], sourceRoots: [first, second], worktrees: [], notices: [] };
    const resolved = await resolveRepositories(scope);
    assert.deepEqual(resolved.repositories.map(repo => repo.path), [await realpath(linked), await realpath(second)], 'source checkout maps to runtime worktree');
    const attached = await resolveRepositories({ ...scope, worktrees: [{ root: directory, workspaceRoot: first }] });
    assert.deepEqual(attached.repositories.map(repo => repo.path), [await realpath(linked), await realpath(second), await realpath(first)], 'attachment discovery uses workspaceRoot, not its container root');
    const projectless = await resolveRepositories({ ...scope, sourceRoots: [], runtimeRoots: [linked] });
    assert.equal(projectless.repositories[0].path, await realpath(linked));
    await mkdir(join(first, 'web')); await mkdir(join(first, 'app'));
    await mkdir(join(linked, 'web')); await mkdir(join(linked, 'app'));
    const subdirs = await resolveRepositories({ ...scope, cwd: join(linked, 'app'), runtimeRoots: [join(first, 'web'), join(linked, 'app')], sourceRoots: [join(first, 'web'), join(first, 'app')] });
    assert.deepEqual(subdirs.repositories.map(repo => repo.path), [await realpath(first), await realpath(linked)], 'repeated project subdirectories map to their runtime checkouts');
    assert.equal(subdirs.defaultRepository, subdirs.repositories[1].id);
    const duplicate = await resolveRepositories({ ...scope, cwd: first, runtimeRoots: [first, join(first, 'web')], sourceRoots: [first, join(first, 'app')] });
    assert.equal(duplicate.repositories.length, 1, 'same worktree is listed only once');
    await read('git_graph', {}, 'single');
    assert.equal((await call('git_graph_history', { repository: selected }, 'single')).isError, true);
    assert.equal((await call('git_graph_history', { repository: 'f'.repeat(64) })).isError, true);
    assert.equal((await call('git_graph_history', { repoPath: second })).isError, true);
    await writeFile(scopes, JSON.stringify({ ...workspace, cwd: first, runtimeRoots: [first] }));
    const changed = (await read('git_graph', { selectedRepository: selected })).structuredContent;
    assert.equal(changed.repo, await realpath(first)); assert.equal(changed.repositories.length, 1);
    assert.equal((await call('git_graph_history', { repository: selected })).isError, true, 'removed roots leave the allowlist on refresh');
    await writeFile(scopes, 'invalid context');
    assert.equal((await call('git_graph')).isError, true);
    assert.equal((await call('git_graph_history', { repository: changed.repositories[0].id })).isError, true, 'context failures invalidate stale repository access');
    await read('git_graph_layout');
    await read('git_graph_editor', { locale: 'en' });
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test('task workspace uses pending state, environments, cwd, project sources and paged attachments', async () => {
  const codexHome = '/codex-home', cwd = '/task/current';
  const selected = { 'selected-project': { type: 'local', projectId: 'desktop-project' },
    'app-server-project-id-by-legacy-project-id-by-host': { [`local:${codexHome}`]: { 'desktop-project': 'app-project' } } };
  let thread: unknown = { projectId: null, cwd: '/task/projectless', environments: null };
  let projectFails = false;
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const runWithCodex: WithCodex = run => run(async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/read') { if (thread instanceof Error) throw thread; return { thread }; }
    if (method === 'project/read') { if (projectFails) throw new Error('project unavailable'); return { project: { roots: [{ path: '/repo/web' }, { path: '/repo/app' }] } }; }
    if (method === 'thread/attachment/list') return params.cursor == null
      ? { data: [{ attachmentType: 'worktree', payload: { root: '/trees/container', workspaceRoot: '/trees/container/repo' } }, { attachmentType: 'worktree', payload: { invalid: true } }], nextCursor: 'page-2' }
      : { data: [], nextCursor: null };
    throw new Error(`unexpected method: ${method}`);
  });
  const options = { codexHome, cwd, readState: async () => selected, runWithCodex };
  const projectless = await readWorkspace('task', options);
  assert.equal(projectless.cwd, '/task/projectless');
  assert.deepEqual(projectless.runtimeRoots, ['/task/projectless']);
  assert.deepEqual(projectless.sourceRoots, [], 'selected project cannot override an existing projectless task');
  assert.deepEqual(projectless.worktrees, [{ root: '/trees/container', workspaceRoot: '/trees/container/repo' }]);
  assert.equal(requests.filter(item => item.method === 'thread/attachment/list').length, 2);
  thread = { projectId: 'assigned', cwd: '/source/main', environments: [{ cwd: '/runtime/worktree/app', runtimeWorkspaceRoots: ['/runtime/worktree/app', '/other'] }] };
  const environment = await readWorkspace('task', options);
  assert.equal(environment.cwd, '/runtime/worktree/app');
  assert.deepEqual(environment.runtimeRoots, ['/runtime/worktree/app', '/other']);
  assert.deepEqual(environment.sourceRoots, ['/repo/web', '/repo/app']);
  const applied = { cwd: '/applied', runtimeWorkspaceRoots: ['/applied'], projectSources: ['/source'] };
  const pending = { cwd: '/pending', runtimeWorkspaceRoots: ['/pending'], projectSources: ['/new-source'] };
  const state = { project: {}, applied, pending: pending as typeof pending | null };
  const readState = async () => ({ ...selected, 'electron-persisted-atom-state': { 'thread-workspace-state-v1:task': state } });
  const moved = await readWorkspace('task', { ...options, readState });
  assert.equal(moved.cwd, pending.cwd); assert.deepEqual(moved.sourceRoots, pending.projectSources);
  state.pending = null;
  const active = await readWorkspace('task', { ...options, readState });
  assert.equal(active.cwd, applied.cwd); assert.deepEqual(active.runtimeRoots, environment.runtimeRoots, 'live environments override applied runtime roots');
  thread = { projectId: 'assigned', cwd: '/old' };
  assert.equal((await readWorkspace('task', { ...options, readState })).cwd, applied.cwd);
  projectFails = true;
  const partial = await readWorkspace('task', { ...options, readState });
  assert.deepEqual(partial.runtimeRoots, applied.runtimeWorkspaceRoots);
  assert.match(format(joinMessages(partial.notices), 'en'), /project unavailable/); projectFails = false;
  thread = new Error('thread not loaded: fresh');
  assert.deepEqual((await readWorkspace('fresh', options)).sourceRoots, ['/repo/web', '/repo/app']);
  assert.equal((await readWorkspace(undefined, options)).cwd, '/repo/web');
  assert.deepEqual(await readWorkspace(undefined, { ...options, readState: async () => ({}), runWithCodex: async () => { throw new Error('must not start'); } }),
    { cwd, runtimeRoots: [cwd], sourceRoots: [], worktrees: [], notices: [] });
  thread = new Error('cannot read task');
  await assert.rejects(readWorkspace('task', options), /cannot read task/);
});

test('Codex appearance follows configuration changes, defaults and read failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'git-graph-font-'));
  const configPath = join(directory, 'config.toml');
  let desktop: { codeFontSize?: number; appearanceDarkChromeTheme?: { ink: string; contrast: number } } = {}, reads = 0;
  let failure: Error | null | undefined;
  const read = createAppearanceReader({ configPath, readConfig: async () => {
    reads++; if (failure) throw failure; return { config: { desktop } };
  } });
  const ghostHover = { light: 'rgba(26, 28, 31, 0.053)', dark: 'rgba(255, 255, 255, 0.078)' };
  try {
    const base = await read();
    assert.equal(base.codeFontSize, 12); assert.deepEqual(base.ghostHover, ghostHover);
    assert.equal(base.noticeColors.dark.primarySoft, 'rgba(45, 45, 45, 0.96)');
    assert.equal(base.noticeColors.dark.textTertiary, 'rgba(255, 255, 255, 0.498)');
    await read(); assert.equal(reads, 1, 'unchanged files do not launch another config reader');
    desktop = { codeFontSize: 18 }; await writeFile(configPath, 'changed');
    assert.deepEqual(await read(), { ...base, codeFontSize: 18, ghostHover });
    desktop = { codeFontSize: 24 }; await writeFile(configPath, 'another change');
    assert.deepEqual(await read(), { ...base, codeFontSize: 24, ghostHover });
    desktop = { codeFontSize: 100 }; await writeFile(configPath, 'invalid code size');
    await assert.rejects(read());
    failure = new Error('configuration unavailable'); await assert.rejects(read(), /configuration unavailable/);
    failure = null; desktop = { codeFontSize: 16 };
    assert.deepEqual(await read(), { ...base, codeFontSize: 16, ghostHover }, 'failed reads are not cached');
    desktop = { appearanceDarkChromeTheme: { ink: '#fcfcfc', contrast: 50 } }; await writeFile(configPath, 'custom theme');
    const customHover = (await read()).ghostHover.dark;
    assert.equal(customHover, 'rgba(252, 252, 252, 0.071)');
    const alpha = Number(customHover.split(', ').at(-1)!.slice(0, -1));
    assert.equal(Math.round(252 * alpha + 17 * (1 - alpha)), 34, 'native screenshot: hover over #111111 is #222222');
    desktop = {}; await rm(configPath);
    assert.deepEqual(await read(), base);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
