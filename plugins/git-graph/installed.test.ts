import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';

async function checkLauncher(source: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'git-graph-launcher-')));
  const home = join(directory, 'home'), codexHome = join(directory, 'codex');
  const { version } = JSON.parse(await readFile(join(source, '.codex-plugin/plugin.json'), 'utf8'));
  const isolated = join(codexHome, 'plugins/cache/codex-git-graph/git-graph', version);
  const { git_graph: config } = JSON.parse(await readFile(join(source, '.mcp.json'), 'utf8')).mcpServers;
  const env = { CODEX_HOME: codexHome, HOME: home };
  try {
    await mkdir(home);
    await mkdir(isolated, { recursive: true });
    // Exercise the shipped bundle with no source files or node_modules in the cache.
    await cp(join(source, 'dist'), join(isolated, 'dist'), { recursive: true });
    const client = new Client({ name: 'git-graph-launcher-check', version: '1.0.0' });
    try {
      await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env, cwd: home }));
      const result = await client.callTool({ name: 'git_graph', arguments: {} });
      assert.ok(!result.isError, JSON.stringify(result));
      const opened = z.object({ contextCwd: z.string(), repo: z.null() }).parse(result.structuredContent);
      assert.equal(opened.contextCwd, home);
      const { tools } = await client.listTools();
      const metadata = z.object({ ui: z.object({ resourceUri: z.string() }) }).parse(tools.find(tool => tool.name === 'git_graph')?._meta);
      const content = (await client.readResource({ uri: metadata.ui.resourceUri })).contents[0];
      assert.ok('text' in content);
      assert.equal(content.text, await readFile(join(source, 'dist/window.html'), 'utf8'));
      const editor = await client.callTool({ name: 'git_graph_editor', arguments: {} });
      assert.ok(!editor.isError, JSON.stringify(editor));
      assert.deepEqual(editor.structuredContent, {
        script: await readFile(join(source, 'dist/editor.js'), 'utf8'),
        style: await readFile(join(source, 'dist/editor.css'), 'utf8'),
      });
    } finally { await client.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('built plugin launcher runs from an isolated cache without development dependencies', { timeout: 10000 }, async () => {
  await checkLauncher(import.meta.dirname);
});

test('installed plugin launcher falls back to Home without a selected project', { timeout: 10000 }, async () => {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const { version } = JSON.parse(await readFile(new URL('.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  await checkLauncher(await realpath(join(codexHome, 'plugins/cache/codex-git-graph/git-graph', version)));
});
