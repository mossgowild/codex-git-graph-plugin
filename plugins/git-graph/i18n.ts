export type Locale = 'en' | 'zh-CN';

export const catalog = {
  'ui.treeView': { en: 'Switch to tree view', 'zh-CN': '切换到树形视图' },
  'ui.listView': { en: 'Switch to list view', 'zh-CN': '切换到列表视图' },
  'ui.fileTree': { en: 'Changed file tree', 'zh-CN': '变更文件树' },
  'ui.directory': { en: 'Directory {path}', 'zh-CN': '目录 {path}' },
  'backend.external': { en: '{diagnostic}', 'zh-CN': '{diagnostic}' },
  'backend.join': { en: '{messages}', 'zh-CN': '{messages}' },
  'backend.git.outputLimit': { en: 'The result exceeds 16 MB. Select one file or narrow the history range.', 'zh-CN': '结果超过 16 MB，请选择单个文件或缩小历史范围。' },
  'backend.git.timeout': { en: 'The Git query exceeded 20 seconds. Narrow the range and try again.', 'zh-CN': 'Git 查询超过 20 秒，请缩小范围后重试。' },
  'backend.git.failure': { en: 'Git query failed: {diagnostic}', 'zh-CN': 'Git 查询失败：{diagnostic}' },
  'backend.path.absolute': { en: 'Enter an absolute path to a local repository.', 'zh-CN': '请输入本地仓库的绝对路径。' },
  'backend.git.invalidCommits': { en: 'Git returned invalid commit records.', 'zh-CN': 'Git 返回的提交记录格式无效。' },
  'backend.git.invalidSnapshot': { en: 'The commit snapshot is invalid. Refresh the graph.', 'zh-CN': '提交快照无效，请刷新。' },
  'backend.git.invalidRetained': { en: 'The retained commit IDs are invalid.', 'zh-CN': '需要保留的提交 ID 无效。' },
  'backend.git.invalidHash': { en: 'The commit ID is invalid.', 'zh-CN': '提交 ID 无效。' },
  'backend.git.invalidFiles': { en: 'Git returned an invalid file list.', 'zh-CN': 'Git 返回的文件列表格式无效。' },
  'backend.git.invalidParent': { en: 'The selected parent commit is invalid.', 'zh-CN': '父提交选择无效。' },
  'backend.file.missingObject': { en: 'The historical file object does not exist.', 'zh-CN': '历史文件对象不存在。' },
  'backend.file.notHistoricalFile': { en: 'The selected historical path is not a file.', 'zh-CN': '所选历史路径不是文件。' },
  'backend.file.tooLarge': { en: 'The file exceeds 2 MiB and was not loaded for text comparison.', 'zh-CN': '文件超过 2 MiB，未载入文本比较。' },
  'backend.file.binary': { en: 'This is a binary file and cannot be shown as a text diff.', 'zh-CN': '二进制文件，无法显示文本差异。' },
  'backend.file.encoding': { en: 'The file is not valid UTF-8 text and cannot be shown as a text diff.', 'zh-CN': '文件不是有效的 UTF-8 文本，无法显示文本差异。' },
  'backend.file.outsideRange': { en: 'This file is not among the changes in the selected range.', 'zh-CN': '这个文件不在所选范围的变更中。' },
  'backend.file.baseAndParent': { en: 'A range comparison cannot also specify a parent commit.', 'zh-CN': '范围比较不能同时指定父提交。' },
  'backend.file.missingWorkspace': { en: 'This file no longer exists in the working directory. Its historical diff is still available here.', 'zh-CN': '当前工作区中已没有这个文件；仍可在这里查看历史差异。' },
  'backend.file.outsideRepository': { en: 'The file resolves outside the current repository and cannot be opened from Git Graph.', 'zh-CN': '文件指向当前仓库之外，不能从 Git Graph 打开。' },
  'backend.file.notRegular': { en: 'The selected path is not a regular file.', 'zh-CN': '所选路径不是普通文件。' },
  'backend.watch.sessionRequired': { en: 'File watching requires the current MCP session. Reopen Git Graph.', 'zh-CN': '文件监听需要当前 MCP 会话，请重新打开 Git Graph。' },
  'backend.watch.outsideTask': { en: 'The watched repository no longer belongs to the current task. Reopen Git Graph.', 'zh-CN': '监听的仓库已不属于当前任务，请重新打开 Git Graph。' },
  'backend.watch.stopped': { en: 'The watch has stopped or expired. Start a new watch.', 'zh-CN': '监听已停止或过期，请重新建立监听。' },
  'backend.watch.cancelled': { en: 'Waiting for changes was cancelled.', 'zh-CN': '等待变化已取消。' },
  'backend.watch.invalidTiming': { en: 'The watch wait, lease or debounce duration is invalid.', 'zh-CN': '监听等待、租期与事件合并时限无效。' },
  'backend.watch.failure': { en: 'Could not watch repository changes: {diagnostic}', 'zh-CN': '无法监听仓库变化：{diagnostic}' },
  'backend.watch.rootChanged': { en: 'The repository root has changed. Reload the task repositories.', 'zh-CN': '仓库根路径已变化，请重新读取任务仓库。' },
  'backend.watch.invalidRevision': { en: 'The watch revision is invalid. Start a new watch.', 'zh-CN': '监听版本无效，请重新建立监听。' },
  'backend.preference.layout': { en: 'panel layout', 'zh-CN': '面板布局' },
  'backend.preference.read': { en: 'Could not read {label}: {diagnostic}', 'zh-CN': '读取{label}失败：{diagnostic}' },
  'backend.preference.save': { en: 'Could not save {label}: {diagnostic}', 'zh-CN': '保存{label}失败：{diagnostic}' },
  'backend.repository.outsideTask': { en: 'The selected repository does not belong to the current task. Reopen Git Graph.', 'zh-CN': '所选仓库不属于当前任务，请重新打开 Git Graph。' },
  'backend.repository.pathChanged': { en: 'The selected repository path has changed. Reopen Git Graph.', 'zh-CN': '所选仓库路径已变化，请重新打开 Git Graph。' },
  'backend.repository.read': { en: '{path}: {diagnostic}', 'zh-CN': '{path}：{diagnostic}' },
  'backend.task.read': { en: 'Could not read the task directories: {diagnostic}', 'zh-CN': '无法读取任务目录：{diagnostic}' },
  'backend.task.unopened': { en: 'Reopen Git Graph to load the current task repositories.', 'zh-CN': '请重新打开 Git Graph，读取当前任务仓库。' },
  'backend.project.unmigrated': { en: 'The project association has not been migrated. Select the project again in Codex.', 'zh-CN': '当前项目关联尚未迁移，请在 Codex 中重新选择项目。' },
  'backend.project.read': { en: 'Could not read project directories: {diagnostic}', 'zh-CN': '无法读取项目目录：{diagnostic}' },
  'backend.project.worktrees': { en: 'Could not read task worktrees: {diagnostic}', 'zh-CN': '无法读取任务工作树：{diagnostic}' },
  'backend.tool.unknown': { en: 'Unknown Git Graph operation.', 'zh-CN': '未知的 Git Graph 操作。' },
  'backend.tool.completed': { en: 'Git Graph operation completed.', 'zh-CN': 'Git Graph 操作完成。' },
  'backend.tool.invalidInput': { en: 'The Git Graph request is invalid: {diagnostic}', 'zh-CN': 'Git Graph 请求参数无效：{diagnostic}' },
  'backend.codex.exited': { en: 'The Codex service has exited.', 'zh-CN': 'Codex 服务已退出。' },
  'backend.codex.timeout': { en: 'Reading Codex configuration or projects exceeded 15 seconds. Try again.', 'zh-CN': '读取 Codex 配置或项目超过 15 秒，请重试。' },
  'backend.codex.configuration': { en: 'Could not read Codex configuration: {diagnostic}', 'zh-CN': '无法读取 Codex 配置：{diagnostic}' },
  'backend.tool.readAppearance': { en: "Read Codex font sizes and hover colors", 'zh-CN': "读取 Codex 字号与悬停配色" },
  'backend.tool.readHistory': { en: "Read commit history", 'zh-CN': "读取提交历史" },
  'backend.tool.readCommit': { en: "View commit", 'zh-CN': "查看提交" },
  'backend.tool.readRange': { en: "View commit range", 'zh-CN': "查看提交范围" },
  'backend.tool.readDiff': { en: "View file diff", 'zh-CN': "查看文件差异" },
  'backend.tool.readRangeDiff': { en: "View range file diff", 'zh-CN': "查看范围文件差异" },
  'backend.tool.locateFile': { en: "Locate working directory file", 'zh-CN': "定位工作区文件" },
  'backend.tool.startWatch': { en: "Watch current repository changes", 'zh-CN': "监听当前仓库变化" },
  'backend.tool.waitWatch': { en: "Wait for repository changes", 'zh-CN': "等待仓库变化" },
  'backend.tool.stopWatch': { en: "Stop this panel repository watch", 'zh-CN': "停止本面板仓库监听" },
  'backend.tool.readLayout': { en: "Read Git Graph layout", 'zh-CN': "读取 Git Graph 布局" },
  'backend.tool.readEditor': { en: "Load historical diff editor", 'zh-CN': "加载历史差异编辑器" },
  'backend.tool.saveLayout': { en: "Save Git Graph layout", 'zh-CN': "保存 Git Graph 布局" },
  'ui.retry': { en: "Retry", 'zh-CN': "重试" },
  'ui.dismissNotice': { en: "Dismiss notice", 'zh-CN': "关闭提示" },
  'ui.local': { en: "Local", 'zh-CN': "本地" },
  'ui.remote': { en: "Remote", 'zh-CN': "远程" },
  'ui.tag': { en: "Tag", 'zh-CN': "标签" },
  'ui.noSubject': { en: "(No commit subject)", 'zh-CN': "（无提交标题）" },
  'ui.email': { en: "Email", 'zh-CN': "邮箱" },
  'ui.reference': { en: "Reference", 'zh-CN': "引用" },
  'ui.localBranches': { en: "Local branches", 'zh-CN': "本地分支" },
  'ui.remoteBranches': { en: "Remote branches", 'zh-CN': "远程分支" },
  'ui.allRefs': { en: "All branches and tags", 'zh-CN': "所有分支与标签" },
  'ui.loadingHistory': { en: "Loading commit history", 'zh-CN': "正在加载提交历史" },
  'ui.repository': { en: "Switch task repository", 'zh-CN': "切换任务仓库" },
  'ui.branch': { en: "Filter branches", 'zh-CN': "筛选分支" },
  'ui.search': { en: "Search commits", 'zh-CN': "搜索提交" },
  'ui.refresh': { en: "Refresh", 'zh-CN': "刷新" },
  'ui.refreshHint': { en: "Reload repository", 'zh-CN': "重新读取仓库" },
  'ui.searchLoaded': { en: "Search loaded commits", 'zh-CN': "搜索已加载的提交" },
  'ui.searchPlaceholder': { en: "Search commits, author or SHA", 'zh-CN': "搜索提交、作者或 SHA" },
  'ui.clearSearch': { en: "Clear search", 'zh-CN': "清除搜索" },
  'ui.previousMatch': { en: "Previous match", 'zh-CN': "上一个匹配" },
  'ui.nextMatch': { en: "Next match", 'zh-CN': "下一个匹配" },
  'ui.resizeHint': { en: "Drag to resize; double-click to reset; use arrow keys to adjust", 'zh-CN': "拖动调整大小；双击恢复默认；方向键微调" },
  'ui.history': { en: "Commit history", 'zh-CN': "提交历史" },
  'ui.commitList': { en: "Git commit list", 'zh-CN': "Git 提交列表" },
  'ui.noRepository': { en: "This directory is not in a Git repository", 'zh-CN': "当前目录不属于 Git 仓库" },
  'ui.noCommits': { en: "This repository has no commits", 'zh-CN': "这个仓库还没有提交" },
  'ui.firstCommit': { en: "Commits will appear automatically after the first commit.", 'zh-CN': "创建提交后会自动显示。" },
  'ui.commitDetail': { en: "Commit details", 'zh-CN': "提交详情" },
  'ui.rangeDetail': { en: "Commit range details", 'zh-CN': "提交范围详情" },
  'ui.refs': { en: "Branches and tags", 'zh-CN': "分支与标签" },
  'ui.restoreLayout': { en: "Restore history and details layout", 'zh-CN': "恢复历史与详情布局" },
  'ui.expandDetail': { en: "Expand details", 'zh-CN': "放大详情" },
  'ui.closeDetail': { en: "Close commit details", 'zh-CN': "关闭提交详情" },
  'ui.commitInfo': { en: "Commit information", 'zh-CN': "提交信息" },
  'ui.noMessage': { en: "(No commit message)", 'zh-CN': "（无提交说明）" },
  'ui.parentSelect': { en: "Choose comparison parent", 'zh-CN': "选择对比的父提交" },
  'ui.resizeSummary': { en: "Resize commit information and changed files", 'zh-CN': "调整提交信息与变更文件大小" },
  'ui.resizeDetail': { en: "Resize commit details height", 'zh-CN': "调整提交详情高度" },
  'ui.files': { en: "Changed files", 'zh-CN': "变更文件" },
  'ui.fileList': { en: "File list", 'zh-CN': "文件列表" },
  'ui.selectFile': { en: "Select a file to view its diff", 'zh-CN': "选择文件查看差异" },
  'ui.inline': { en: "Switch to inline diff", 'zh-CN': "切换为行内差异" },
  'ui.split': { en: "Switch to side-by-side diff", 'zh-CN': "切换为并排差异" },
  'ui.previousChange': { en: "Previous change", 'zh-CN': "上一处差异" },
  'ui.nextChange': { en: "Next change", 'zh-CN': "下一处差异" },
  'ui.openFileHint': { en: "Open the current workspace file in Codex", 'zh-CN': "在 Codex 中打开工作区文件（当前内容）" },
  'ui.openFile': { en: "Open workspace file in Codex", 'zh-CN': "在 Codex 中打开工作区文件" },
  'ui.noFiles': { en: "No changed files", 'zh-CN': "尚无文件更改" },
  'ui.noRangeFiles': { en: "The selected commit range has no changed files.", 'zh-CN': "所选提交范围没有文件更改。" },
  'ui.noParentFiles': { en: "There are no changed files relative to the selected parent.", 'zh-CN': "相对所选父提交没有文件更改。" },
  'ui.resizeFiles': { en: "Resize file list and diff", 'zh-CN': "调整文件列表与差异大小" },
  'ui.fileDiff': { en: "File diff", 'zh-CN': "文件差异" },
  'ui.original': { en: "Base", 'zh-CN': "基准" },
  'ui.modified': { en: "Target", 'zh-CN': "目标" },
  'ui.emptyTree': { en: "Empty tree", 'zh-CN': "空树" },
  'ui.missingSuffix': { en: " · File does not exist", 'zh-CN': " · 文件不存在" },
  'ui.loadingDiff': { en: "Loading file diff", 'zh-CN': "正在加载文件差异" },
  'ui.unavailableDiff': { en: "Cannot display file diff", 'zh-CN': "无法显示文件差异" },
  'ui.distinguishedRef': { en: "{kind} · {name}", 'zh-CN': "{kind} · {name}" },
  'ui.loadedMatches': { en: "{current}/{count} · Loaded history", 'zh-CN': "{current}/{count} · 已加载历史" },
  'ui.parentLabel': { en: "Compare parent commit", 'zh-CN': "对比父提交" },
  'ui.loadMore': { en: "Load more", 'zh-CN': "加载更多" },
  'ui.incoming': { en: "Incoming Changes", 'zh-CN': "传入的更改" },
  'ui.outgoing': { en: "Outgoing Changes", 'zh-CN': "传出的更改" },
  'ui.externalError': { en: "Request failed: {diagnostic}", 'zh-CN': "请求失败：{diagnostic}" },
  'ui.notConnected': { en: "Not connected to Codex. Reopen the Git Graph window.", 'zh-CN': "尚未连接到 Codex，请重新打开 Git Graph 窗口。" },
  'ui.queryFailure': { en: "Git query failed: {diagnostic}", 'zh-CN': "Git 查询失败：{diagnostic}" },
  'ui.invalidData': { en: "Git Graph returned invalid data.", 'zh-CN': "Git Graph 返回了无效的数据。" },
  'ui.appearanceFailure': { en: "Could not read Codex appearance: {diagnostic}", 'zh-CN': "无法读取 Codex 外观：{diagnostic}" },
  'ui.missingBranchOnly': { en: "The selected branch or tag \"{name}\" no longer exists. Switched to \"{destination}\".", 'zh-CN': "所选分支或标签“{name}”已不存在，已切换到“{destination}”" },
  'ui.missingBranchAll': { en: "The selected branch or tag \"{name}\" no longer exists. Showing all branches and tags.", 'zh-CN': "所选分支或标签“{name}”已不存在，已显示所有分支与标签" },
  'ui.layoutReadFailure': { en: "Could not read the saved layout. {diagnostic}", 'zh-CN': "无法读取已保存的布局。{diagnostic}" },
  'ui.layoutSaveFailure': { en: "The layout has not been saved. {diagnostic}", 'zh-CN': "布局尚未保存。{diagnostic}" },
  'ui.watchStopFailure': { en: "Could not stop repository watching: {diagnostic}", 'zh-CN': "停止仓库监听失败：{diagnostic}" },
  'ui.watchFailure': { en: "Could not watch repository changes: {diagnostic}", 'zh-CN': "无法监听仓库变化：{diagnostic}" },
  'ui.openFailure': { en: "Could not open Git Graph", 'zh-CN': "打开失败" },
  'ui.connectionFailure': { en: "{diagnostic} Reopen the Git Graph window.", 'zh-CN': "{diagnostic} 请重新打开 Git Graph 窗口。" },
  'ui.missingBase': { en: "The commit range has no common ancestor.", 'zh-CN': "提交范围缺少共同祖先。" },
  'ui.closed': { en: "Git Graph has closed.", 'zh-CN': "Git Graph 已关闭。" },
  'ui.editorLoadFailure': { en: "Could not load the diff editor.", 'zh-CN': "差异编辑器加载失败。" },
  'ui.noFileOpening': { en: "This Codex host does not support opening workspace files.", 'zh-CN': "当前 Codex 宿主不支持打开工作区文件。" },
  'ui.fileOpenFailure': { en: "Codex could not open the workspace file.", 'zh-CN': "Codex 未能打开工作区文件。" },
  'ui.filesCount': { en: "Changed files · {count}", 'zh-CN': "变更文件 · {count}" },
  'ui.filesParent': { en: "Changed files · {count} · Relative to parent {parent}", 'zh-CN': "变更文件 · {count} · 相对父提交 {parent}" },
  'ui.revision': { en: "{label} {hash}{missing}{mode}", 'zh-CN': "{label} {hash}{missing}{mode}" },
  'ui.fileMode': { en: "File mode: {mode}", 'zh-CN': "文件模式：{mode}" },
  'ui.reason': { en: "{label}: {reason}", 'zh-CN': "{label}：{reason}" },
  'ui.pixels': { en: "{size} pixels", 'zh-CN': "{size} 像素" },
  'editor.status.pending': { en: 'Comparing…', 'zh-CN': '正在比较…' },
  'editor.status.uncomputed': { en: 'Diff is not ready', 'zh-CN': '差异尚未算出' },
  'editor.status.change': { en: '{count} change', 'zh-CN': '{count} 处差异' },
  'editor.status.changes': { en: '{count} changes', 'zh-CN': '{count} 处差异' },
  'editor.status.same': { en: 'File contents are identical', 'zh-CN': '文件内容相同' },
  'editor.status.lineEnding': { en: 'Text is identical; line endings or BOM differ', 'zh-CN': '文本相同；换行符或 BOM 有变化' },
  'editor.status.incomplete': { en: 'The diff could not be fully computed', 'zh-CN': '未能完整计算差异' },
  'editor.aria.original': { en: 'Original version, read-only', 'zh-CN': '基准版本，只读' },
  'editor.aria.modified': { en: 'Modified version, read-only', 'zh-CN': '目标版本，只读' },
  'editor.error.shadow': { en: 'Could not parse the Codex widget shadow color', 'zh-CN': '无法解析 Codex 浮层阴影颜色' },
} as const;

