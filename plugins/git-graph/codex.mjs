import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export async function withCodex(run) {
  const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 0, failure;
  const fail = error => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Codex 服务已退出。')));
  child.stdin.on('error', fail);
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line), request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } catch (error) { fail(error); }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const timeout = setTimeout(() => { fail(new Error('读取 Codex 配置或项目超过 15 秒，请重试。')); child.kill(); }, 15000);
  try {
    await request('initialize', { clientInfo: { name: 'git-graph', version: '0.3.0' }, capabilities: { experimentalApi: true } });
    return await run(request);
  } finally {
    clearTimeout(timeout); lines.close(); child.kill();
  }
}

// Codex Desktop 26.915: desktop.codeFontSize defaults to 12 and accepts 8–24 px.
const codeFontSizeSchema = z.number().min(8).max(24).default(12);
export function createCodeFontSizeReader({
  configPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'),
  readConfig = () => withCodex(request => request('config/read', { includeLayers: false })),
} = {}) {
  let cached;
  return async () => {
    const stamp = await stat(configPath).then(file => `${file.mtimeMs}:${file.ctimeMs}:${file.size}`, error => {
      if (error.code === 'ENOENT') return 'missing';
      throw error;
    });
    if (cached?.stamp === stamp) return cached.value;
    const { config } = await readConfig();
    const value = { codeFontSize: codeFontSizeSchema.parse(config.desktop?.codeFontSize) };
    cached = { stamp, value };
    return value;
  };
}
