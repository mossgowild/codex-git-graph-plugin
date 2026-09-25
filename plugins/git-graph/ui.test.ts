import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { git } from './git.ts';
import type { Browser, Page, Locator, FrameLocator } from 'playwright';
import type { AddressInfo } from 'node:net';
import type { history } from './git.ts';
import type { GraphRef } from './graph.ts';
type FixtureCommit = Awaited<ReturnType<typeof history>>['commits'][number] & { message?: string };
type Fixture = Omit<Awaited<ReturnType<typeof history>>, 'offset' | 'missingBranch' | 'refs' | 'commits'> & { offset?: number; missingBranch?: string; refs: (GraphRef & { type?: string; symbolic?: string })[]; commits: FixtureCommit[] };
type Request = { name: string; arguments: Record<string, unknown> };
type Result = Awaited<ReturnType<Client['callTool']>>;
declare global {
  interface Window { light(): void; codeFont(values: Record<string, string>): void; }
  interface CSSStyleDeclaration { cornerShape: string; }
}

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright') as typeof import('playwright');
const root = import.meta.dirname;
const require = createRequire(`${root}/package.json`);
const { build } = require('esbuild');
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const temporary = await mkdtemp(join(tmpdir(), 'git-graph-ui-'));
const data = join(temporary, 'data');
const runner = join(temporary, 'server.mjs');
await writeFile(runner, `import { createServer } from ${JSON.stringify(pathToFileURL(`${root}/dist/server.mjs`).href)};
import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/server/stdio')).href)};
await createServer({preferencesDirectory:${JSON.stringify(data)},readContext:async()=>({cwd:process.cwd(),runtimeRoots:[process.cwd()],sourceRoots:[],worktrees:[],notices:[]})}).connect(new StdioServerTransport());`);
const client = new Client({ name: 'layout-ui-check', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [runner], cwd: root }));
let failSave = false, codeFontSize = 15;
let historyFixture: Fixture | undefined, historyClient: Client | undefined, intercept: ((request: Request) => Promise<Result | null | undefined | void>) | null;
let editorCalls = 0;
async function callTool(request: Request) {
  if (request.name === 'git_graph_editor') editorCalls++;
  if (intercept) { const result=await intercept(request); if (result) return result; }
  if (request.name === 'git_graph_appearance') return { content: [], structuredContent: { codeFontSize, noticeColors: { light: { primarySoft: 'rgba(255, 255, 255, 0.96)', textTertiary: 'rgba(26, 28, 31, 0.495)' }, dark: { primarySoft: 'rgba(33, 37, 42, 0.96)', textTertiary: 'rgba(230, 237, 243, 0.498)' } }, ghostHover: { light: "rgba(26, 28, 31, 0.053)", dark: "rgba(230, 237, 243, 0.078)" } } };
  if (historyClient) {
    if (request.name === 'git_graph') {
      const initial = await historyClient.callTool(request);
      const page = await historyClient.callTool({ name: 'git_graph_history', arguments: { limit: 2, branch: request.arguments?.branch, repository: request.arguments?.selectedRepository } });
      return { ...page, structuredContent: { ...initial.structuredContent as Record<string, unknown>, ...page.structuredContent as Record<string, unknown> } };
    }
    return historyClient.callTool(request.name === 'git_graph_history' ? { ...request, arguments: { ...request.arguments, limit: 2 } } : request);
  }
  const commit=historyFixture?.commits.find(commit=>commit.hash===request.arguments?.hash);
  if (historyFixture&&['git_graph','git_graph_history'].includes(request.name)) return {content:[],structuredContent:{...historyFixture,contextCwd:root,repositories:[{id:'a'.repeat(64),name:'fixture',path:root,displayPath:root}]}};
  if (commit&&request.name==='git_graph_commit') return {content:[],structuredContent:{...commit,message:commit.message??commit.subject,files:[],parent:0}};
  if (failSave&&request.name==='git_graph_save_layout') return {isError:true,content:[{type:'text',text:'模拟存储不可写'}]};
  return client.callTool(request);
}
const script = `import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
import {injectPreviewTheme,observePreviewTheme} from './preview-theme.ts';
const frame=document.querySelector('iframe')!;
const variables={'--color-background-primary':'#0d1117','--color-background-secondary':'#292d33','--color-background-tertiary':'#20242b','--color-text-primary':'#e6edf3','--color-text-secondary':'#7d838b','--color-text-disabled':'rgba(230,237,243,.498)','--color-border-primary':'#3a424d','--color-border-secondary':'#23282f','--color-ring-primary':'#76a7f3','--color-text-info':'#64a4e0','--color-text-success':'#3fb950','--color-text-danger':'#f85149','--font-sans':'system-ui','--font-mono':'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace','--font-text-lg-size':'16px','--font-weight-medium':'500','--color-background-danger':'#f85149','--font-text-md-size':'14px','--font-text-sm-size':'13px','--font-text-sm-line-height':'1.4285714286','--font-text-xs-size':'12px','--font-weight-normal':'430','--border-radius-xs':'4px','--border-radius-sm':'6px','--border-radius-md':'8px','--border-radius-lg':'10px','--border-radius-xl':'12px','--border-radius-full':'9999px','--shadow-lg':'0px 4px 8px -2px #0000001a','--color-background-disabled':'rgba(230,237,243,.09)','--color-background-info':'rgba(100,164,224,.15)'};
const bridge=new AppBridge(null,{name:'UI test host',version:'1.0.0'},{serverTools:{},...(location.search.includes('file-open')?{experimental:{'openai/files':{}}}:{})},{hostContext:{theme:'dark',styles:{variables},displayMode:'fullscreen',containerDimensions:{maxHeight:2000}}});
async function call(params){return(await fetch('/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params)})).json();}
bridge.oncalltool=call;
bridge.oninitialized=async()=>{await bridge.sendToolInput({arguments:{}});await bridge.sendToolResult(await call({name:'git_graph',arguments:{}}));};
let previewContext={theme:'dark',styles:{variables}};
injectPreviewTheme(previewContext);
window.codeFont=values=>{previewContext={...previewContext,styles:{variables:{...previewContext.styles.variables,...values}}};injectPreviewTheme(previewContext);};
window.light=()=>{previewContext={theme:'light',styles:{variables:{...variables,'--color-background-primary':'#ffffff','--color-background-secondary':'#f5f5f5','--color-background-tertiary':'#eeeeee','--color-text-primary':'#202020','--color-text-secondary':'#777777','--color-border-primary':'#c9c9c9','--color-border-secondary':'#dddddd'}}};injectPreviewTheme(previewContext);};
await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));
observePreviewTheme(context=>bridge.sendHostContextChange(context),missing=>{throw new Error('Missing preview theme: '+missing.join(','));});frame.src='/frame.html';`;
const built = await build({ stdin: { contents: script, resolveDir: root, sourcefile: 'host.ts', loader: 'ts' }, bundle:true,format:'esm',write:false });
const server = createServer(async (req,res)=>{
  try {
    if(req.url==='/call') {
      let text='';for await(const part of req)text+=part;
      const request=JSON.parse(text);
      const result=await callTool(request);
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
    }
    if(req.url==='/host.js'){res.setHeader('Content-Type','text/javascript');res.end(built.outputFiles[0].text);return;}
    if(req.url==='/frame.html'){res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; worker-src blob:; connect-src blob: data:");res.end(await readFile(`${root}/dist/window.html`));return;}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><style>html,body{margin:0;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style><iframe sandbox="allow-scripts"></iframe><script type="module" src="/host.js"></script></html>');
  }catch(e){res.writeHead(500).end(e instanceof Error ? e.message : String(e));}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser: Browser | undefined;
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM});
  const context=await browser.newContext({viewport:{width:1000,height:760}});
  context.setDefaultTimeout(10000);
  let page=await context.newPage();
  const errors: string[]=[], workers: string[]=[];
  const observe = (page: Page) => {
    page.on('pageerror',e=>{ errors.push(e.message); console.error(e); });
    page.on('console',message=>{if (message.type()==='error' || /Could not create web worker/.test(message.text())) errors.push(message.text());});
    page.on('worker',worker=>workers.push(worker.url()));
  };
  observe(page);
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open=async()=>{
    await page.goto(url);
    const f=page.frameLocator('iframe');
    await f.locator('.commit-row').first().waitFor();
    await f.locator('#expand-detail:not([disabled])').waitFor({state:'attached'});return f;
  };
  let releaseInitial!: () => void;
  const initialHeld = new Promise<void>(resolve => { releaseInitial = resolve; });
  intercept = async request => { if (request.name === 'git_graph') await initialHeld; };
  await page.goto(url);
  const initialFrame = page.frameLocator('iframe');
  await initialFrame.locator('#history-skeleton').waitFor({state:'visible'});
  assert.equal(await initialFrame.locator('#toolbar-skeleton').isVisible(),true,'initial toolbar uses a skeleton');
  assert.equal(await initialFrame.locator('#empty').isVisible(),false,'loading text and empty state stay hidden');
  assert.equal(editorCalls,0,'initial loading does not request the diff editor');
  releaseInitial();
  await initialFrame.locator('.commit-row').first().waitFor();
  assert.equal(await initialFrame.locator('#history-skeleton').isVisible(),false,'skeleton clears on first result');
  assert.equal(editorCalls,0,'history remains usable before loading Monaco');
  let failEditor = true;
  intercept = async request => request.name === 'git_graph_editor' && failEditor
    ? { isError:true, content:[{type:'text',text:'模拟编辑器加载失败'}] } : null;
  await initialFrame.locator('.commit-row').first().click();
  await initialFrame.locator('#diff-error').getByText('模拟编辑器加载失败').waitFor();
  assert.equal(await initialFrame.locator('#diff-skeleton').isVisible(),false,'editor failure clears the diff skeleton');
  failEditor = false;
  await initialFrame.locator('#diff-error-retry').click();
  await initialFrame.locator('#diff-editor').waitFor({state:'visible'});
  assert.equal(editorCalls,2,'editor loading retries only after the first diff fails');
  assert.equal(await initialFrame.locator('#diff-skeleton').isVisible(),false,'diff skeleton clears after editor setup');
  intercept = async request => request.name === 'git_graph' ? { isError:true, content:[{type:'text',text:'模拟首次加载失败'}] } : null;
  await page.goto(url);
  const failedFrame = page.frameLocator('iframe');
  await failedFrame.locator('#history-error').getByText('模拟首次加载失败').waitFor();
  assert.equal(await failedFrame.locator('#history-skeleton').isVisible(),false,'initial failure clears the skeleton');
  assert.equal(await failedFrame.locator('#history-error').getAttribute('role'),'alert');
  assert.equal(await failedFrame.locator('#history-error').evaluate(el=>el.getBoundingClientRect().left>0),true,'notice is inset from the panel edge');
  const banner = await failedFrame.locator('#history-error').evaluate(el => {
    const style = getComputedStyle(el), icon = el.querySelector('.notice-icon svg')!.getBoundingClientRect();
    return { padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft], radius: style.borderRadius, curve: style.cornerShape, messageLineHeight: getComputedStyle(el.querySelector('.notice-message')!).lineHeight, icon: [icon.width, icon.height], shadow: style.boxShadow, border: style.borderWidth, below: el.getBoundingClientRect().top >= document.getElementById('header')!.getBoundingClientRect().bottom };
  });
  assert.deepEqual(banner.padding, ['16px','12px','16px','20px']); assert.equal(banner.radius, '20px');
  assert.equal(banner.curve, 'superellipse(1.5)'); assert.equal(banner.messageLineHeight, '21.125px');
  const retryStyle = await failedFrame.locator('#history-error-retry').evaluate(el => { const s=getComputedStyle(el); return { height:el.getBoundingClientRect().height, border:s.borderWidth, radius:s.borderRadius, curve:s.cornerShape }; });
  assert.deepEqual(retryStyle, {height:24, border:'1px', radius:'9999px', curve:'superellipse(1)'});
  assert.deepEqual(banner.icon, [18,18]); assert.equal(banner.border, '0px'); assert.ok(banner.shadow.includes('0.5px')); assert.ok(banner.below);
  await page.setViewportSize({width:400,height:760});
  assert.equal(await failedFrame.locator('#history-error .notice-content').evaluate(el => getComputedStyle(el).flexDirection), 'column');
  assert.equal(await failedFrame.locator('#app').evaluate(el=>el.scrollWidth <= el.clientWidth), true);
  await page.setViewportSize({width:1000,height:760});
  intercept = null;
  let frame=await open();
  // Feedback stays with the operation that failed, and unrelated regions remain usable.
  intercept = async request => ['git_graph', 'git_graph_commit', 'git_graph_appearance'].includes(request.name)
    ? { isError: true, content: [{ type: 'text', text: `模拟失败 ${request.name}` }] } : null;
  await frame.locator('#refresh').click();
  await frame.locator('#history-error').getByText('模拟失败 git_graph').waitFor();
  await frame.locator('.commit-row').first().click();
  await frame.locator('#detail-error').getByText('模拟失败 git_graph_commit').waitFor();
  await frame.locator('#font-error').getByText('模拟失败 git_graph_appearance', { exact: false }).waitFor();
  assert.equal(await frame.locator('#summary-pane #detail-error').isVisible(), true);
  assert.equal(await frame.locator('#history-error').isVisible(), true, 'detail failure does not erase history failure');
  assert.equal(await frame.locator('#summary-pane').getAttribute('aria-busy'), 'false');
  intercept = null;
  await frame.locator('#font-error-retry').click();
  await frame.locator('#font-error').waitFor({ state: 'hidden' });
  await frame.locator('#detail-error-retry').click();
  await frame.locator('#diff-editor').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#history-error').isVisible(), true, 'detail recovery keeps the independent history error');
  await frame.locator('#history-error-retry').click();
  await frame.locator('#history-error').waitFor({ state: 'hidden' });
  await frame.locator('#diff-status').getByText('处差异', { exact: false }).waitFor();
  await page.goto(url + '?file-open');
  await frame.locator('.commit-row').first().click();
  await frame.locator('#diff-editor').waitFor({ state: 'visible' });
  intercept = async request => request.name === 'git_graph_workspace_file'
    ? { isError: true, content: [{ type: 'text', text: '模拟打开文件失败' }] } : null;
  await frame.locator('#open-file').click();
  await frame.locator('#changes-pane #file-error').getByText('模拟打开文件失败').waitFor();
  assert.equal(await frame.locator('#diff-editor').isVisible(), true, 'open-file failure preserves readable diff');
  assert.equal(await frame.locator('#diff-error').isVisible(), false);
  intercept = async request => request.name === 'git_graph' ? { content: [], structuredContent: { repo: null, contextCwd: '/preview/non-git', repositories: [] } } : null;
  await page.goto(url);
  await frame.locator('#empty').getByText('当前目录不属于 Git 仓库').waitFor();
  assert.equal(await frame.locator('#history-error').isVisible(), false, 'non-Git directory is an empty state');
  const emptyMetrics = await frame.locator('#empty').evaluate(el => {
    const icon = el.querySelector('svg')!, content = el.querySelector('.empty-content')!, copy = el.querySelector('.empty-copy')!, title = el.querySelector('strong')!;
    const a = el.getBoundingClientRect(), b = content.getBoundingClientRect();
    return { icon: icon.getBoundingClientRect().height, gap: getComputedStyle(content).gap, copyGap: getComputedStyle(copy).gap, size: getComputedStyle(title).fontSize, weight: getComputedStyle(title).fontWeight, centered: Math.abs((a.top+a.bottom-b.top-b.bottom)/2)<1 };
  });
  assert.deepEqual(emptyMetrics, { icon:72, gap:'12px', copyGap:'8px', size:'16px', weight:'500', centered:true });
  assert.equal(await frame.locator('#empty .empty-copy > span').evaluate(el => {
    const canvas=document.createElement('canvas'), context=canvas.getContext('2d')!;
    context.fillStyle=getComputedStyle(el).color; context.fillRect(0,0,1,1); return context.getImageData(0,0,1,1).data[3];
  }), 166, 'empty descriptions use native secondary text at 65%, not the MCP description color');
  const initialData = (await client.callTool({ name: 'git_graph', arguments: {} })).structuredContent as Record<string, unknown>;
  intercept = async request => request.name === 'git_graph' ? { content: [], structuredContent: { ...initialData, commits: [], refs: [], head: '', tips: [], hasMore: false } } : null;
  await page.goto(url);
  await frame.locator('#empty').getByText('这个仓库还没有提交').waitFor();
  assert.equal(await frame.locator('#history-error').isVisible(), false, 'empty repository is not a query error');
  intercept = null;
  frame = await open();
  console.log(JSON.stringify({ passed: true, checks: ['scoped concurrent notices', 'font error recovery', 'local detail retry', 'open-file failure preserves diff', 'non-Git and empty repository states'] }));
  const scrollbarStyles=()=>frame.locator('#history-scroll, #detail-summary, #files, #diff-notice').evaluateAll(elements=>elements.map(element=>{
    const style=getComputedStyle(element);return {width:style.scrollbarWidth,color:style.scrollbarColor};
  }));
  assert.deepEqual(await scrollbarStyles(),Array(4).fill({width:'thin',color:'rgb(35, 40, 47) rgba(0, 0, 0, 0)'}),
    'plugin scroll areas use the Codex thin scrollbar and secondary border color');
  assert.deepEqual(await frame.locator('#branch').evaluate(element=>{
    const style=getComputedStyle(element,'::picker(select)');return {width:style.scrollbarWidth,color:style.scrollbarColor};
  }),{width:'thin',color:'rgb(35, 40, 47) rgba(0, 0, 0, 0)'},'select menus share the Codex scrollbar');
  await frame.locator('#history-scroll').hover();
  assert.equal((await scrollbarStyles())[0].color,'rgb(58, 66, 77) rgba(0, 0, 0, 0)',
    'hovered scroll areas use the host primary border color');
  assert.equal(await frame.locator('.commit-row[aria-pressed]').count(),0,'commit disclosure buttons do not expose checkbox semantics');
  assert.equal(await frame.locator('#searchbar').isVisible(),false,'search starts hidden');
  assert.equal(await frame.locator('#searchbar').evaluate(el=>el.parentElement?.id),'header','search expands the shared header');
  assert.equal(await frame.locator('#header').evaluate(el=>getComputedStyle(el).borderBottomWidth),'1px','header divider remains visible when search is closed');
  assert.deepEqual(await frame.locator('#header').evaluate(el => {
    const style = getComputedStyle(el); return [style.borderTopWidth, style.borderRightWidth, style.borderLeftWidth];
  }), ['0px', '0px', '0px'], 'the header has only a bottom divider without relying on a global CSS reset');
  assert.equal(await frame.locator('#searchbar').evaluate(el=>getComputedStyle(el).borderBottomWidth),'0px','search does not own the header divider');
  assert.equal(await frame.locator('#toggle-search').getAttribute('aria-expanded'),'false');
  await frame.locator('#toggle-search').click();
  assert.equal(await frame.locator('#header').evaluate(el=>getComputedStyle(el).borderBottomWidth),'1px','opening search only increases header height');
  const headerControlEdges=await frame.locator('#app').evaluate(()=>{
    const refresh=document.getElementById('refresh')!.getBoundingClientRect();
    const next=document.getElementById('next-match')!.getBoundingClientRect();
    return [refresh.right,next.right];
  });
  assert.equal(headerControlEdges[0],headerControlEdges[1],'toolbar and search controls share the same right edge');
  assert.deepEqual(await frame.locator('#search-field').evaluate(el => { const s=getComputedStyle(el); return {height:el.getBoundingClientRect().height,radius:s.borderRadius,border:s.borderWidth,size:s.fontSize,lineHeight:s.lineHeight}; }), {height:28,radius:'10px',border:'1px',size:'14px',lineHeight:'18px'}, 'search follows the native review file filter');
  await frame.locator('#search').fill('main');
  assert.equal(await frame.locator('#search').evaluate(el=>el===document.activeElement),true);
  await frame.locator('#refresh').click();
  await frame.locator('#history-pane[aria-busy=false]').waitFor();
  assert.equal(await frame.locator('#searchbar').isVisible(),true,'refresh preserves the search toggle');
  await frame.locator('#toggle-search').click();
  assert.equal(await frame.locator('#searchbar').isVisible(),false);
  assert.equal(await frame.locator('.is-match').count(),0,'hidden search does not highlight rows');
  await frame.locator('#toggle-search').press(process.platform==='darwin'?'Meta+f':'Control+f');
  assert.equal(await frame.locator('#search').inputValue(),'main','toggle preserves the query');
  assert.equal(await frame.locator('#search').evaluate(el=>el===document.activeElement),true);
  await frame.locator('#search').press('Escape');
  assert.equal(await frame.locator('#toggle-search').getAttribute('aria-expanded'),'false');
  assert.equal(await frame.locator('#toggle-search').evaluate(el=>el===document.activeElement),true);

  assert.equal(await frame.locator('#repo-label').count(),0,'repositories always use the shared select component');
  assert.equal(await frame.locator('#repository').isVisible(),true);
  assert.equal(await frame.locator('#repository').isDisabled(),true,'a single repository cannot open the picker');
  assert.equal(await frame.locator('#repository option').count(),1);
  const selectAppearance = (selector: string) => frame.locator(selector).evaluate(el => {
    const icon = el.querySelector<HTMLElement>('.codex-select-icon')!, selected = el.querySelector('selectedcontent')!;
    const probe = document.createElement('span'); probe.style.color = 'var(--muted)'; document.body.append(probe);
    const iconBounds = icon?.getBoundingClientRect(), selectedStyle = getComputedStyle(selected), pickerStyle = getComputedStyle(el,'::picker-icon');
    const result = { icon: icon?.dataset.codexIcon || '', width: iconBounds?.width || 0, height: iconBounds?.height || 0,
      iconColor: icon ? getComputedStyle(icon).backgroundColor : '', muted: getComputedStyle(probe).color,
      weight: selectedStyle.fontWeight, normalWeight: getComputedStyle(document.documentElement).fontWeight,
      selectedBackground: selectedStyle.backgroundColor, opacity: getComputedStyle(el).opacity,
      triggerBackground: getComputedStyle(el).backgroundColor, radius: getComputedStyle(el).borderRadius,
      cornerShape: getComputedStyle(el).cornerShape,
      pickerDisplay: pickerStyle.display, pickerWidth: pickerStyle.width, pickerHeight: pickerStyle.height };
    probe.remove(); return result;
  });
  await page.mouse.move(500,700);
  const singleRepositoryAppearance = await selectAppearance('#repository');
  assert.deepEqual([singleRepositoryAppearance.icon,singleRepositoryAppearance.width,singleRepositoryAppearance.height],['folder-light-16',16,16]);
  assert.equal(singleRepositoryAppearance.opacity,'1','disabled selects retain the normal component appearance');
  assert.equal(singleRepositoryAppearance.pickerDisplay,'none','disabled selects do not advertise a picker');
  const branchAppearance = await selectAppearance('#branch');
  assert.deepEqual([branchAppearance.icon,branchAppearance.width,branchAppearance.height],['branch-light-16',16,16]);
  assert.deepEqual([branchAppearance.pickerWidth,branchAppearance.pickerHeight],['12px','12px'],'enabled selects keep the picker icon');
  assert.equal(branchAppearance.iconColor,branchAppearance.muted,'branch icon follows the host secondary text color');
  assert.equal(branchAppearance.weight,branchAppearance.normalWeight,'selected branch keeps the host normal weight');
  assert.equal(branchAppearance.weight,'430');
  assert.deepEqual([branchAppearance.selectedBackground,branchAppearance.triggerBackground],['rgba(0, 0, 0, 0)','rgba(0, 0, 0, 0)']);
  const codexRows = async () => {
    assert.equal(await frame.locator('#columns, .column-resize').count(), 0);
    assert.equal(await frame.locator('footer, .history-footer, #history-status, .readonly').count(), 0,'no bottom status bar or labels remain');
    assert.equal(await frame.locator('#load-more').evaluate(el=>el.parentElement!.id),'history-scroll','pagination belongs to the scrollable history');
    assert.equal(await frame.locator('#history-pane').evaluate(el=>el.getBoundingClientRect().bottom===document.getElementById('app')!.getBoundingClientRect().bottom),true,'history fills the freed bottom space');
    const rows = await frame.locator('.commit-row').evaluateAll(rows => rows.map(row => ({
      height: row.getBoundingClientRect().height, width: row.getBoundingClientRect().width,
      contents: [...row.children].map(child => ['graph', 'message', 'author'].find(name => child.classList.contains(name))),
    })));
    assert.ok(rows.every(row => row.height === 30));
    assert.ok(rows.every(row => row.contents.join('|') === 'graph|message|author'));
    assert.equal(await frame.locator('.commit-row').evaluateAll(rows=>rows.every(row=>{
      const graph=row.querySelector<SVGSVGElement>('.graph')!.getBoundingClientRect(), message=row.querySelector('.message')!;
      return graph.left===8 && message.children[0].classList.contains('badges') && message.children[1].classList.contains('subject');
    })),true,'graph stays at the left edge and badges lead the commit message');
    assert.equal(await frame.locator('.step').evaluateAll(elements=>elements.every(element=>{
      const style=getComputedStyle(element);return style.width==='28px'&&style.height==='28px';
    })),true,'plugin icon buttons share the Codex 28px action surface');
    assert.equal(await frame.locator('.step svg').evaluateAll(elements=>elements.every(element=>{
      const style=getComputedStyle(element);return style.width==='16px'&&style.height==='16px';
    })),true,'plugin action icons share the Codex 16px size');
    assert.equal(await frame.locator('.commit-row').first().evaluate(el=>
      getComputedStyle(el,'::before').borderRadius===getComputedStyle(document.documentElement).getPropertyValue('--border-radius-md').trim()
    ),true,'commit hover surfaces use the Codex list-item radius');
    assert.equal(await frame.locator('#history-scroll').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  };
  if (!process.argv.includes('--projects-only')) {
  await codexRows();
  const historySurfaceGaps=await frame.locator('#history-scroll').evaluate(scroll=>{
    const rows=[...scroll.querySelectorAll('.commit-row')];
    const bounds=rows.map(row=>row.getBoundingClientRect());
    const adjacent=bounds.slice(1).map((current,index)=>[bounds[index],current])
      .find(([previous,current])=>Math.abs(current.top-previous.bottom)<.1)!;
    const container=document.getElementById('rows')!.getBoundingClientRect(),style=getComputedStyle(scroll);
    const first=bounds[0],last=bounds.at(-1)!;
    return {
      top:first.top+2-(container.top-parseFloat(style.paddingBlockStart)),
      between:adjacent[1].top+2-(adjacent[0].bottom-2),
      bottom:container.bottom+parseFloat(style.paddingBlockEnd)-(last.bottom-2),
    };
  });
  assert.deepEqual(historySurfaceGaps,{top:4,between:4,bottom:4},'history surfaces use the same visual gap at both edges and between rows');
  const searchCommits: FixtureCommit[]=[
    {hash:'a1'+'a'.repeat(38),parents:[],subject:'Fix [UI] & <img> Fix',author:'Alice',email:'alice@example.invalid',date:'2026-09-20T00:00:00Z'},
    {hash:'b2'+'b'.repeat(38),parents:[],subject:'Other change',message:'Other change\\n\\nFormatted body',author:'Fix',email:'hidden@example.invalid',date:'2026-09-20T00:00:00Z'},
  ];
  searchCommits[0].parents = [searchCommits[1].hash];
  historyFixture={repo:root,branch:'refs/heads/feature/fix',head:searchCommits[0].hash,headName:'feature/fix',hasMore:false,
    tips:[searchCommits[0].hash],commits:searchCommits,
    refs:[{name:'refs/heads/feature/fix',hash:searchCommits[0].hash,type:'commit',symbolic:''}]};
  frame=await open();
  assert.equal(await frame.locator('#branch').isDisabled(),true);
  assert.deepEqual(await frame.locator('#branch option').allTextContents(),['feature/fix']);
  assert.equal(await frame.locator('#branch').inputValue(),'refs/heads/feature/fix');
  await frame.locator('#toggle-search').click();await frame.locator('#search').fill('fix');
  assert.equal(await frame.locator('.commit-row mark[data-search-match]').count(),4,'literal matches in titles, badges and authors');
  assert.equal(await frame.locator('mark[data-active]').count(),1,'only one active occurrence');
  assert.equal(await frame.locator('#search-count').innerText(),'1/4 · 已加载历史');
  const markColors=()=>frame.locator('mark').evaluateAll(els=>els.map(el=>{
    const canvas=document.createElement('canvas'),context=canvas.getContext('2d')!;
    context.fillStyle=getComputedStyle(el).backgroundColor;context.fillRect(0,0,1,1);
    return {active:el.hasAttribute('data-active'),pixel:[...context.getImageData(0,0,1,1).data],radius:getComputedStyle(el).borderRadius};
  }));
  const accentMarks=async (color: number[])=>{
    let marks;
    for (let attempt=0;attempt<50;attempt++) {
      marks=await markColors();
      if (marks.every(mark=>mark.pixel.slice(0,3).every((channel,index)=>Math.abs(channel-color[index])<=3)
        && mark.pixel[3]===(mark.active?82:51) && mark.radius==='2px')) return;
      await page.waitForTimeout(20);
    }
    assert.fail(JSON.stringify(marks));
  };
  await accentMarks([118,167,243]);
  assert.equal(await frame.locator('.subject').first().evaluate(el=>getComputedStyle(el).color), 'rgb(230, 237, 243)','titles keep their normal color');
  await frame.locator('#search').press('Enter');await frame.locator('#commit-message').getByText('Fix [UI] & <img> Fix',{exact:true}).waitFor();
  const selected=await frame.locator('.commit-row[data-selected]').getAttribute('data-hash');
  await frame.locator('#search').press('Enter');
  assert.equal(await frame.locator('#detail').isVisible(),true,'next occurrence in the same commit keeps details open');
  assert.equal(await frame.locator('.commit-row[data-selected]').getAttribute('data-hash'),selected);
  assert.equal(await frame.locator('#search-count').innerText(),'3/4 · 已加载历史');
  await frame.locator('#search').press('Shift+Enter');assert.equal(await frame.locator('#search-count').innerText(),'2/4 · 已加载历史');
  await page.evaluate(()=>window.light());
  await frame.locator('html[data-theme="light"]').waitFor();
  assert.equal((await scrollbarStyles())[0].color,'rgb(221, 221, 221) rgba(0, 0, 0, 0)','scrollbars follow a light host theme');
  await accentMarks([118,167,243]);
  await page.evaluate(()=>window.codeFont({'--color-ring-primary':'#ba55d3'}));
  await accentMarks([186,85,211]);
  for (const query of ['[UI]','<img>','&']) {
    await frame.locator('#search').fill(query);
    assert.deepEqual(await frame.locator('.subject mark').allTextContents(),[query]);
    assert.equal(await frame.locator('.subject img').count(),0,'search and commit text are never HTML');
  }
  await frame.locator('#search').fill('hidden@');
  assert.equal(await frame.locator('.subject mark').count(),0);
  assert.equal(await frame.locator('.search-context mark').innerText(),'hidden@');
  await frame.locator('#search').fill('a1');assert.equal(await frame.locator('.search-context mark').innerText(),'a1');
  await frame.locator('#search').fill('not-present');assert.equal(await frame.locator('mark').count(),0);
  assert.equal(await frame.locator('#search-count').innerText(),'0/0 · 已加载历史');
  await frame.locator('#search').fill('fix');await frame.locator('#toggle-search').click();
  assert.equal(await frame.locator('mark, .search-context').count(),0,'closing search restores unmarked text');
  await frame.locator(`[data-hash="${searchCommits[1].hash}"]`).click();
  await frame.locator('#commit-message').filter({hasText:'Formatted body'}).waitFor();
  assert.equal(await frame.locator('#commit-message').textContent(),'Other change\n\nFormatted body','escaped newlines render as paragraphs');
  const detailSpacing=await frame.locator('#detail').evaluate(detail=>{
    const header=detail.querySelector('#detail-header')!,identity=detail.querySelector('#detail-identity')!;
    return {headerTop:header.getBoundingClientRect().top-detail.getBoundingClientRect().top,
      centerOffset:Math.abs((identity.getBoundingClientRect().top+identity.getBoundingClientRect().height/2)
        -(header.getBoundingClientRect().top+header.getBoundingClientRect().height/2)),
      headerHeight:header.getBoundingClientRect().height};
  });
  assert.deepEqual([detailSpacing.headerTop,detailSpacing.headerHeight],[4,28],'detail content uses the card inset without stacked top padding');
  assert.ok(detailSpacing.centerOffset<.1,'detail identity stays centered in the toolbar');
  const metaTops=await frame.locator('#commit-meta span').evaluateAll(elements=>elements.map(element=>element.getBoundingClientRect().top));
  assert.equal(metaTops.length,2);assert.ok(Math.abs(metaTops[0]-metaTops[1])<1,'author and commit time share one line');
  console.log(JSON.stringify({passed:true,checks:['theme accent text matches','single active occurrence','literal text safety','hidden metadata context','same-commit navigation','dark/light search colors','search cleanup']}));
  const branchNames=['codex/web-formily-before-dev-20260918','codex/web-formily-schema'];
  const commits=branchNames.map((name,index)=>({hash:String(index+1).repeat(40),parents:[],author:'Graph Test',
    email:'graph@example.invalid',date:'2026-09-19T00:00:00Z',subject:'refactor: align project structure with current conventions'}));
  historyFixture={repo:root,branch:'',missingBranch:'',head:commits[1].hash,headName:branchNames[1],hasMore:false,tips:commits.map(commit=>commit.hash),commits,
    refs:branchNames.map((name,index)=>({name:`refs/heads/${name}`,hash:commits[index].hash,type:'commit',symbolic:''}))};
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'column-widths.json'), '{broken legacy layout');
  frame=await open();
  for (const width of [1000,400]) {
    await page.setViewportSize({width,height:760});
    assert.deepEqual(await frame.locator('#rows .ref-name').allTextContents(),branchNames);
    const labels=await frame.locator('#rows .ref-name').evaluateAll(elements=>elements.map(label=>({
      name:label.textContent,visible:label.clientWidth,content:label.scrollWidth,
      insideMessage:label.getBoundingClientRect().right<=label.parentElement!.getBoundingClientRect().right,
    })));
    assert.ok(labels.every(label=>label.visible>0&&label.insideMessage),
      `branch names must remain distinguishable at ${width}px: ${JSON.stringify(labels)}`);
    await codexRows();
  }
  for (const [index,commit] of commits.entries()) {
    await frame.locator(`[data-hash="${commit.hash}"]`).click();
    await frame.locator('#commit-message').getByText(commit.subject,{exact:true}).waitFor();
    assert.equal(await frame.locator('#detail-hash').textContent(),commit.hash.slice(0,12));
    assert.deepEqual(await frame.locator('#commit-refs .ref').allTextContents(),[branchNames[index]]);
    assert.equal(await frame.locator('#commit-refs .ref').getAttribute('title'),`refs/heads/${branchNames[index]}`);
    assert.equal(await frame.locator('#detail-header #commit-refs .ref').count(),1);
    assert.equal(await frame.locator('#commit-refs').innerText(),branchNames[index]);
    assert.equal(await frame.locator('#commit-refs').evaluate(element=>element.scrollWidth<=element.clientWidth),true);
  }
  // Keyboard selection and refreshed refs must update the same detail display.
  await frame.locator(`[data-hash="${commits[1].hash}"]`).press('ArrowUp');
  await frame.locator('#commit-refs').getByText(branchNames[0],{exact:true}).waitFor();
  historyFixture.refs.push({name:`refs/remotes/origin/${branchNames[0]}`,hash:commits[0].hash},
    {name:'refs/tags/v1.0.0',hash:commits[0].hash});
  await frame.locator('#refresh').click();
  await frame.locator('#commit-refs').getByText('v1.0.0', { exact: true }).waitFor();
  assert.deepEqual(await frame.locator('#commit-refs .ref').allTextContents(),[branchNames[0],`origin/${branchNames[0]}`,'v1.0.0']);
  historyFixture.refs.push({name:'refs/heads/alias',hash:commits[0].hash},{name:'refs/heads/alias2',hash:commits[0].hash});
  await frame.locator('#refresh').click();
  await frame.locator('.commit-row .ref-name').getByText('alias2',{exact:true}).waitFor();
  const groupedRow=frame.locator(`[data-hash="${commits[0].hash}"]`);
  assert.equal(await groupedRow.locator('.badges .ref').count(),5);
  assert.equal(await groupedRow.locator('.badges .ref-name').count(),5);
  assert.equal(await groupedRow.locator('.ref-count').count(),0);
  await page.setViewportSize({width:1000,height:760});
  const badgeWidths=await groupedRow.locator('.ref').evaluateAll(els=>els.map(el=>({name:el.textContent,width:el.getBoundingClientRect().width,
    grow:getComputedStyle(el).flexGrow,basis:getComputedStyle(el).flexBasis})));
  assert.ok(badgeWidths.every(badge=>badge.grow==='0'&&badge.basis==='auto'),'badges size from their content without filling equal-width slots');
  assert.ok(badgeWidths.find(badge=>badge.name==='alias')!.width<badgeWidths[0].width,'short names must not occupy the same width as long branch names');
  await page.setViewportSize({width:400,height:760});
  await codexRows();
  assert.equal(await groupedRow.locator('.message > .badges:first-child').count(),1,'named badges precede the subject, after the graph');
  assert.equal(await frame.locator('.current .graph circle').count(),2,'HEAD has a distinct hollow node');
  const headRow=frame.locator('.commit-row.current');
  const nodeFills=()=>headRow.locator('.graph circle').evaluateAll(els=>els.map(el=>({fill:getComputedStyle(el).fill,stroke:getComputedStyle(el).stroke})));
  await page.mouse.move(0,0);
  assert.notEqual((await nodeFills())[0].fill,(await nodeFills())[1].fill,'HEAD is hollow at rest');
  await headRow.hover();
  const hovered=await nodeFills();
  assert.equal(hovered[0].stroke,'rgba(0, 0, 0, 0)','hover removes the outer circle cutout');
  assert.notEqual(hovered[1].fill,await headRow.evaluate(el=>getComputedStyle(el,'::before').backgroundColor),'HEAD overlay preserves alpha instead of using the opaque row surface');
  assert.equal(hovered[1].stroke,hovered[1].fill,'unselected hover center and inner stroke share the translucent overlay');
  const nodePixels=(row: Locator)=>row.evaluate(async row=>{
    const original=row.querySelector<SVGSVGElement>('.graph')!, svg=original.cloneNode(true) as SVGSVGElement, circles=original.querySelectorAll('circle');
    [...svg.children].forEach((shape,index)=>{
      const style=getComputedStyle(original.children[index]);
      for (const key of ['fill','stroke','strokeWidth','strokeLinecap'] as const) (shape as SVGElement).style[key]=style[key];
    });
    const canvas=document.createElement('canvas');canvas.width=original.width.baseVal.value;canvas.height=original.height.baseVal.value;
    const painter=canvas.getContext('2d',{willReadFrequently:true})!;
    painter.fillStyle=getComputedStyle(row,'::before').backgroundColor;painter.fillRect(0,0,canvas.width,canvas.height);
    const background=[...painter.getImageData(0,0,1,1).data].slice(0,3);
    const image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(svg));
    await image.decode();painter.drawImage(image,0,0);
    const center=[...painter.getImageData(Number(circles[0].getAttribute('cx')),Number(circles[0].getAttribute('cy')),1,1).data].slice(0,3);
    painter.fillStyle=getComputedStyle(circles[0]).fill;painter.fillRect(0,0,1,1);
    const node=[...painter.getImageData(0,0,1,1).data].slice(0,3);
    return {center,background,node};
  });
  const looksFilled=async (row: Locator)=>{
    const {center,background,node}=await nodePixels(row);
    const distance=(color: number[])=>color.reduce((sum,value,index)=>sum+(value-center[index])**2,0);
    assert.ok(distance(node)<distance(background),'hovered center must reveal the node color, as in the VS Code default theme');
  };
  await looksFilled(headRow);
  await page.mouse.move(0,0);
  assert.notEqual((await nodeFills())[0].fill,(await nodeFills())[1].fill,'leaving hover keeps HEAD identity');
  const restingHead=await nodePixels(headRow);assert.deepEqual(restingHead.center,restingHead.background,'resting HEAD has an opaque hollow center');
  await page.evaluate(()=>window.codeFont({'--border-radius-xs':'2px','--border-radius-sm':'3px','--border-radius-md':'4px','--border-radius-lg':'5px','--border-radius-xl':'6px'}));
  assert.equal(await frame.locator('#detail').evaluate(el=>getComputedStyle(el).borderRadius),'8px','card derives Codex 2xl from host radius tokens');
  const toolbarButton=await frame.locator('#refresh').evaluate(el=>{
    const bounds=el.getBoundingClientRect(),style=getComputedStyle(el);
    return {width:bounds.width,height:bounds.height,radius:style.borderRadius,cornerShape:style.cornerShape};
  });
  assert.deepEqual(toolbarButton,{width:28,height:28,radius:'5px',cornerShape:'superellipse(1.5)'},
    'toolbar buttons use the full 28px Codex interaction surface');
  const buttonInteraction=await frame.locator('#next-change').evaluate(el=>{
    const style=getComputedStyle(el);
    return {opacity:style.opacity,pointerEvents:style.pointerEvents,transition:style.transitionProperty};
  });
  assert.deepEqual(buttonInteraction,{opacity:'0.4',pointerEvents:'none',transition:'background-color, color, opacity'},
    'disabled icon buttons dim the complete Codex button');
  assert.ok((await frame.locator('#refresh').evaluate(el=>getComputedStyle(el).transitionProperty)).includes('color'));
  assert.ok((await frame.locator('#branch').evaluate(el=>getComputedStyle(el).transitionProperty)).includes('background-color'));
  await frame.locator('#toggle-search').focus();await page.keyboard.press('Tab');
  assert.deepEqual(await frame.locator('#refresh').evaluate(el=>{const style=getComputedStyle(el);return {
    active:document.activeElement===el,focusVisible:el.matches(':focus-visible'),outline:[style.outlineStyle,style.outlineWidth]};
  }),{active:true,focusVisible:true,outline:['solid','2px']},'keyboard focus uses the full Codex button ring');
  const refreshBounds=(await frame.locator('#refresh').boundingBox())!;
  await page.mouse.move(refreshBounds.x+refreshBounds.width/2,refreshBounds.y+refreshBounds.height/2);await page.mouse.down();await page.waitForTimeout(180);
  assert.equal(await frame.locator('#refresh').evaluate(el=>getComputedStyle(el).transform),'none','pressed icon buttons do not scale');
  await page.mouse.up();
  assert.equal(await frame.locator('#branch').evaluate(el=>getComputedStyle(el).borderRadius),'5px','select triggers use the Codex action radius');
  assert.equal(await frame.locator('#detail').evaluate(el=>getComputedStyle(el).cornerShape),'superellipse(1.5)');
  assert.equal(await frame.locator('#search-field').evaluate(el=>getComputedStyle(el).cornerShape),'superellipse(1.5)');
  let badgeRadius;
  for (let attempt=0;attempt<50;attempt++) {
    badgeRadius=await groupedRow.locator('.ref').first().evaluate(el=>getComputedStyle(el).borderRadius);
    if (badgeRadius==='3px') break;
    await page.waitForTimeout(20);
  }
  assert.equal(badgeRadius,'3px');
  assert.equal(await groupedRow.locator('.ref').first().evaluate(el=>getComputedStyle(el).cornerShape),'superellipse(1.5)');
  const backgrounds = () => frame.locator('#app, #detail').evaluateAll(elements => elements.map(el => getComputedStyle(el).backgroundColor));
  const beforeThemeUpdate = await backgrounds();
  await page.evaluate(() => window.codeFont({'--font-sans':'Georgia, serif','--font-text-xs-size':'14px','--color-background-secondary':'#345678'}));
  await frame.locator('#branch').evaluate(async el => {
    const deadline = Date.now() + 2000;
    while (!getComputedStyle(el).fontFamily.includes('Georgia')) {
      if (Date.now() > deadline) throw new Error('Host UI font did not update');
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  });
  assert.equal(await frame.locator('#detail-hash').evaluate(el => getComputedStyle(el).fontSize), '14px', 'existing UI text follows host typography updates');
  const afterThemeUpdate = await backgrounds();
  assert.equal(afterThemeUpdate[0], beforeThemeUpdate[0], 'secondary surface changes preserve the main background');
  assert.notEqual(afterThemeUpdate[1], beforeThemeUpdate[1], 'the detail surface resolves its local background after host updates');
  await page.evaluate(() => window.codeFont({'--font-sans':'system-ui','--font-text-xs-size':'12px','--color-background-secondary':'#292d33'}));
  await page.evaluate(()=>window.codeFont({'--border-radius-xs':'4px','--border-radius-sm':'6px','--border-radius-md':'8px','--border-radius-lg':'10px','--border-radius-xl':'12px'}));
  await frame.locator('#refresh').hover();
  await frame.locator('#refresh').evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished));
  });
  assert.equal(await frame.locator('.commit-row[data-selected]').evaluate(el => getComputedStyle(el, '::before').backgroundColor),
    'rgb(25, 29, 34)', 'dark selection uses the native white 5% overlay independently of host ink and disabled colors');
  const darkHover = await frame.locator('#refresh').evaluate(el => getComputedStyle(el).backgroundColor);
  assert.match(darkHover, /^rgba\(230, 237, 243, /);
  assert.ok(Math.abs(Number(darkHover.split(', ').at(-1)!.slice(0, -1)) - 0.078) < 1 / 255,
    'toolbar consumes the dark hover token within browser alpha quantization');
  const badge=groupedRow.locator('.ref').first();
  const darkBadge=await badge.evaluate(el=>getComputedStyle(el).backgroundColor);
  const box=(await groupedRow.boundingBox())!;await page.mouse.move(box.x+20,box.y+11);
  assert.equal(await badge.evaluate(el=>getComputedStyle(el).backgroundColor),darkBadge,'hover does not change badge fill');
  await page.evaluate(()=>window.light());
  assert.notEqual(await badge.evaluate(el=>getComputedStyle(el).backgroundColor),darkBadge,'badge follows the host surface');
  await frame.locator('#refresh').hover();
  await frame.locator('#refresh').evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished));
  });
  assert.equal(await frame.locator('.commit-row[data-selected]').evaluate(el => getComputedStyle(el, '::before').backgroundColor),
    'rgb(238, 238, 238)', 'light selection follows the host tertiary surface after a theme change');
  const lightHover = await frame.locator('#refresh').evaluate(el => getComputedStyle(el).backgroundColor);
  assert.match(lightHover, /^rgba\(26, 28, 31, /);
  assert.ok(Math.abs(Number(lightHover.split(', ').at(-1)!.slice(0, -1)) - 0.053) < 1 / 255,
    'host theme changes select the light hover token within browser alpha quantization');
  await codexRows();
  await headRow.hover();await looksFilled(headRow);
  await page.mouse.move(0,0);
  historyFixture.refs=historyFixture.refs.filter(ref=>ref.hash!==commits[0].hash);
  historyFixture.head=commits[0].hash;historyFixture.headName='';
  await frame.locator('#refresh').click();
  await frame.locator('#commit-refs').waitFor({state:'hidden'});
  assert.equal(await frame.locator('#commit-refs .ref').count(),0,'unreferenced commits must not inherit the checkout branch');
  // Disconnected roots must not inherit or highlight a neighbouring lineage.
  const relationships: [string, string[]][] = [['a',['c']],['b',['e']],['c',[]],['d',[]],['e',[]],['f',['8','9']],['8',[]],['9',[]]];
  historyFixture.commits=relationships.map(([id,parents])=>({...commits[0],hash:id.repeat(40),parents:parents.map(id=>id.repeat(40)),subject:`Node ${id}`}));
  historyFixture.head='a'.repeat(40);historyFixture.refs=[];
  frame=await open();
  const graphRow=(id: string)=>frame.locator(`.commit-row[data-hash="${id.repeat(40)}"]`);
  const strokes=(row: Locator)=>row.locator('.graph circle').evaluateAll(els=>els.map(el=>getComputedStyle(el).stroke));
  assert.deepEqual(await graphRow('a').locator('circle').evaluateAll(els=>els.map(el=>[el.getAttribute('r'),el.getAttribute('stroke-width')])),[['7','2'],['2','4']]);
  assert.deepEqual(await graphRow('f').locator('circle').evaluateAll(els=>els.map(el=>[el.getAttribute('r'),el.getAttribute('stroke-width')])),[['6','2'],['3','2']]);
  assert.deepEqual(await graphRow('c').locator('circle').evaluateAll(els=>els.map(el=>[el.getAttribute('r'),el.getAttribute('stroke-width')])),[['5','2']]);
  assert.equal(await frame.locator('.graph').evaluateAll(graphs=>graphs.every(svg=>{
    const shapes=[...svg.children],firstCircle=shapes.findIndex(el=>el.tagName==='circle');
    return shapes.slice(0,firstCircle).every(el=>el.tagName==='path')&&shapes.slice(firstCircle).every(el=>el.tagName==='circle');
  })),true,'draw connections first, then circles to mask connections at the node');
  await page.evaluate(()=>window.codeFont({'--color-text-secondary':'rgba(252,252,252,.498)'}));
  const grayPaint=()=>graphRow('9').evaluate(row=>({
    node:getComputedStyle(row.querySelector('circle')!).fill,
    line:getComputedStyle(row.querySelector('path')!).stroke,
    clip:getComputedStyle(row.querySelector('svg')!).overflow,
  }));
  const darkGray=await grayPaint();
  assert.equal(darkGray.node,darkGray.line,'node and edge use the same flattened host color');
  assert.match(darkGray.node,/^rgb\(/,'translucent host text colors must not expose edges through nodes');
  assert.equal(darkGray.clip,'hidden','round caps must not overlap the next row');
  assert.equal(darkGray.node,'rgb(132, 134, 137)','flatten against the dark host surface');
  await page.evaluate(()=>window.light());
  await page.evaluate(()=>window.codeFont({'--color-text-secondary':'rgba(0,0,0,.5)'}));
  assert.equal((await grayPaint()).node,'rgb(127, 127, 127)','recompute graph paint after a host theme change');
  const rootColors=await graphRow('c').evaluate(row=>({node:getComputedStyle(row.querySelector('circle')!).fill,
    incoming:getComputedStyle(row.querySelector('.node-edge')!).stroke,passing:getComputedStyle(row.querySelector('path')!).stroke}));
  assert.equal(rootColors.node,rootColors.incoming);assert.notEqual(rootColors.node,rootColors.passing);
  await graphRow('d').click();
  await frame.locator('#commit-message').getByText('Node d',{exact:true}).waitFor();
  assert.equal(await graphRow('d').locator('.node-edge').count(),0,'isolated node owns no edge');
  assert.deepEqual(await graphRow('d').locator('path').evaluateAll(els=>els.map(el=>getComputedStyle(el).strokeWidth)),['1px']);
  assert.deepEqual(await frame.locator('#detail-graph path').evaluateAll(els=>els.map(el=>getComputedStyle(el).strokeWidth)),['1px']);
  assert.equal(await frame.locator('#detail-graph svg').evaluate(el=>getComputedStyle(el).overflow),'hidden');
  await graphRow('c').click();
  await frame.locator('#commit-message').getByText('Node c',{exact:true}).waitFor();
  assert.deepEqual(await graphRow('c').locator('path').evaluateAll(els=>els.map(el=>getComputedStyle(el).strokeWidth)),['1px','3px']);
  assert.deepEqual(await frame.locator('#detail-graph path').evaluateAll(els=>els.map(el=>getComputedStyle(el).strokeWidth)),['1px']);
  await graphRow('f').click();
  await frame.locator('#commit-message').getByText('Node f',{exact:true}).waitFor();
  assert.deepEqual(await frame.locator('#detail-graph path').evaluateAll(els=>els.map(el=>getComputedStyle(el).strokeWidth)),['3px','1px']);
  await page.mouse.move(0,0);
  const selectedStroke=await graphRow('f').evaluate(el=>getComputedStyle(el,'::before').backgroundColor);
  const activeStroke=(await strokes(graphRow('f')))[1];
  assert.equal(activeStroke,selectedStroke,'light selection uses the opaque native surface for both active and inactive nodes');
  assert.deepEqual(await strokes(graphRow('f')),['rgba(0, 0, 0, 0)',activeStroke]);
  await frame.locator('#toggle-search').press(process.platform==='darwin'?'Meta+f':'Control+f');
  assert.deepEqual(await strokes(graphRow('f')),['rgba(0, 0, 0, 0)',selectedStroke],'logical row focus persists when entering controls');
  await graphRow('e').focus();
  const background=await frame.locator('html').evaluate(el=>getComputedStyle(el).backgroundColor);
  assert.deepEqual(await strokes(graphRow('f')),[background,activeStroke],'selected node without logical focus keeps its outer cutout');
  await frame.locator('#toggle-search').press(process.platform==='darwin'?'Meta+f':'Control+f');
  assert.deepEqual(await strokes(graphRow('f')),[background,background],'inactive selection without logical focus uses the base cutout');
  await graphRow('f').hover();
  const hoverStroke=(await strokes(graphRow('f')))[1];
  assert.notEqual(hoverStroke,background,'merge inner separator follows hover');
  await looksFilled(graphRow('f'));
  await graphRow('a').hover();await looksFilled(graphRow('a'));
  await graphRow('f').hover();
  assert.equal((await strokes(graphRow('f')))[0],'rgba(0, 0, 0, 0)');
  if (process.argv.includes('--graph-only')) {
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({passed:true,checks:['30px rows and named inline badges','responsive row bounds','reference identities','detail references','HEAD references refresh','opaque host graph colors and clipped row seams','node and edge ownership','SVG circle geometry and paint order','hover, focus and selection cutouts']}));
    process.exitCode=0;
  } else {
  // Exercise history transitions against a real, isolated repository via the bundled MCP server.
  {
    const repo=join(temporary,'repo');
    await mkdir(repo);await git(repo,['init','-b','main']);
    for (const [key,value] of [['user.name','Graph Test'],['user.email','graph@example.invalid'],['commit.gpgsign','false'],['core.hooksPath','/dev/null']]) await git(repo,['config',key,value]);
    const save=async(name: string,contents: string,message: string)=>{
      await writeFile(join(repo,name),contents);await git(repo,['add','--',name]);await git(repo,['commit','-m',message]);
      return (await git(repo,['rev-parse','HEAD'])).trim();
    };
    await writeFile(join(repo,'extra.txt'),'extra\n');await git(repo,['add','extra.txt']);
    const base=await save('base.txt','root\n--old\n-- old header lookalike\n','Root');
    await git(repo,['checkout','-b','side']);
    const side=await save('side.txt','side\n','Side');
    await git(repo,['checkout','main']);
    const main=await save('base.txt','root\n++new\n++ new header lookalike\n','Main\n\n'+'Long commit description with enough content to require scrolling.\n'.repeat(30));
    await git(repo,['merge','--no-ff','side','-m','Merge side']);
    const merge=(await git(repo,['rev-parse','HEAD'])).trim();
    await git(repo,['checkout','-b','topic',base]);
    await save('topic.txt','one\n','Topic 1');
    await save('topic.txt','two\n','Topic 2');
    const topic=await save('topic.txt','three\n','Topic 3');
    await git(repo,['checkout','main']);
    await git(repo,['branch','release',main]);await git(repo,['tag','release',side]);
    await git(repo,['branch','origin/main',main]);await git(repo,['update-ref','refs/remotes/origin/main',side]);
    historyFixture=undefined;
    historyClient=new Client({name:'history-ui-check',version:'1.0.0'});
    await historyClient.connect(new StdioClientTransport({command:process.execPath,args:[runner],cwd:repo}));
    await page.setViewportSize({width:1000,height:850});
    const reopen=async()=>{intercept=null;frame=await open();};
    const settled=()=>frame.locator('#history-pane[aria-busy="false"]').waitFor();
    const selectMain=async()=>{await frame.locator('#branch').selectOption('refs/heads/main');await settled();};
    const loadAllMain=async()=>{await selectMain();await frame.locator('#load-more').click();await frame.locator('.commit-row').nth(3).waitFor();};

    // A failed filter restores the loaded filter, while retry keeps the requested filter.
    await reopen();await selectMain();
    const oldRows=await frame.locator('.commit-row').evaluateAll(rows=>rows.map(row=>row.dataset.hash));
    intercept=async request=>request.name==='git_graph_history'&&request.arguments.branch==='refs/heads/topic'
      ?{isError:true,content:[{type:'text',text:'模拟读取失败'}]}:null;
    await frame.locator('#branch').selectOption('refs/heads/topic');await frame.locator('#history-error').waitFor({state:'visible'});
    assert.equal(await frame.locator('#branch').inputValue(),'refs/heads/main');
    assert.deepEqual(await frame.locator('.commit-row').evaluateAll(rows=>rows.map(row=>row.dataset.hash)),oldRows);
    intercept=null;await frame.locator('#history-error-retry').click();await frame.locator(`[data-hash="${topic}"]`).waitFor();
    assert.equal(await frame.locator('#branch').inputValue(),'refs/heads/topic');
    await selectMain();
    intercept=async request=>request.name==='git_graph_history'&&request.arguments.branch==='refs/heads/topic'
      ?{isError:true,content:[{type:'text',text:'模拟读取失败'}]}:null;
    await frame.locator('#branch').selectOption('refs/heads/topic');await frame.locator('#history-error').waitFor({state:'visible'});
    await frame.locator('#load-more').click();await frame.locator('.commit-row').nth(3).waitFor();
    assert.equal(await frame.locator('#branch').inputValue(),'refs/heads/main');
    assert.equal(await frame.locator(`[data-hash="${topic}"]`).count(),0);

    // Refresh retains both the selected merge parent and a non-first selected file.
    await reopen();await loadAllMain();
    await frame.locator(`[data-hash="${merge}"]`).click();
    await frame.locator('#parent-label:not([hidden])').waitFor();
    const selectStyles=await frame.locator('select').evaluateAll(elements=>elements.map(el=>{
      const style=getComputedStyle(el);
      return {component:el.classList.contains('codex-select'),label:!!el.querySelector('selectedcontent')!,
        padding:style.padding,gap:style.gap,radius:style.borderRadius,color:style.color,font:style.font};
    }));
    assert.equal(selectStyles.length,3);
    assert.equal(selectStyles.every(style=>style.component&&style.label),true);
    assert.deepEqual(selectStyles[1],selectStyles[0]);assert.deepEqual(selectStyles[2],selectStyles[0]);
    assert.equal(await frame.locator('#parent .codex-select-icon').count(),0,'parent selection has no repository or branch purpose icon');
    await frame.locator('#parent').selectOption('1');
    await frame.locator('#files-label').getByText('相对父提交 2',{exact:false}).waitFor();
    await frame.locator('#refresh').click();await settled();
    await frame.locator('#commit-meta').getByText('Graph Test',{exact:false}).waitFor();
    assert.equal(await frame.locator('#parent').inputValue(),'1');
    assert.equal(await frame.locator('#diff-title').innerText(),'base.txt');
    await frame.locator('#load-more').click();await frame.locator(`[data-hash="${base}"]`).click();
    await frame.locator('#files button[data-path="extra.txt"]').click();
    const shortSummary=await frame.locator('#detail-summary').evaluate(el=>({height:el.parentElement!.getBoundingClientRect().height,content:el.scrollHeight,viewport:el.clientHeight}));
    assert.ok(shortSummary.height<160);assert.equal(shortSummary.content,shortSummary.viewport,'short commit information fits naturally');
    // Filter to the root to keep this selection in the refreshed first page.
    await git(repo,['branch','root-only',base]);
    await frame.locator('#refresh').click();await settled();
    await frame.locator('#branch').selectOption('refs/heads/root-only');await settled();
    await frame.locator(`[data-hash="${base}"]`).click();await frame.locator('#files button[data-path="extra.txt"]').click();
    await frame.locator('#refresh').click();await settled();
    await frame.locator('#diff-status').getByText('1 处差异',{exact:true}).waitFor();
    assert.equal(await frame.locator('#files button[aria-selected="true"]').getAttribute('data-path'),'extra.txt');
    assert.equal(await frame.locator('#files').getAttribute('role'),'listbox');
    assert.equal(await frame.locator('#files button[role="option"][aria-pressed]').count(),0,'file options do not expose checkbox semantics');
    assert.equal(await frame.locator('#files button[role="option"][tabindex="0"]').count(),1,'file list keeps one keyboard target');
    const closeButton=frame.locator('#close-detail');
    const closeBounds=(await closeButton.boundingBox())!;
    assert.equal(closeBounds.width,28);assert.equal(closeBounds.height,28);
    assert.equal(await closeButton.locator('svg').count(),1);
    const detailAlignment=await frame.locator('#detail').evaluate(detail=>{
      const right=detail.getBoundingClientRect().right;
      return {
        close:right-document.getElementById('close-detail')!.getBoundingClientRect().right,next:right-document.getElementById('next-change')!.getBoundingClientRect().right,
        summaryLeft:document.getElementById('commit-message')!.getBoundingClientRect().left,
        changesLeft:document.getElementById('files-label')!.getBoundingClientRect().left,
      };
    });
    assert.equal(detailAlignment.close,detailAlignment.next,'detail toolbars share the same right edge');
    assert.equal(detailAlignment.summaryLeft,detailAlignment.changesLeft,'detail summary and changes heading share the same content inset');
    await closeButton.click();await frame.locator('#refresh').click();await settled();
    assert.equal(await frame.locator('#detail').isVisible(),false);

    // Deleted filters recover explicitly on both refresh and pagination.
    for (const button of ['refresh','load-more']) {
      await reopen();await frame.locator('#branch').selectOption('refs/heads/topic');await settled();
      await git(repo,['branch','-D','topic']);await frame.locator(`#${button}`).click();
      await frame.locator('#branch-notice').getByText('已显示所有分支与标签',{exact:false}).waitFor();
      assert.equal(await frame.locator('#branch-notice').getAttribute('role'),'status','filter changes are informational');
      assert.equal(await frame.locator('#branch').inputValue(),'');
      assert.equal(await frame.locator('#branch option[value="refs/heads/topic"]').count(),0);
      assert.equal(await frame.locator('#branch-notice').isVisible(),true);
      await git(repo,['branch','topic',topic]);
    }

    // Namespaces remain distinguishable in the picker, timeline and detail.
    await reopen();
    const names=['refs/heads/release','refs/tags/release','refs/heads/origin/main','refs/remotes/origin/main'];
    const labels=['本地 · release','标签 · release','本地 · origin/main','远程 · origin/main'];
    for (const [index,name] of names.entries()) {
      await frame.locator('#branch').selectOption(name);await settled();
      assert.equal(await frame.locator('#branch').evaluate(el=>(el as HTMLSelectElement).selectedOptions[0].textContent),labels[index]);
      const badge=frame.locator(`#rows .ref[title="${name}"]`);
      assert.ok((await badge.getAttribute('aria-label'))!.includes(labels[index]));await badge.click();
      assert.equal(await frame.locator(`#commit-refs .ref[title="${name}"]`).innerText(),labels[index]);
    }

    // Full revision models preserve text that used to be mistaken for patch headers.
    await reopen();await loadAllMain();await frame.locator(`[data-hash="${main}"]`).click();
    await frame.locator('#diff-status').getByText('1 处差异',{exact:true}).waitFor();
    assert.match((await frame.locator('#diff-editor .view-lines').allTextContents()).join(' ').replaceAll('\u00a0',' '),/\+\+new/);
    assert.ok(await frame.locator('#diff-editor .char-insert').count()>0);
    assert.ok(await frame.locator('#diff-editor .char-delete').count()>0);
    const editorScrollbarColors=()=>frame.locator('#diff-editor .monaco-editor').first().evaluate(element=>{
      const style=getComputedStyle(element),canvas=document.createElement('canvas'),context=canvas.getContext('2d')!;
      return ['background','hoverBackground','activeBackground'].map(state=>{
        context.fillStyle=style.getPropertyValue(`--vscode-scrollbarSlider-${state}`);context.fillRect(0,0,1,1);
        return [...context.getImageData(0,0,1,1).data];
      });
    });
    assert.deepEqual(await editorScrollbarColors(),[[35,40,47,255],[58,66,77,255],[58,66,77,255]],
      'Monaco reuses the Codex normal and strong scrollbar theme colors');
    assert.equal(await frame.locator('#diff-editor .monaco-editor').first().evaluate(element=>{
      const style=getComputedStyle(element), canvas=document.createElement('canvas'), context=canvas.getContext('2d')!;
      const probe=document.createElement('span');probe.style.color='var(--color-background-primary-ghost-hover)';element.append(probe);
      const expected=getComputedStyle(probe).color;probe.remove();
      const pixels=[expected,...['editor-inactiveSelectionBackground','editor-findMatchHighlightBackground','inputOption-hoverBackground','button-hoverBackground'].map(name=>style.getPropertyValue(`--vscode-${name}`))].map(color=>{
        context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].join(',');
      });
      return pixels.every(pixel=>pixel===pixels[0]);
    }),true,'editor hover and search highlight colors resolve to the host hover color');
    const surfacePixel=(locator: Locator)=>locator.evaluate(el=>{
      const canvas=document.createElement('canvas'),context=canvas.getContext('2d')!;
      context.fillStyle=getComputedStyle(el).backgroundColor;context.fillRect(0,0,1,1);
      return [...context.getImageData(0,0,1,1).data].slice(0,3);
    });
    const detailSurface=async (expected: number[])=>{
      assert.deepEqual(await surfacePixel(frame.locator('#detail')),expected);
      assert.deepEqual(await surfacePixel(frame.locator('#diff-editor .monaco-editor').first()),expected);
      assert.notDeepEqual(await surfacePixel(frame.locator('#history-pane')),expected);
    };
    await detailSurface([33,37,43]);
    await page.evaluate(()=>window.codeFont({'--color-background-primary':'#182736'}));
    await frame.locator('#detail').evaluate(el=>new Promise(resolve=>requestAnimationFrame(resolve)));
    await detailSurface([36,43,52]);
    assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).getPropertyValue('--color-background-primary').trim()), '#182736');
    await page.evaluate(()=>window.codeFont({'--color-background-primary':'#0d1117'}));

    const nativeEditorInput=frame.locator('#diff-editor .editor.modified').getByRole('textbox',{name:'目标版本，只读'});
    await nativeEditorInput.press(process.platform==='darwin'?'Meta+f':'Control+f');
    const nativeFind=frame.locator('#diff-editor .find-widget.visible');await nativeFind.waitFor();
    assert.equal(await nativeFind.locator('.monaco-inputbox').first().evaluate(el=>getComputedStyle(el).borderRadius),'4px','find input keeps Monaco native radius');
    assert.equal(await nativeFind.locator('.monaco-inputbox .input').first().evaluate(el=>getComputedStyle(el).minHeight),'0px','plugin control sizing must not leak into editor widgets');
    const shadowValue=()=>nativeFind.evaluate(el=>getComputedStyle(el).getPropertyValue('--vscode-widget-shadow').trim());
    await page.evaluate(()=>window.codeFont({'--color-text-success':'#12ab89','--color-text-danger':'#bc3456','--shadow-lg':'0px 4px 8px -2px rgba(60, 80, 120, .4)'}));
    await frame.locator('#diff-mode .diff-icon-split').evaluate(el=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.deepEqual(await frame.locator('#diff-mode .diff-icon-split path').evaluateAll(elements=>elements.map(el=>getComputedStyle(el).fill)),['rgb(188, 52, 86)','rgb(18, 171, 137)']);
    assert.equal(await shadowValue(),'rgba(60, 80, 120, 0.4)','existing Monaco widgets follow host shadow colors');
    const arrowSizes=await frame.locator('#prev-change svg, #next-change svg').evaluateAll(elements=>elements.map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,ink:(el as SVGGraphicsElement).getBBox().height})));
    assert.equal(arrowSizes.length,2);
    assert.ok(arrowSizes.every(size=>size.width===16&&size.height===16));
    assert.ok(Math.abs(arrowSizes[0].ink-arrowSizes[1].ink)<.01,'paired arrows use matching native optical sizes');
    assert.equal(await frame.locator('#prev-match svg').getAttribute('data-codex-icon'),'arrow-up-lg-light-16');
    await page.evaluate(()=>window.codeFont({'--color-text-success':'#3fb950','--color-text-danger':'#f85149','--shadow-lg':'0px 4px 8px -2px #0000001a'}));
    await nativeEditorInput.press('Escape');
    const codeStyle=()=>frame.locator('#diff-editor .view-lines').first().evaluate(el=>{
      const style=getComputedStyle(el);
      return {family:style.fontFamily,size:style.fontSize,weight:style.fontWeight,lineHeight:style.lineHeight};
    });
    const waitCodeSize=(size: string)=>frame.locator('#diff-editor .view-lines').first().evaluate(async (el,size)=>{
      const deadline=Date.now()+12000;
      while(getComputedStyle(el).fontSize!==size) {
        if(Date.now()>deadline)throw new Error('Code font size did not update');
        await new Promise(requestAnimationFrame);
      }
    },size);
    const originalCodeStyle=await codeStyle();
    assert.match(originalCodeStyle.family,/ui-monospace/,'editor uses the host code font');
    assert.equal(originalCodeStyle.size,'15px');
    assert.ok(parseFloat(originalCodeStyle.lineHeight)>15);
    codeFontSize = 18;
    await page.evaluate(()=>window.codeFont({'--font-mono':'Courier New, monospace','--font-text-xs-size':'16px','--font-weight-normal':'500'}));
    await frame.locator('#diff-editor .view-lines').first().evaluate(el=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await waitCodeSize('18px');
    const changedCodeStyle=await codeStyle();
    assert.match(changedCodeStyle.family,/Courier New/,'host code font changes update an existing editor');
    assert.equal(changedCodeStyle.size,'18px','code size follows Codex independently of UI text size');
    assert.equal(changedCodeStyle.weight,originalCodeStyle.weight);
    assert.ok(parseFloat(changedCodeStyle.lineHeight)>parseFloat(originalCodeStyle.lineHeight));
    codeFontSize = 17;
    await waitCodeSize('17px');
    codeFontSize = 15;
    await page.evaluate(()=>window.codeFont({'--font-mono':'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace','--font-text-xs-size':'12px','--font-weight-normal':'400'}));
    const diffMode=frame.locator('#diff-mode');
    assert.equal(await diffMode.getAttribute('aria-label'),'切换为并排差异');
    assert.equal(await diffMode.locator('.diff-icon-split').isVisible(),true);
    await diffMode.click();
    assert.equal(await diffMode.getAttribute('aria-label'),'切换为行内差异');
    assert.equal(await diffMode.locator('.diff-icon-inline').isVisible(),true);
    assert.equal(await frame.locator('#detail-body').isVisible(),true);
    await diffMode.press('Enter');
    assert.equal(await diffMode.getAttribute('data-mode'),'inline');
    assert.equal(await frame.locator('#diff-editor .monaco-diff-editor').evaluate(el=>el.classList.contains('side-by-side')),false);
    await diffMode.press('Space');
    assert.equal(await diffMode.getAttribute('data-mode'),'split');
    assert.equal(await frame.locator('#diff-editor .editor.original').evaluate(el=>el.getBoundingClientRect().width>0),true);
    const expandIcon=frame.locator('#expand-detail .expand-icon');
    const restoreIcon=frame.locator('#expand-detail .restore-icon');
    assert.equal(await expandIcon.isVisible(),true);
    assert.equal(await restoreIcon.isVisible(),false);
    await frame.locator('#expand-detail').click();
    assert.equal(await expandIcon.isVisible(),false);
    assert.equal(await restoreIcon.isVisible(),true);
    assert.equal(await frame.locator('#expand-detail').getAttribute('aria-label'),'恢复历史与详情布局');
    assert.equal(await frame.locator('#searchbar').isVisible(),false);
    const maximizedFits=async()=>{
      await frame.locator('#detail').evaluate(el=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const bounds=await frame.locator('#detail').evaluate(el=>{
        const viewport=document.getElementById('history-scroll')!,rect=viewport.getBoundingClientRect();
        const card=el.getBoundingClientRect(),row=el.closest('.commit-entry')!.querySelector('.commit-row')!;
        return {bottomGap:rect.top+viewport.clientHeight-card.bottom,
          topGap:card.top-row.getBoundingClientRect().bottom,
          leftOffset:card.left-row.querySelector('.message')!.getBoundingClientRect().left,
          rightOffset:card.right-row.querySelector('.author')!.getBoundingClientRect().right,
          scroll:viewport.scrollHeight,client:viewport.clientHeight};
      });
      assert.equal(bounds.topGap,2);
      assert.equal(bounds.bottomGap,4,'maximized details retain a bottom gutter');
      assert.deepEqual([bounds.leftOffset,bounds.rightOffset],[0,0],'maximized card edges align with the commit text area');
      assert.equal(bounds.scroll,bounds.client,'maximized history has no vertical overflow');
    };
    await maximizedFits();
    await page.setViewportSize({width:430,height:480});await maximizedFits();
    await page.setViewportSize({width:1000,height:850});await maximizedFits();
    if (process.env.UI_TEST_ARTIFACTS) {
      await mkdir(process.env.UI_TEST_ARTIFACTS,{recursive:true});
      await page.screenshot({path:join(process.env.UI_TEST_ARTIFACTS,'diff-dark.png')});
    }
    await page.evaluate(()=>window.light());
    await page.waitForTimeout(50);
    await detailSurface([248,248,248]);
    assert.deepEqual(await editorScrollbarColors(),[[221,221,221,255],[201,201,201,255],[201,201,201,255]],
      'Monaco scrollbar colors update with the Codex host theme');
    if (process.env.UI_TEST_ARTIFACTS) await page.screenshot({path:join(process.env.UI_TEST_ARTIFACTS,'diff-light.png')});
    await frame.locator('#expand-detail').click();
    assert.equal(await expandIcon.isVisible(),true);
    assert.equal(await restoreIcon.isVisible(),false);
    assert.equal(await frame.locator('#expand-detail').getAttribute('aria-label'),'放大详情');

    // Details expand inside the selected timeline entry, with files beside the diff.
    await page.setViewportSize({width:1280,height:900});
    await frame.locator('#detail-resize[aria-orientation="horizontal"]').waitFor();
    const panelSize=async(id: string,axis: 'height' | 'width'='height')=>Math.round(((await frame.locator(`#${id}`).boundingBox())!)[axis]);
    const inlineLayout=async()=>{
      await frame.locator('#detail-row').evaluate(el=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const geometry=await frame.locator('#detail-row').evaluate(el=>{
        const files=document.getElementById('files-pane')!.getBoundingClientRect();
        const diff=document.getElementById('diff-pane')!.getBoundingClientRect();
        const card=document.getElementById('detail')!.getBoundingClientRect();
        const row=el.closest('.commit-entry')!.querySelector('.commit-row')!;
        return {previous:el.parentElement!.previousElementSibling?.getAttribute('data-hash'),filesRight:files.right,diffLeft:diff.left,
          leftOffset:card.left-row.querySelector('.message')!.getBoundingClientRect().left,
          rightOffset:card.right-row.querySelector('.author')!.getBoundingClientRect().right,
          filesTop:files.top,diffTop:diff.top,graphHeight:document.getElementById('detail-graph')!.getBoundingClientRect().height,height:el.getBoundingClientRect().height};
      });
      assert.equal(geometry.previous,await frame.locator('.commit-row[aria-expanded="true"]').getAttribute('data-hash'));
      assert.ok(geometry.filesRight<=geometry.diffLeft,'files stay to the left of the diff');
      assert.equal(geometry.filesTop,geometry.diffTop);
      assert.deepEqual([geometry.leftOffset,geometry.rightOffset],[0,0],'card edges align with the commit text area');
      const gaps=await frame.locator('#detail-body').evaluate(el=>{
        const file=el.querySelector('#files button')!.getBoundingClientRect(),line=el.querySelector('#files-resize')!.getBoundingClientRect();
        return {left:file.left-document.getElementById('detail')!.getBoundingClientRect().left,
          before:line.left-file.right,after:el.querySelector('#diff-content')!.getBoundingClientRect().left-line.right};
      });
      assert.equal(gaps.left-1,gaps.before,'file selection has balanced padding inside the card border');
      assert.equal(gaps.before,6);assert.equal(gaps.after,0,'diff meets the divider');
      assert.equal(geometry.graphHeight,geometry.height,'graph spans the expanded details');
      assert.equal(await frame.locator('#detail-row').count(),1);
      const edges=await frame.locator('#detail-row').evaluate(el=>{
        const next=el.closest('.commit-entry')!.nextElementSibling;
        const outgoing=[...el.querySelectorAll('#detail-graph path')].map(path=>[path.getAttribute('d')!.match(/^M([\d.]+) 0/)![1],path.getAttribute('stroke')]);
        const incoming=[...(next?.querySelectorAll('.commit-row svg path')||[])].filter(path=>/^M[\d.]+ 0/.test(path.getAttribute('d')!)).map(path=>[path.getAttribute('d')!.match(/^M([\d.]+) 0/)![1],path.getAttribute('stroke')]);
        return {outgoing:outgoing.sort(),incoming:incoming.sort()};
      });
      assert.deepEqual(edges.outgoing,edges.incoming,'expanded graph connects to the next commit');
    };
    await inlineLayout();
    assert.equal(await frame.locator('#toggle-changes, .panel-toggle').count(),0);
    await frame.locator('#diff-title').click();
    assert.equal(await frame.locator('#diff-content').isVisible(),true,'changes heading is plain text');
    assert.equal(await frame.locator('#files').isVisible(),true);
    const selected=frame.locator(`[data-hash="${main}"]`);
    const selectedStyle=await selected.evaluate(el=>{
      const style=getComputedStyle(el,'::before');return {inset:style.inset,radius:style.borderRadius,
        expectedRadius:getComputedStyle(document.documentElement).getPropertyValue('--border-radius-md').trim(),background:style.backgroundColor};
    });
    assert.equal(selectedStyle.inset,'2px 4px');assert.equal(selectedStyle.radius,selectedStyle.expectedRadius);
    assert.notEqual(selectedStyle.background,'rgba(0, 0, 0, 0)');
    const stableDetail = await frame.locator('#detail').elementHandle();
    const stableEditor = await frame.locator('#diff-editor .monaco-diff-editor').elementHandle();
    assert.ok(stableDetail); assert.ok(stableEditor);
    await selected.click();assert.equal(await frame.locator('#detail').isVisible(),false,'click selected commit to close');
    assert.equal(await stableEditor.evaluate(element => element.isConnected), true, 'closing parks the same editor DOM');

    await selected.click();await frame.locator('#diff-status').getByText('1 处差异',{exact:true}).waitFor();
    await selected.press('ArrowDown');
    assert.notEqual(await frame.locator('.commit-row[aria-expanded="true"]').getAttribute('data-hash'),main,'keyboard skips the details region');
    await frame.locator('.commit-row[aria-expanded="true"]').press('ArrowUp');
    await frame.locator('#diff-status').getByText('1 处差异',{exact:true}).waitFor();
    await inlineLayout();
    assert.equal(await stableDetail.evaluate(element => element === document.getElementById('detail')), true, 'switching keeps one detail node');
    assert.equal(await stableEditor.evaluate(element => element === document.querySelector('#diff-editor .monaco-diff-editor')), true, 'switching and reopening preserve the editor instance DOM');
    await stableDetail.dispose(); await stableEditor.dispose();
    const dragPanel=async(id: string,delta: number,cancel=false)=>{
      const handle=frame.locator(`#${id}-resize`);
      await handle.scrollIntoViewIfNeeded();
      const box=(await handle.boundingBox())!, vertical=await handle.getAttribute('aria-orientation')==='vertical';
      const x=box.x+box.width/2,y=box.y+box.height/2;
      await page.mouse.move(x,y);await page.mouse.down();
      await page.mouse.move(x+(vertical?delta:0),y+(vertical?0:delta),{steps:5});
      const moved=(await handle.boundingBox())!;
      assert.ok(Math.abs((vertical?moved.x-box.x:moved.y-box.y)-delta)<2,`${id} sash follows the pointer: ${JSON.stringify({box,moved,delta})}`);
      if(cancel) await page.keyboard.press('Escape');
      await page.mouse.up();
    };
    const originalDetail=await panelSize('detail');
    await dragPanel('detail',60);
    assert.equal(await panelSize('detail'),originalDetail+60);
    await dragPanel('detail',-30,true);
    assert.equal(await panelSize('detail'),originalDetail+60,'Escape restores size');
    await frame.locator('#detail-resize').press('Shift+ArrowDown');
    assert.equal(await panelSize('detail'),originalDetail+61);
    const originalFiles=await panelSize('files-pane','width');
    await dragPanel('files',40);
    assert.equal(await panelSize('files-pane','width'),originalFiles+40);
    await frame.locator('#files-resize').press('Shift+ArrowLeft');
    assert.equal(await panelSize('files-pane','width'),originalFiles+39);
    await inlineLayout();
    assert.equal(await frame.locator('#toggle-summary').count(),0);
    assert.equal(await frame.locator('#summary-resize').isVisible(),true);
    const summaryFits=async()=>{
      const size=await frame.locator('#detail-summary').evaluate(el=>({height:el.parentElement!.getBoundingClientRect().height,
        content:el.scrollHeight,viewport:el.clientHeight,overflow:getComputedStyle(el).overflowY}));
      assert.ok(size.height<=160,'commit information is capped');
      assert.ok(size.content>size.viewport,'long commit information scrolls within the cap');
      assert.equal(size.overflow,'auto');
      assert.equal(await frame.locator('#detail-summary').isVisible(),true);
    };
    await summaryFits();
    const originalSummary=await panelSize('summary-pane'), originalBody=await panelSize('detail-body');
    await dragPanel('summary',40);
    assert.equal(await panelSize('summary-pane'),originalSummary+40);
    assert.equal(await panelSize('detail-body'),originalBody-40,'middle sash redistributes space within the card');
    assert.equal(await panelSize('detail'),originalDetail+61,'middle sash does not resize the card');
    await dragPanel('summary',-20,true);
    assert.equal(await panelSize('summary-pane'),originalSummary+40,'Escape restores the previous summary height');
    await frame.locator('#summary-resize').press('Shift+ArrowDown');
    assert.equal(await panelSize('summary-pane'),originalSummary+41);
    await frame.locator('#summary-resize').dblclick();
    assert.equal(await panelSize('summary-pane'),originalSummary,'reset restores the natural capped height');
    await frame.locator('#summary-resize').press('ArrowUp');
    const savedSummary=originalSummary-8;
    assert.equal(await panelSize('summary-pane'),savedSummary);
    await frame.locator('#detail-resize').hover();
    assert.equal(await frame.locator('#detail-resize').evaluate(el=>getComputedStyle(el,'::before').content),'none','outer resize edge has no internal highlight line');
    assert.equal(await frame.locator('#detail-resize').evaluate(el=>Math.round(el.getBoundingClientRect().bottom-document.getElementById('detail')!.getBoundingClientRect().bottom)),0,'resize target is on the outer card edge');
    await page.screenshot({path:join(process.env.UI_TEST_ARTIFACTS||temporary,'panels-wide.png')});
    const originalIntercept=intercept;
    intercept=async request=>request.name==='git_graph_save_layout'?{isError:true,content:[{type:'text',text:'模拟布局保存失败'}]}:null;
    const failedPanelSave=page.waitForResponse(r=>r.url().endsWith('/call')&&r.request().postDataJSON().name==='git_graph_save_layout');
    await frame.locator('#files-resize').press('Shift+ArrowRight');await (await failedPanelSave).finished();
    await frame.locator('#layout-error').waitFor({state:'visible'});
    intercept=async request => request.name==='git_graph_diff' ? {isError:true,content:[{type:'text',text:'模拟局部差异失败'}]} : null;
    await frame.locator('#close-detail').click();
    await frame.locator('.commit-row[data-selected]').click();
    await frame.locator('#diff-pane #diff-error').getByText('模拟局部差异失败').waitFor();
    assert.equal(await frame.locator('#layout-error').isVisible(),true,'layout and diff failures coexist');
    intercept=originalIntercept;
    await frame.locator('#diff-error-retry').click();
    await frame.locator('#diff-editor').waitFor({state:'visible'});
    assert.equal(await frame.locator('#layout-error').isVisible(),true,'diff recovery does not dismiss layout failure');
    const savedResponse=page.waitForResponse(r=>r.url().endsWith('/call')&&r.request().postDataJSON().name==='git_graph_save_layout');
    await frame.locator('#layout-error-retry').click();await (await savedResponse).finished();
    await frame.locator('#layout-error').waitFor({state:'hidden'});
    const panelPreferences=JSON.parse(await readFile(join(data,'panel-layout.json'),'utf8'));
    assert.equal(Object.keys(panelPreferences).some(key=>key.endsWith('Collapsed')),false);
    assert.equal('summaryCollapsed' in panelPreferences,false);
    assert.equal(panelPreferences.summaryHeight,savedSummary);
    assert.equal(panelPreferences.detailHeight,originalDetail+61);
    await writeFile(join(data,'panel-layout.json'),JSON.stringify({...panelPreferences,summaryCollapsed:true}));
    await reopen();await loadAllMain();await frame.locator(`[data-hash="${main}"]`).click();
    await frame.locator('#diff-status').getByText('1 处差异',{exact:true}).waitFor({state:'attached'});
    await summaryFits();
    assert.equal(await frame.locator('#files').isVisible(),true);
    assert.equal(await frame.locator('#diff-content').isVisible(),true);
    assert.equal(await panelSize('detail'),originalDetail+61,'reopening restores the saved card height');
    assert.equal(await panelSize('summary-pane'),savedSummary,'summary height persists after reopening');
    await page.setViewportSize({width:430,height:900});
    await inlineLayout();
    assert.equal(await frame.locator('#files-resize').getAttribute('aria-orientation'),'vertical','narrow views retain files on the left');
    assert.ok(await panelSize('files-pane','width')<originalFiles+39,'file list clamps to leave room for diff');
    assert.equal(await frame.locator('#files').isVisible(),true);
    assert.equal(await frame.locator('#diff-content').isVisible(),true);
    await frame.locator('#diff-status').getByText('1 处差异',{exact:true}).waitFor();
    await page.screenshot({path:join(process.env.UI_TEST_ARTIFACTS||temporary,'panels-narrow.png')});
    await page.setViewportSize({width:430,height:480});
    assert.equal(await frame.locator('#app').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    assert.equal(await frame.locator('#history-header').count(),0);
    assert.equal(await frame.locator('#toggle-history').count(),0);
    assert.equal(await frame.locator('#toggle-detail').count(),0);
    await frame.locator('#detail-hash').click();
    assert.equal(await frame.locator('#detail-content').isVisible(),true,'detail title is not a collapse control');
    await page.setViewportSize({width:1280,height:900});
    await frame.locator('#files-resize').evaluate(el=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await panelSize('detail'),originalDetail+61);
    assert.equal(await panelSize('files-pane','width'),originalFiles+40,'wide file width restores after a narrow viewport');
    assert.equal(await panelSize('summary-pane'),savedSummary,'summary preference restores after a narrow viewport');
    await frame.locator('#detail-resize').dblclick();
    assert.equal(await panelSize('detail'),originalDetail);
    await frame.locator('#files-resize').press('Home');
    assert.equal(await panelSize('files-pane','width'),originalFiles);
    await page.setViewportSize({width:1000,height:850});

    if (!process.argv.includes('--panels-only')) {
    // A late response from a previously selected file must not replace the current diff.
    await frame.locator(`[data-hash="${base}"]`).click();
    await frame.locator('#diff-status').getByText('处差异',{exact:false}).waitFor();
    let releaseDiff!: () => void, enteredDiff!: () => void;
    const heldDiff=new Promise<void>(resolve=>releaseDiff=resolve), startedDiff=new Promise<void>(resolve=>enteredDiff=resolve);
    intercept=async request=>{
      if(request.name==='git_graph_diff'&&request.arguments.path==='extra.txt') {
        const result=await historyClient!.callTool(request);enteredDiff();await heldDiff;return result;
      }
    };
    await frame.locator('#files button[data-path="extra.txt"]').click();await startedDiff;
    await frame.locator('#files button[data-path="base.txt"]').click();
    await frame.locator('#diff-status').getByText('处差异',{exact:false}).waitFor();
    const lateDiff=page.waitForResponse(response=>response.url().endsWith('/call')&&response.request().postDataJSON().name==='git_graph_diff'&&response.request().postDataJSON().arguments.path==='extra.txt');
    releaseDiff();await (await lateDiff).finished();await page.waitForTimeout(50);
    assert.equal(await frame.locator('#diff-title').innerText(),'base.txt');
    assert.doesNotMatch((await frame.locator('#diff-editor .view-lines').allTextContents()).join(' '),/extra/);
    intercept=async request=>request.name==='git_graph_diff'&&request.arguments.path==='extra.txt'
      ?{isError:true,content:[{type:'text',text:'模拟差异读取失败'}]}:null;
    await frame.locator('#files button[data-path="extra.txt"]').click();await frame.locator('#diff-error').waitFor({state:'visible'});
    assert.equal(await frame.locator('#diff-editor').isVisible(),false);
    intercept=null;await frame.locator('#diff-error-retry').click();await frame.locator('#diff-status').getByText('处差异',{exact:false}).waitFor();

    // A larger text file exercises folding, navigation, editor search and narrow layout.
    const lines=Array.from({length:100},(_,i)=>`const value${i} = ${i};`);
    await save('sample.ts',lines.join('\n')+'\n','Text base');
    lines[12]='const value12 = 1200;';lines[85]='const value85 = 8500;';
    const textTarget=await save('sample.ts',lines.join('\n')+'\n','Text changes');
    await reopen();await frame.locator(`[data-hash="${textTarget}"]`).click();
    await frame.locator('#diff-status').getByText('2 处差异',{exact:true}).waitFor();
    await frame.locator('#expand-detail').click();
    const linesBefore=(await frame.locator('#diff-editor .view-lines').allTextContents()).join(' ');
    assert.match(linesBefore,/value12/);assert.doesNotMatch(linesBefore,/value50/);
    await frame.locator('#next-change').click();await page.waitForTimeout(50);
    await frame.locator('#prev-change').click();
    const input=frame.locator('#diff-editor .editor.modified').getByRole('textbox',{name:'目标版本，只读'});
    const visibleLinesBeforeInput=(await frame.locator('#diff-editor .view-lines').allTextContents()).join(' ');
    await input.press('x');
    assert.equal((await frame.locator('#diff-editor .view-lines').allTextContents()).join(' '),visibleLinesBeforeInput,'historical models remain read-only');
    await input.press(process.platform==='darwin'?'Meta+f':'Control+f');
    await frame.locator('#diff-editor .find-widget.visible').waitFor();
    await input.press('Escape');
    assert.equal(await frame.locator('#detail').isVisible(),true,'editor Escape does not close the commit');
    await page.setViewportSize({width:400,height:700});await frame.locator('#expand-detail').click();
    await page.waitForTimeout(50);
    if(process.env.UI_TEST_ARTIFACTS) await page.screenshot({path:join(process.env.UI_TEST_ARTIFACTS,'diff-narrow.png')});
    assert.equal(await frame.locator('#app').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    const footerBounds=await frame.locator('#diff-status').evaluate(el=>({bottom:el.getBoundingClientRect().bottom,viewport:innerHeight}));
    assert.ok(footerBounds.bottom<=footerBounds.viewport,`diff footer remains reachable: ${JSON.stringify(footerBounds)}`);
    await page.setViewportSize({width:1000,height:850});

    await save('eol.txt','\uFEFFone\r\ntwo','Original line endings');
    await writeFile(join(repo,'binary.bin'),Buffer.from([0,1,2]));await git(repo,['add','binary.bin']);
    const special=await save('eol.txt','one\ntwo','Encoding and binary changes');
    await reopen();await frame.locator(`[data-hash="${special}"]`).click();
    await frame.locator('#diff-notice').getByText('二进制文件',{exact:false}).waitFor();
    assert.equal(await frame.locator('#diff-editor').isVisible(),false);
    await frame.locator('#files button[data-path="eol.txt"]').click();
    await frame.locator('#diff-status').getByText('文本相同；换行符或 BOM 有变化',{exact:true}).waitFor();

    // Changing refs between pages reloads a coherent history, including HEAD.
    await reopen();await selectMain();
    const added=await save('new.txt','new\n','New commit during pagination');
    await frame.locator('#load-more').click();await frame.locator(`[data-hash="${added}"]`).waitFor();
    assert.equal(await frame.locator(`.current[data-hash="${added}"] .graph circle`).count(),2);
    assert.equal(await frame.locator(`[data-hash="${added}"] .ref[title="refs/heads/main"]`).count(),1);
    assert.equal(await frame.locator('.commit-row').count(),2,'a new snapshot starts at its first page');
    await frame.locator('#load-more').click();await frame.locator('.commit-row').nth(3).waitFor();
    assert.equal(new Set(await frame.locator('.commit-row').evaluateAll(rows=>rows.map(row=>row.dataset.hash))).size,4);

    // A delayed old filter cannot expose the wrong rows or replace the newer result.
    await reopen();
    let release!: () => void, entered!: () => void;
    const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
    intercept=async request=>{
      if(request.name==='git_graph_history'&&request.arguments.branch==='refs/heads/main') {
        const result=await historyClient!.callTool({...request,arguments:{...request.arguments,limit:2}});
        entered();await held;return result;
      }
    };
    await frame.locator('#branch').selectOption('refs/heads/main');await started;
    assert.equal(await frame.locator('#history-table').isVisible(),false);
    assert.equal(await frame.locator('#searchbar').evaluate(element=>(element as HTMLElement).inert),true);
    await frame.locator('#branch').selectOption('refs/heads/topic');await frame.locator(`[data-hash="${topic}"]`).waitFor();
    const delayed=page.waitForResponse(response=>response.url().endsWith('/call')&&response.request().postDataJSON().arguments?.branch==='refs/heads/main');
    release();await (await delayed).finished();await page.waitForTimeout(50);
    assert.equal(await frame.locator('#branch').inputValue(),'refs/heads/topic');
    assert.equal(await frame.locator(`[data-hash="${added}"]`).count(),0);
    assert.equal(await frame.locator('#history-table').isVisible(),true);
    assert.equal(await frame.locator('#searchbar').evaluate(element=>(element as HTMLElement).inert),false);
  }
  }
  if (!process.argv.includes('--panels-only')) console.log(JSON.stringify({passed:true,checks:['inline commit details and graph continuity','file list beside diff','panel resizing and keyboard controls','static changes heading and diff mode toggle','panel layout persistence and retry','wide and narrow panel bounds','Codex rows and inline badges','reference identities','history filtering and pagination','parent and file refresh','Monaco inline/split diff','host theme and native editor typography','stale diff responses','diff retry','read-only models','unchanged region folding','change navigation','editor search and focus','narrow diff layout','bundled CSP worker','stale history responses']}));
  else console.log(JSON.stringify({passed:true,checks:['inline details and graph continuity','summary sash drag, keyboard, cancel and reset','summary height persistence and viewport bounds','no internal bottom divider','card and file resizing','layout save retry and restored visible changes','Monaco inline/split diff, host code font and code size']}));
  assert.ok(workers.length>0&&workers.every(url=>url.startsWith('blob:')),'diff computation uses bundled blob workers');
  }
  }
  // Project switching must reset repository-specific state and ignore out-of-order histories.
  const repositories = [{id:'a'.repeat(64),name:'web',path:'/project/web'}, {id:'b'.repeat(64),name:'app',path:'/project/app'}];
  const fixtures = repositories.map((repo,index) => ({ repo:repo.path, repositories, branch:'refs/heads/main', head:String(index+1).repeat(40),
    headName:'main', tips:[String(index+1).repeat(40)], refs:[{name:'refs/heads/main',hash:String(index+1).repeat(40)}], hasMore:false,
    commits:[{hash:String(index+1).repeat(40),parents:[],subject:repo.name,author:'Graph Test',email:'graph@example.invalid',date:'2026-09-20T00:00:00Z'}] }));
  let failRepository=false, holdRepository=false;
  let releaseRepository!: () => void, enteredRepository!: () => void;
  const repositoryEntered=new Promise<void>(resolve=>enteredRepository=resolve), repositoryHeld=new Promise<void>(resolve=>releaseRepository=resolve);
  intercept=async request=>{
    const index=request.arguments?.repository===repositories[1].id?1:0, data=fixtures[index];
    if (request.name==='git_graph') return {content:[],structuredContent:fixtures[0]};
    if (request.name==='git_graph_history') {
      if (index===1&&failRepository) return {isError:true,content:[{type:'text',text:'模拟仓库读取失败'}]};
      if (index===1&&holdRepository) {enteredRepository();await repositoryHeld;}
      return {content:[],structuredContent:{...data,branch:request.arguments.branch||'refs/heads/main'}};
    }
    if (request.name==='git_graph_commit') {
      assert.equal(request.arguments.hash,data.head,'details must use the selected repository');
      return {content:[],structuredContent:{...data.commits[0],repo:data.repo,message:data.commits[0].subject,files:[],parent:0}};
    }
  };
  frame=await open();await page.setViewportSize({width:639,height:863});
  assert.equal(await frame.locator('#repository').isDisabled(),false);
  assert.deepEqual(await frame.locator('#repository option').allTextContents(),['web','app']);
  await page.mouse.move(500,700);
  const repositoryAppearance = await selectAppearance('#repository');
  assert.deepEqual([repositoryAppearance.icon,repositoryAppearance.width,repositoryAppearance.height],['folder-light-16',16,16]);
  assert.equal(repositoryAppearance.iconColor,repositoryAppearance.muted,'repository icon follows the host secondary text color');
  assert.equal(repositoryAppearance.weight,repositoryAppearance.normalWeight,'selected repository keeps the host normal weight');
  assert.deepEqual([repositoryAppearance.selectedBackground,repositoryAppearance.triggerBackground],['rgba(0, 0, 0, 0)','rgba(0, 0, 0, 0)']);
  await codexRows();
  assert.equal(await frame.locator('#branch').isDisabled(),true);
  assert.equal(await frame.locator('#branch').inputValue(),'refs/heads/main');
  await frame.locator('#toggle-search').click();
  await frame.locator('#search').fill('web');await frame.locator('.commit-row').click();
  await frame.locator('#commit-message').getByText('web',{exact:true}).waitFor();
  failRepository=true;
  await frame.locator('#repository').selectOption(repositories[1].id);
  await frame.locator('#history-error').getByText('模拟仓库读取失败',{exact:true}).waitFor();
  assert.equal(await frame.locator('#repository').inputValue(),repositories[0].id);
  failRepository=false;await frame.locator('#history-error-retry').click();
  await frame.locator(`[data-hash="${fixtures[1].head}"]`).waitFor();
  assert.equal(await frame.locator('#search').inputValue(),'');
  assert.equal(await frame.locator('#branch').inputValue(),'refs/heads/main');
  assert.equal(await frame.locator('#detail-row').isVisible(),false);
  await codexRows();
  await frame.locator('.commit-row').click();await frame.locator('#commit-message').getByText('app',{exact:true}).waitFor();
  await frame.locator('#changes-empty').getByText('尚无文件更改').waitFor();
  assert.equal(await frame.locator('#files-pane').isVisible(), false);
  assert.equal(await frame.locator('#files-resize').isVisible(), false);
  assert.equal(await frame.locator('#diff-notice').isVisible(), false);
  assert.equal(await frame.locator('#changes-empty').evaluate(el=>Math.abs(el.getBoundingClientRect().width-el.parentElement!.getBoundingClientRect().width)<1), true);
  await frame.locator('#expand-detail').click();
  assert.equal(await frame.locator('#changes-empty').isVisible(), true);
  await frame.locator('#expand-detail').click();
  await frame.locator('#repository').selectOption(repositories[0].id);
  await frame.locator(`[data-hash="${fixtures[0].head}"]`).waitFor();
  holdRepository=true;await frame.locator('#repository').selectOption(repositories[1].id);await repositoryEntered;
  assert.equal(await frame.locator('#history-table').isVisible(),false);
  await frame.locator('#repository').selectOption(repositories[0].id);
  await frame.locator(`[data-hash="${fixtures[0].head}"]`).waitFor();
  const staleRepository=page.waitForResponse(response=>response.url().endsWith('/call')&&response.request().postDataJSON().arguments?.repository===repositories[1].id);
  releaseRepository();await (await staleRepository).finished();await page.waitForTimeout(50);
  assert.equal(await frame.locator('#repository').inputValue(),repositories[0].id);
  assert.equal(await frame.locator(`[data-hash="${fixtures[1].head}"]`).count(),0);
  assert.equal(await frame.locator('#app').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['single repository label','project repository switch','repository detail routing','reset search and filter','preserve layout','switch failure and retry','stale repository responses','narrow toolbar']}));
}finally{
  await browser?.close();server.closeAllConnections();server.close();await client.close();await historyClient?.close();await rm(temporary,{recursive:true,force:true});
}
