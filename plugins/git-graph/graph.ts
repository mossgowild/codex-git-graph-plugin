// Adapted from VS Code scmHistory.ts (MIT), commit 04c0d99f4fb0d8afe6ce4f0c58e31e183ac3e4b1.
// Copyright (c) Microsoft Corporation. See THIRD-PARTY-LICENSES.txt.
export type GraphCommit = { hash: string; parents: string[] };
export type SyntheticCommit = GraphCommit & { subject: string; author: string; email: string; date: string };
export type GraphRef = { name: string; hash: string; upstream?: string };
export type RefIcon = 'target' | 'git-branch' | 'cloud' | 'tag';
export type ColoredRef = GraphRef & { color?: string; icon?: RefIcon };
type Lane = { hash: string; color: string };
export type GraphTarget = 'commit' | 'incoming-changes' | 'outgoing-changes';
export type GraphRow<T extends GraphCommit = GraphCommit> = T & {
  target: GraphTarget; base: string | null; revision: string;
  column: number; color: string; input: Lane[]; output: Lane[];
  references: ColoredRef[]; kind: 'HEAD' | 'node' | 'incoming-changes' | 'outgoing-changes'; width: number;
};
type GraphOptions = { refs?: GraphRef[]; head?: string; branch?: string;
  currentRef?: GraphRef | null; upstreamRef?: GraphRef | null; baseRef?: GraphRef | null; mergeBase?: string | null };
export const incomingId = 'incoming-changes', outgoingId = 'outgoing-changes';
export const laneWidth = 11;
export const colors = Array.from({ length: 5 }, (_, index) => `var(--graph-${index + 1})`);
const currentColor = 'var(--graph-current)', remoteColor = 'var(--graph-remote)', baseColor = 'var(--graph-base)';
export const laneX = (column: number) => laneWidth * (column + 1);
const dimensions = (row: Pick<GraphRow, 'hash' | 'parents' | 'input' | 'output'>) => {
  const incoming = row.input.findIndex(lane => lane.hash === row.hash), column = incoming === -1 ? row.input.length : incoming;
  const color = (row.parents.length ? row.output[column]?.color : undefined) || row.input[column]?.color || currentColor;
  return { column, color, width: laneWidth * (Math.max(row.input.length, row.output.length, column + 1) + 1) };
};

