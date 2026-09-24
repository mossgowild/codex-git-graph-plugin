import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rename, rm, copyFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, type CallToolRequest } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { git, history, commit, diff, repository, workspaceFile } from './git.ts';
import { createCodeFontSizeReader, type WithCodex } from './codex.ts';
import { layout, graphPaths, colors, type GraphCommit } from './graph.ts';
import { readProjectRoots } from './project.ts';
import type { definitions } from './server.ts';
import { z } from 'zod';

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
  const semantic = layout(commits, {refs, head:'B', headName:'main'}).rows;
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
await createServer({ projectRoots: async () => [] }).connect(new StdioServerTransport());`);
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
    await assert.rejects(workspaceFile({ repoPath: repo, hash: root, path: 'alpha.txt' }), /已没有/);
    await assert.rejects(workspaceFile({ repoPath: repo, hash: latest, path: '../outside' }), /不在/);
    await assert.rejects(diff({ repoPath: repo, hash: root, path: '../../etc/passwd' }), /不在/);
    await assert.rejects(commit({ repoPath: repo, hash: '--output=x' }), /无效/);
    await assert.rejects(commit({ repoPath: repo, hash: root, parent: 1 }), /无效/);
    await assert.rejects(repository('relative/path'), /绝对路径/);
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
      assert.deepEqual(Object.keys(schema.properties!).sort(), name === 'git_graph_commit' ? ['hash', 'parent', 'repository'] : ['hash', 'parent', 'path', 'repository']);
      assert.equal(schema.additionalProperties, false);
    }
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
    assert.equal((await callTool(client, { name: 'git_graph_commit', arguments: { hash: merge } })).structuredContent.parents.length, 2);
    assert.equal((await callTool(client, { name: 'git_graph_diff', arguments: { hash: root, path: 'alpha.txt' } })).structuredContent.modified.content, 'one\ntwo\nthree\n');
    assert.equal((await callTool(client, { name: 'git_graph_workspace_file', arguments: { hash: latest, path: strange } })).structuredContent.path, await realpath(join(repo, strange)));
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
    await assert.rejects(workspaceFile({ repoPath: repo, hash: latest, path: strange }), /仓库之外/);
    await rm(join(repo, strange)); await rename(join(repo, 'saved.txt'), join(repo, strange));
    await git(repo, ['worktree', 'add', '--detach', worktree, feature]);
    await linkedClient.connect(new StdioClientTransport({ command: process.execPath,
      args: [runner], cwd: worktree }));
    const linked = await callTool(linkedClient, { name: 'git_graph', arguments: {} });
    assert.equal(linked.structuredContent.repo, await repository(worktree));
    assert.equal(linked.structuredContent.repositories.length, 1);
    assert.equal(linked.structuredContent.repositories[0].displayPath, await repository(repo));
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
    const read = (path: string) => diff({ repoPath: repo, hash: target, path });
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
    assert.match((await read('binary.bin')).modified.reason!, /二进制/);
    assert.match((await read('invalid.txt')).modified.reason!, /UTF-8/);
    assert.match((await read('large.txt')).modified.reason!, /2 MiB/);
    const eol = await read('eol.txt');
    assert.equal(eol.original.content, '\uFEFFone\r\ntwo');
    assert.equal(eol.modified.content, 'one\ntwo');
    const link = await read('link');
    assert.equal(link.modified.mode, '120000');
    assert.equal(link.modified.content, '/outside/repository');
    await assert.rejects(read('../outside'), /不在/);
    await assert.rejects(read('eol.txt\0'), /不在/);
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
    const panels = { detailHeight: 380, filesWidth: 180, summaryHeight: 144, detailMaximized: true };
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
      { panels: {}, preferencesDirectory: directory }, { panels: {}, repoPath: directory }]) {
      assert.equal((await second.callTool({ name: 'git_graph_save_layout', arguments: args })).isError, true);
      assert.equal(await readFile(settings, 'utf8'), savedPanels);
    }
    assert.equal(await readFile(legacy, 'utf8'), '{broken legacy layout');
    await writeFile(settings, '{broken');
    const invalid = await second.callTool({ name: 'git_graph_layout', arguments: {} });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.content[0].type, 'text');
    assert.ok('text' in invalid.content[0]);
    assert.match(invalid.content[0].text, /读取面板布局失败/);
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
  const runner = join(directory, 'server.mjs');
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
    await writeFile(runner, `import { createServer } from ${JSON.stringify(new URL('./dist/server.mjs', import.meta.url).href)};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server/stdio'))};
