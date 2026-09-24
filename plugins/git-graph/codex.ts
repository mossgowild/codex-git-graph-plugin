import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export type CodexRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export type WithCodex = <T>(run: (request: CodexRequest) => Promise<T>) => Promise<T>;

export async function withCodex<T>(run: (request: CodexRequest) => Promise<T>): Promise<T> {
  const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  let nextId = 0;
  let failure: unknown;
  const fail = (error: unknown) => {
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
  const request: CodexRequest = (method, params) => new Promise<unknown>((resolve, reject) => {
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
// Codex Desktop 26.917: reproduce the missing host hover token from the saved chrome theme.
const chromeThemeSchema = z.object({ ink: z.string().regex(/^#[0-9a-f]{6}$/i).optional(), contrast: z.number().min(0).max(100).optional() });
function ghostHover(theme: z.infer<typeof chromeThemeSchema> | undefined, dark: boolean) {
  const baseline = dark ? 60 : 45, contrast = theme?.contrast ?? baseline;
  const adjusted = contrast / 100 + (contrast - baseline) / 60 * 0.7;
  const normalized = contrast <= baseline ? adjusted : baseline / 100 + (adjusted - baseline / 100) * 2;
  const alpha = Number(Math.min(1, Math.max(0, (dark ? 0.06 : 0.04) + normalized * 0.03)).toFixed(3));
  const ink = theme?.ink ?? (dark ? '#ffffff' : '#1a1c1f');
  const rgb = [1, 3, 5].map(offset => parseInt(ink.slice(offset, offset + 2), 16));
  return `rgba(${rgb.join(', ')}, ${alpha})`;
}
export function createAppearanceReader({
  configPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'),
  readConfig = () => withCodex(request => request('config/read', { includeLayers: false })),
}: { configPath?: string; readConfig?: () => Promise<unknown> } = {}) {
  let cached: { stamp: string; value: { codeFontSize: number; ghostHover: { light: string; dark: string } } } | undefined;
  return async () => {
    const stamp = await stat(configPath).then(file => `${file.mtimeMs}:${file.ctimeMs}:${file.size}`, error => {
      if (error.code === 'ENOENT') return 'missing';
      throw error;
    });
    if (cached?.stamp === stamp) return cached.value;
    const { config } = z.object({ config: z.object({ desktop: z.object({ codeFontSize: z.unknown().optional(), appearanceDarkChromeTheme: chromeThemeSchema.optional(), appearanceLightChromeTheme: chromeThemeSchema.optional() }).nullish() }) }).parse(await readConfig());
    const value = { codeFontSize: codeFontSizeSchema.parse(config.desktop?.codeFontSize),
      ghostHover: { light: ghostHover(config.desktop?.appearanceLightChromeTheme, false), dark: ghostHover(config.desktop?.appearanceDarkChromeTheme, true) } };
    cached = { stamp, value };
    return value;
  };
}