export function layout<T extends GraphCommit>(commits: T[], { refs = [], head = '', branch = '', currentRef = null, upstreamRef = null, baseRef = null, mergeBase = null }: GraphOptions = {}) {
  const colorMap = new Map<string, string | undefined>();
  if (currentRef) {
    colorMap.set(currentRef.name, currentColor);
    if (upstreamRef) colorMap.set(upstreamRef.name, remoteColor);
    if (baseRef) colorMap.set(baseRef.name, baseColor);
  }
  for (const ref of refs) if ((!branch || ref.name === branch) && !colorMap.has(ref.name)) colorMap.set(ref.name, undefined);
  const refsByHash = new Map<string, GraphRef[]>(), commitsByHash = new Map(commits.map(commit => [commit.hash, commit]));
  for (const ref of refs) {
    if (ref.name === 'refs/remotes/origin/HEAD') continue;
    if (!refsByHash.has(ref.hash)) refsByHash.set(ref.hash, []);
    refsByHash.get(ref.hash)!.push(ref);
  }
  const labelColor = (commit: GraphCommit) => (refsByHash.get(commit.hash) || []).map(ref => colorMap.get(ref.name)).find(Boolean);
  let sequence = 0;
  let previous: Lane[] = [];
  const rows = commits.map((commit): GraphRow<T | SyntheticCommit> => {
    const input = previous.map(lane => ({ ...lane })), output: Lane[] = [];
    let firstParentAdded = false;
    for (const lane of input) {
      if (lane.hash === commit.hash) {
        if (!firstParentAdded && commit.parents.length) {
          output.push({ hash: commit.parents[0], color: labelColor(commit) || lane.color });
          firstParentAdded = true;
        }
      } else output.push({ ...lane });
    }
    for (let index = firstParentAdded ? 1 : 0; index < commit.parents.length; index++) {
      const parent = commitsByHash.get(commit.parents[index]);
      const color = (index === 0 ? labelColor(commit) : parent && labelColor(parent)) || colors[sequence++ % colors.length];
      output.push({ hash: commit.parents[index], color });
    }
    const geometry = dimensions({ ...commit, input, output });
    const references: ColoredRef[] = (refsByHash.get(commit.hash) || []).map(ref => ({ ...ref,
      color: colorMap.has(ref.name) ? colorMap.get(ref.name) || geometry.color : undefined,
      icon: ref.name === currentRef?.name ? 'target' : ref.name.startsWith('refs/heads/') ? 'git-branch'
        : ref.name.startsWith('refs/remotes/') ? 'cloud' : ref.name.startsWith('refs/tags/') ? 'tag' : undefined,
    }));
    const priority = (ref: ColoredRef) => ref.name === currentRef?.name ? 1 : ref.name === upstreamRef?.name ? 2 : ref.name === baseRef?.name ? 3 : ref.color ? 4 : 99;
    references.sort((a, b) => priority(a) - priority(b));
    previous = output;
    return { ...commit, ...geometry, target: 'commit', base: commit.parents[0] || null, revision: commit.hash,
      input, output, references, kind: commit.hash === (currentRef?.hash || head) ? 'HEAD' : 'node' };
  });
  if (currentRef && upstreamRef && mergeBase && currentRef.hash !== upstreamRef.hash) {
    if ((!branch || branch === upstreamRef.name) && upstreamRef.hash !== mergeBase) {
      const before = rows.findLastIndex(row => row.output.some(lane => lane.hash === mergeBase));
      const after = rows.findIndex(row => row.hash === mergeBase);
      if (before !== -1 && after !== -1 && !(rows[before].parents.length === 2 && rows[before].parents.includes(mergeBase))) {
        const reconnect = (lanes: Lane[]) => lanes.map(lane => lane.hash === mergeBase && lane.color === remoteColor ? { ...lane, hash: incomingId } : { ...lane });
        rows[before].input = reconnect(rows[before].input); rows[before].output = reconnect(rows[before].output);
        const input = rows[before].output.map(lane => ({ ...lane })), output = rows[after].input.map(lane => ({ ...lane }));
        rows.splice(after, 0, { hash: incomingId, parents: [mergeBase], subject: 'Incoming Changes', author: upstreamRef.name.replace(/^refs\/(heads|remotes)\//, ''), email: '', date: '',
          target: incomingId, base: mergeBase, revision: upstreamRef.hash, input, output, references: [], kind: incomingId,
          ...dimensions({ hash: incomingId, parents: [mergeBase], input, output }) });
      }
    }
    if ((!branch || branch === currentRef.name) && currentRef.hash !== mergeBase) {
      const index = rows.findIndex(row => row.kind === 'HEAD' && row.hash === currentRef.hash);
      if (index !== -1) {
        const input = rows[index].input.map(lane => ({ ...lane })), output = [...input.map(lane => ({ ...lane })), { hash: currentRef.hash, color: currentColor }];
        rows.splice(index, 0, { hash: outgoingId, parents: [currentRef.hash], subject: 'Outgoing Changes', author: currentRef.name.replace(/^refs\/heads\//, ''), email: '', date: '',
          target: outgoingId, base: mergeBase, revision: currentRef.hash, input, output, references: [], kind: outgoingId,
          ...dimensions({ hash: outgoingId, parents: [currentRef.hash], input, output }) });
        rows[index + 1].input.push({ hash: currentRef.hash, color: currentColor });
      }
    }
  }
  for (const row of rows) Object.assign(row, dimensions(row));
  return { rows };
}

export function graphPaths(row: GraphRow, height = 22) {
  const middle = height / 2, inset = middle - 11;
  const paths: { d: string; color: string }[] = [], { input, output, column, color, parents, hash } = row;
  const add = (d: string, color: string) => paths.push({ d, color });
  let target = 0;
  for (const [index, lane] of input.entries()) {
    if (lane.hash === hash) {
      if (index !== column) add(`M${laneX(index)} 0${inset ? `V${inset}` : ''}A11 11 0 0 1 ${index * 11} ${middle}H${laneX(column)}`, lane.color);
      else if (parents.length) target++;
    } else if (lane.hash === output[target]?.hash) {
      add(index === target ? `M${laneX(index)} 0V${height}`
        : `M${laneX(index)} 0V${middle - 5}A5 5 0 0 1 ${laneX(index) - 5} ${middle}H${laneX(target) + 5}A5 5 0 0 0 ${laneX(target)} ${middle + 5}V${height}`, lane.color);
      target++;
    }
  }
  for (const parent of parents.slice(1)) {
    const index = output.findLastIndex(lane => lane.hash === parent);
    if (index === -1) continue;
    add(`M${index * 11} ${middle}A11 11 0 0 1 ${laneX(index)} ${middle + 11}${inset ? `V${height}` : ''}M${index * 11} ${middle}H${laneX(column)}`, output[index].color);
  }
  if (input[column]?.hash === hash) add(`M${laneX(column)} 0V${middle}`, input[column].color);
  if (parents.length) add(`M${laneX(column)} ${middle}V${height}`, color);
  return paths;
}
