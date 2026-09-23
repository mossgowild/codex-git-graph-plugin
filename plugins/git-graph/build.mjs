import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const worker = await build({ entryPoints: ['monaco-editor/editor/editor.worker.js'], bundle: true,
  minify: true, format: 'iife', platform: 'browser', write: false, supported: { 'template-literal': false } });
const ui = await build({ entryPoints: ['ui.mjs'], bundle: true, minify: true, format: 'iife', platform: 'browser', write: false,
  outfile: 'dist/ui.js', supported: { 'template-literal': false } });
const editor = await build({ entryPoints: ['diff-editor.mjs'], bundle: true, minify: true, format: 'iife', globalName: 'GitGraphEditor',
  platform: 'browser', write: false, outfile: 'dist/editor.js', supported: { 'template-literal': false },
  loader: { '.ttf': 'dataurl' }, define: { __DIFF_WORKER__: JSON.stringify(worker.outputFiles[0].text) } });
const html = (await readFile('window.html', 'utf8'))
  .replace('/* EDITOR_STYLE */', () => ui.outputFiles.find(file => file.path.endsWith('.css')).text.replaceAll('</style', '<\\/style'))
  .replace('/* APP_SCRIPT */', () => ui.outputFiles.find(file => file.path.endsWith('.js')).text.replaceAll('</script', '<\\/script'));
await writeFile('dist/window.html', html);
await writeFile('dist/editor.js', editor.outputFiles.find(file => file.path.endsWith('.js')).text);
await writeFile('dist/editor.css', editor.outputFiles.find(file => file.path.endsWith('.css')).text);
await build({ entryPoints: ['server.mjs'], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: 'dist/server.mjs', loader: { '.svg': 'dataurl' },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
const { version } = JSON.parse(await readFile('.codex-plugin/plugin.json', 'utf8'));
// ponytail: legacy MCP has no plugin-root expansion; replace this cache lookup when the host supports it without changing the task cwd.
const launch = `const { join } = require('node:path');
const root = process.env.CODEX_HOME || join(require('node:os').homedir(), '.codex');
process.argv[1] = join(root, 'plugins/cache/codex-git-graph/git-graph', ${JSON.stringify(version)}, 'dist/server.mjs');
import(require('node:url').pathToFileURL(process.argv[1]).href);`;
await writeFile('.mcp.json', JSON.stringify({ mcpServers: { git_graph: {
  command: 'node', args: ['-e', launch], env_vars: ['CODEX_HOME'],
} } }, null, 2) + '\n');
console.log('Built window UI and bundled MCP server.');