await createServer({ projectRoots: async threadId => threadId === 'multi' ? ${JSON.stringify([first, linked, second, first, empty])} : threadId === 'home' ? [${JSON.stringify(directory)}] : [] }).connect(new StdioServerTransport());`);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [runner], cwd: outside }));
    const call = (name: string, args: Record<string, unknown> = {}, threadId = 'multi') => client.callTool({ name, arguments: args, _meta: { threadId } });
    const read = <K extends keyof typeof definitions>(name: K, args: Record<string, unknown> = {}, threadId = 'multi') => callTool(client, { name, arguments: args, _meta: { threadId } });
    const opened = (await read('git_graph')).structuredContent;
    assert.equal(opened.repositories.length, 2, 'use project roots, merge worktrees and omit non-Git folders');
    assert.deepEqual(opened.repositories.map(repo => repo.displayPath), [await realpath(first), await realpath(second)]);
    assert.ok(opened.repositories.every(repo => repo.path !== outside), 'ignore an unrelated process cwd');
    const selected = opened.repositories[1].id;
    const selectedArgs = { repository: selected, hash: heads[1] };
    assert.equal((await read('git_graph_history', { repository: selected })).structuredContent.head, heads[1]);
    assert.equal((await read('git_graph_commit', selectedArgs)).structuredContent.message, 'app');
    assert.equal((await read('git_graph_diff', { ...selectedArgs, path: 'file.txt' })).structuredContent.modified.content, 'app');
    assert.equal((await read('git_graph_workspace_file', { ...selectedArgs, path: 'file.txt' })).structuredContent.path, await realpath(join(second, 'file.txt')));
    assert.equal((await read('git_graph_history')).structuredContent.head, heads[0], 'selection never changes process cwd');
    const home = (await read('git_graph', {}, 'home')).structuredContent;
    assert.equal(home.repo, null);
    assert.equal(home.contextCwd, directory);
    await read('git_graph', {}, 'single');
    assert.equal((await call('git_graph_history', { repository: selected }, 'single')).isError, true);
    assert.equal((await call('git_graph_history', { repository: 'f'.repeat(64) })).isError, true);
    assert.equal((await call('git_graph_history', { repoPath: second })).isError, true);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test('project roots use the selected project before falling back to Home', async () => {
  const codexHome = '/codex-home', home = '/Users/tester';
  const selectedProject = 'desktop-project', mappedProject = 'app-server-project';
  const desktop = {
    'selected-project': { type: 'local', projectId: selectedProject },
    'app-server-project-id-by-legacy-project-id-by-host': {
      [`local:${codexHome}`]: { [selectedProject]: mappedProject },
    },
  };
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const runWithCodex: WithCodex = run => run(async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/read') throw new Error('thread not loaded: fresh');
    if (method === 'project/read') return { project: { roots: [{ path: '/repo/web' }, { path: '/repo/app' }] } };
    throw new Error(`unexpected method: ${method}`);
  });

  assert.deepEqual(await readProjectRoots('fresh', {
    codexHome, home, readState: async () => desktop, runWithCodex,
  }), ['/repo/web', '/repo/app']);
  assert.deepEqual(requests, [
    { method: 'thread/read', params: { threadId: 'fresh', includeTurns: false } },
    { method: 'project/read', params: { projectId: mappedProject } },
  ]);
  requests.length = 0;
  assert.deepEqual(await readProjectRoots(undefined, {
    codexHome, home, readState: async () => desktop, runWithCodex,
  }), ['/repo/web', '/repo/app']);
  assert.deepEqual(requests, [{ method: 'project/read', params: { projectId: mappedProject } }]);
  assert.deepEqual(await readProjectRoots(undefined, {
    codexHome, home, readState: async () => ({}),
    runWithCodex: async () => { throw new Error('app-server should not start'); },
  }), [home]);
});


test('Codex code size follows configuration changes, defaults and read failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'git-graph-font-'));
  const configPath = join(directory, 'config.toml');
  let desktop: { codeFontSize?: number } = {}, reads = 0;
  let failure: Error | null | undefined;
  const read = createCodeFontSizeReader({ configPath, readConfig: async () => {
    reads++; if (failure) throw failure; return { config: { desktop } };
  } });
  try {
    assert.deepEqual(await read(), { codeFontSize: 12 });
    await read(); assert.equal(reads, 1, 'unchanged files do not launch another config reader');
    desktop = { codeFontSize: 18 }; await writeFile(configPath, 'changed');
    assert.deepEqual(await read(), { codeFontSize: 18 });
    desktop = { codeFontSize: 24 }; await writeFile(configPath, 'another change');
    assert.deepEqual(await read(), { codeFontSize: 24 });
    desktop = { codeFontSize: 100 }; await writeFile(configPath, 'invalid code size');
    await assert.rejects(read());
    failure = new Error('configuration unavailable'); await assert.rejects(read(), /configuration unavailable/);
    failure = null; desktop = { codeFontSize: 16 };
    assert.deepEqual(await read(), { codeFontSize: 16 }, 'failed reads are not cached');
    desktop = {}; await rm(configPath);
    assert.deepEqual(await read(), { codeFontSize: 12 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
