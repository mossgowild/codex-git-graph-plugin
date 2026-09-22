import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('installed plugin launcher falls back to Home without a selected project', { timeout: 10000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'git-graph-installed-')));
  const home = join(directory, 'home'), codexHome = join(directory, 'codex');
  const actualCodexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const { version } = JSON.parse(await readFile(new URL('.codex-plugin/plugin.json', import.meta.url)));
  const cache = join('plugins', 'cache', 'codex-git-graph', 'git-graph', version);
  const installed = await realpath(join(actualCodexHome, cache));
  const isolated = join(codexHome, cache);
  const { git_graph: config } = JSON.parse(await readFile(new URL('.mcp.json', import.meta.url))).mcpServers;
  const env = { CODEX_HOME: codexHome, HOME: home };
  try {
    await mkdir(home);
    await mkdir(dirname(isolated), { recursive: true });
    await cp(installed, isolated, { recursive: true });
    const client = new Client({ name: 'git-graph-installed-check', version: '1.0.0' });
    try {
      await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env, cwd: process.cwd() }));
      const result = await client.callTool({ name: 'git_graph', arguments: {} });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.equal(result.structuredContent.contextCwd, home);
      assert.equal(result.structuredContent.repo, null);
    } finally { await client.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