export type MessageKey = keyof typeof catalog;
export type MessageParam = string | number | boolean | null | Message | MessageParam[];
export type Message = { key: MessageKey; params?: Record<string, MessageParam> };
export const msg = (key: MessageKey, params?: Message['params']): Message => params ? { key, params } : { key };
export function resolveLocale(host?: string, browser: readonly string[] = []): Locale {
  const selected = host?.trim() || browser.find(language => language.trim()) || 'en';
  return /^zh(?:-(?:hans|cn|sg)(?:-|$)|$)/i.test(selected) ? 'zh-CN' : 'en';
}

export function isMessage(value: unknown): value is Message {
  if (value == null || typeof value !== 'object' || !('key' in value) || typeof value.key !== 'string' || !Object.hasOwn(catalog, value.key)) return false;
  const valid = (param: unknown): boolean => param === null || ['string', 'number', 'boolean'].includes(typeof param)
    || (Array.isArray(param) ? param.every(valid) : isMessage(param));
  return !('params' in value) || (value.params != null && typeof value.params === 'object' && !Array.isArray(value.params) && Object.values(value.params).every(valid));
}

export function format(message: Message | string, locale: Locale): string {
  if (typeof message === 'string') return message;
  const value = (param: MessageParam | undefined): string => param == null ? '' : isMessage(param) ? format(param, locale)
    : Array.isArray(param) ? param.map(value).join(', ') : String(param);
  if (message.key === 'backend.join') {
    const messages = message.params?.messages;
    return Array.isArray(messages) ? messages.map(value).join(value(message.params?.separator)) : value(messages);
  }
  const template = catalog[message.key][locale];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => value(message.params?.[name]));
}

