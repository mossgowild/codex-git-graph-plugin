import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { git } from './git.ts';

test('MCP event waits preserve task and panel isolation and never query Git while idle', { timeout: 60000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'git-graph-watch-mcp-')));
  const first = join(directory, 'first'), second = join(directory, 'second'), bin = join(directory, 'bin');
  const runner = join(directory, 'server.mjs'), log = join(directory, 'git-calls.log');
  const client = new Client({ name: 'git-graph-watch-mcp-test', version: '1.0.0' });
  const watch = z.object({ watchId: z.uuid(), revision: z.number().int().nonnegative() });
  const change = watch.extend({ changed: z.boolean() });
  try {
    for (const repo of [first, second]) {
      await mkdir(repo); await git(repo, ['init', '-b', 'main']);
      await git(repo, ['config', 'user.name', 'Watcher Test']);
      await git(repo, ['config', 'user.email', 'watcher@example.invalid']);
      await writeFile(join(repo, 'file.txt'), 'initial\n');
      await git(repo, ['add', '--', 'file.txt']); await git(repo, ['commit', '-m', 'Initial']);
    }
    const binary = (await promisify(execFile)('/usr/bin/which', ['git'])).stdout.trim();
    await mkdir(bin); await writeFile(log, '');
    await writeFile(join(bin, 'git'), `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
fs.appendFileSync(process.env.GRAPH_WATCH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const result = cp.spawnSync(process.env.GRAPH_WATCH_GIT, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o755 });
    await writeFile(runner, `import { createServer } from ${JSON.stringify(new URL('./dist/server.mjs', import.meta.url).href)};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server/stdio'))};
const paths = ${JSON.stringify({ first, second })};
await createServer({ readContext: async id => ({ cwd: paths[id] || paths.first, runtimeRoots: [paths[id] || paths.first], sourceRoots: [], worktrees: [], notices: [] }) }).connect(new StdioServerTransport());`);
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [runner], cwd: first,
      env: { ...environment, PATH: `${bin}:${environment.PATH}`, GRAPH_WATCH_GIT: binary, GRAPH_WATCH_LOG: log } }));
    const call = (name: string, args: Record<string, unknown>, threadId = 'first') => client.callTool({ name, arguments: args, _meta: { threadId } });
    for (const thread of ['first', 'second']) assert.ok(!(await call('git_graph', {}, thread)).isError);
    const start = async (threadId = 'first') => {
      const result = await call('git_graph_watch_start', {}, threadId);
      assert.ok(!result.isError, JSON.stringify(result)); return watch.parse(result.structuredContent);
    };
    const one = await start(), two = await start();
    assert.notEqual(one.watchId, two.watchId);
    const forbidden = await call('git_graph_watch_wait', one, 'second');
    assert.equal(forbidden.isError, true, 'another task cannot use a watch token');
    assert.equal((await call('git_graph_watch_stop', { watchId: one.watchId }, 'second')).isError, true);

    const beforeIdle = await readFile(log, 'utf8');
    const idle = await call('git_graph_watch_wait', one);
    assert.ok(!idle.isError, JSON.stringify(idle));
    assert.deepEqual(change.parse(idle.structuredContent), { ...one, changed: false });
    assert.equal(await readFile(log, 'utf8'), beforeIdle, 'authorization and idle renewal do not invoke Git');
    const continued = call('git_graph_watch_wait', two);
    await writeFile(join(first, 'file.txt'), 'modified\n');
    const event = await continued;
    assert.ok(!event.isError, JSON.stringify(event));
    const updated = change.parse(event.structuredContent);
    assert.equal(updated.changed, true);
    assert.ok(updated.revision > two.revision, 'events after idle renewal remain observable');
    const snapshot = await call('git_graph_history', {});
    assert.ok(!snapshot.isError, JSON.stringify(snapshot));
    const history = z.record(z.string(), z.unknown()).parse(snapshot.structuredContent);
    assert.ok(history.currentRef, 'event-driven reads keep the real current reference');
    assert.equal('uncommitted' in history, false, 'dirty worktree has no synthetic history state');
    const working = await call('git_graph_worktree', {});
    assert.ok(!working.isError, JSON.stringify(working));
    assert.deepEqual(z.object({ files: z.array(z.object({ group: z.string(), status: z.string(), path: z.string() })) }).parse(working.structuredContent).files,
      [{ group: 'changes', status: 'M', path: 'file.txt' }], 'an M event updates the separate worktree state without changing refs');
    const difference = await call('git_graph_worktree_diff', { group: 'changes', path: 'file.txt' });
    assert.ok(!difference.isError, JSON.stringify(difference));
    assert.deepEqual(z.object({ original: z.object({ source: z.string(), content: z.string() }), modified: z.object({ source: z.string(), content: z.string() }) }).parse(difference.structuredContent),
      { original: { source: 'index', content: 'initial\n' }, modified: { source: 'worktree', content: 'modified\n' } });

    assert.ok(!(await call('git_graph_watch_stop', { watchId: one.watchId })).isError);
    assert.ok(!(await call('git_graph_watch_stop', { watchId: one.watchId })).isError, 'stopping an expired token is idempotent');
    const waiting = call('git_graph_watch_wait', { watchId: two.watchId, revision: updated.revision });
    await writeFile(join(first, 'file.txt'), 'modified again\n');
    const stillActive = await waiting;
    assert.ok(!stillActive.isError, JSON.stringify(stillActive));
    assert.equal(change.parse(stillActive.structuredContent).changed, true, 'closing one panel preserves the other listener');
    assert.ok(!(await call('git_graph_watch_stop', { watchId: two.watchId })).isError);
  } finally {
    await client.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('stdin EOF releases an active MCP wait while stdout remains open', { timeout: 10000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'git-graph-watch-eof-'))), runner = join(directory, 'server.mjs');
  try {
    await git(directory, ['init', '-b', 'main']);
    await writeFile(runner, `import { createServer } from ${JSON.stringify(new URL('./dist/server.mjs', import.meta.url).href)};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server/stdio'))};
await createServer({ readContext: async () => ({ cwd: process.cwd(), runtimeRoots: [process.cwd()], sourceRoots: [], worktrees: [], notices: [] }) }).connect(new StdioServerTransport());`);
    const child = spawn(process.execPath, [runner], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '', errors = '', id = 0;
    const requests = new Map<number, (result: { result?: { structuredContent?: unknown }; error?: unknown }) => void>();
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdout.on('data', chunk => {
      text += chunk;
      let end;
      while ((end = text.indexOf('\n')) !== -1) {
        const message = JSON.parse(text.slice(0, end)); text = text.slice(end + 1);
        if (typeof message.id === 'number') { requests.get(message.id)?.(message); requests.delete(message.id); }
      }
    });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    const request = (method: string, params: object) => new Promise<{ result?: { structuredContent?: unknown }; error?: unknown }>(resolve => {
      const requestId = ++id; requests.set(requestId, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
    try {
      const initialized = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'eof-test', version: '1.0.0' } });
      assert.ok(!initialized.error, JSON.stringify(initialized));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      assert.ok(!(await request('tools/call', { name: 'git_graph', arguments: {} })).error);
      const start = await request('tools/call', { name: 'git_graph_watch_start', arguments: {} });
      const started = z.object({ watchId: z.uuid(), revision: z.number().int() }).parse(start.result?.structuredContent);
      const waiting = request('tools/call', { name: 'git_graph_watch_wait', arguments: started });
      await new Promise(resolve => setTimeout(resolve, 100));
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const code = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('EOF left the event wait active')), 2000); })]);
        assert.equal(code, 0, errors);
      } finally { clearTimeout(timer); }
      void waiting;
    } finally { if (child.exitCode === null) { child.kill(); await exited; } }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
