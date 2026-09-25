import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { stat, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { promisify } from 'node:util';

export type CodexRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export type WithCodex = <T>(run: (request: CodexRequest) => Promise<T>) => Promise<T>;

export async function withCodex<T>(run: (request: CodexRequest) => Promise<T>): Promise<T> {
  // MCP servers are children of the task's app-server; use that executable when available.
  const parent = process.env.CODEX_CLI_PATH || process.platform === 'win32' ? '' : (await promisify(execFile)('ps', ['-p', String(process.ppid), '-o', 'comm='])).stdout.trim();
  const resources = process.env.CODEX_MCP_NODE_PATH?.match(/^(.*\.app\/Contents\/Resources)\//)?.[1];
  const executable = process.env.CODEX_CLI_PATH || (isAbsolute(parent) && basename(parent) === 'codex' ? parent : resources ? join(resources, 'codex') : 'codex');
  if (executable !== 'codex') await access(executable);
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
// Codex Desktop 26.917: fill the hover, Banner and EmptyState colors absent from MCP host tokens.
const chromeThemeSchema = z.object({ ink: z.string().regex(/^#[0-9a-f]{6}$/i).optional(), surface: z.string().regex(/^#[0-9a-f]{6}$/i).optional(), contrast: z.number().min(0).max(100).optional() });
function chromeColors(theme: z.infer<typeof chromeThemeSchema> | undefined, dark: boolean) {
  const baseline = dark ? 60 : 45, contrast = theme?.contrast ?? baseline;
  const adjusted = contrast / 100 + (contrast - baseline) / 60 * 0.7;
  const normalized = contrast <= baseline ? adjusted : baseline / 100 + (adjusted - baseline / 100) * 2;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const alpha = (value: number) => Number(clamp(value).toFixed(3));
  const ink = theme?.ink ?? (dark ? '#ffffff' : '#1a1c1f');
  const rgb = [1, 3, 5].map(offset => parseInt(ink.slice(offset, offset + 2), 16));
  const surface = theme?.surface ?? (dark ? '#181818' : '#ffffff');
  const mix = clamp(dark ? 0.06 + normalized * 0.05 : 0.09 + normalized * 0.04);
  const control = [1, 3, 5].map((offset, index) => { const channel = parseInt(surface.slice(offset, offset + 2), 16); return Math.round(channel + ((dark ? rgb[index] : 255) - channel) * mix); });
  return { ghostHover: `rgba(${rgb.join(', ')}, ${alpha((dark ? 0.06 : 0.04) + normalized * 0.03)})`,
    primarySoft: `rgba(${control.join(', ')}, 0.96)`,
    textTertiary: `rgba(${rgb.join(', ')}, ${alpha(dark ? 0.42 + normalized * 0.13 : 0.45 + normalized * 0.1)})` };
}
export function createAppearanceReader({
  configPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'),
  readConfig = () => withCodex(request => request('config/read', { includeLayers: false })),
}: { configPath?: string; readConfig?: () => Promise<unknown> } = {}) {
  let cached: { stamp: string; value: { codeFontSize: number; ghostHover: { light: string; dark: string }; noticeColors: { light: ReturnType<typeof chromeColors>; dark: ReturnType<typeof chromeColors> } } } | undefined;
  return async () => {
    const stamp = await stat(configPath).then(file => `${file.mtimeMs}:${file.ctimeMs}:${file.size}`, error => {
      if (error.code === 'ENOENT') return 'missing';
      throw error;
    });
    if (cached?.stamp === stamp) return cached.value;
    const { config } = z.object({ config: z.object({ desktop: z.object({ codeFontSize: z.unknown().optional(), appearanceDarkChromeTheme: chromeThemeSchema.optional(), appearanceLightChromeTheme: chromeThemeSchema.optional() }).nullish() }) }).parse(await readConfig());
    const noticeColors = { light: chromeColors(config.desktop?.appearanceLightChromeTheme, false), dark: chromeColors(config.desktop?.appearanceDarkChromeTheme, true) };
    const value = { noticeColors, codeFontSize: codeFontSizeSchema.parse(config.desktop?.codeFontSize),
      ghostHover: { light: noticeColors.light.ghostHover, dark: noticeColors.dark.ghostHover } };
    cached = { stamp, value };
    return value;
  };
}