export function toMessage(value: unknown): Message {
  if (isMessage(value)) return value;
  if (value != null && typeof value === 'object' && 'messageDescriptor' in value && isMessage(value.messageDescriptor)) return value.messageDescriptor;
  if (value instanceof Error && 'issues' in value && Array.isArray(value.issues)) {
    const issues = value.issues.filter((issue): issue is { message: string } => issue != null && typeof issue === 'object' && 'message' in issue && typeof issue.message === 'string');
    if (issues.some(issue => Object.hasOwn(catalog, issue.message))) return msg('backend.join', {
      messages: issues.map(issue => Object.hasOwn(catalog, issue.message) ? msg(issue.message as MessageKey) : msg('backend.external', { diagnostic: issue.message })),
      separator: '\n', diagnostic: value.message,
    });
  }
  return msg('backend.external', { diagnostic: value != null && typeof value === 'object' && 'message' in value && typeof value.message === 'string' ? value.message : String(value) });
}

export const joinMessages = (messages: readonly (Message | string)[], separator = '\n') => msg('backend.join', { messages: messages.map(toMessage), separator });
export function error(key: MessageKey, params?: Message['params'], cause?: unknown) {
  const messageDescriptor = msg(key, params);
  return Object.assign(new Error(format(messageDescriptor, 'en'), cause === undefined ? undefined : { cause }), { messageDescriptor });
}
