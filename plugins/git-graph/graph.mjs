// Adapted from VS Code scmHistory.ts (MIT), commit 7debcd0e2acdea1c52de81bf9ee1620444407dda.
// Copyright (c) Microsoft Corporation. See THIRD-PARTY-LICENSES.txt.
export const laneWidth = 11;
export const colors = Array.from({ length: 5 }, (_, index) => `var(--graph-${index + 1})`);
const currentColor = 'var(--graph-current)', remoteColor = 'var(--graph-remote)';
export const laneX = column => laneWidth * (column + 1);

export function layout(commits, { refs = [], head = '', headName = '', branch = '' } = {}) {
  const current = refs.find(ref => ref.name === `refs/heads/${headName}`);
  const upstream = current?.upstream;
  const refsByHash = new Map(), commitsByHash = new Map(commits.map(commit => [commit.hash, commit]));
  for (const ref of refs) {
    if (!refsByHash.has(ref.hash)) refsByHash.set(ref.hash, []);
    refsByHash.get(ref.hash).push(ref);
  }
  const refColor = ref => ref.name === current?.name ? currentColor : ref.name === upstream ? remoteColor : undefined;
  const labelColor = commit => (refsByHash.get(commit.hash) || []).map(refColor).find(Boolean);
  let sequence = 0, previous = [];
  const rows = commits.map(commit => {
    const input = previous, output = [];
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
    const incoming = input.findIndex(lane => lane.hash === commit.hash);
    const column = incoming === -1 ? input.length : incoming;
    const color = (commit.parents.length ? output[column]?.color : undefined) || input[column]?.color || currentColor;
    const references = (refsByHash.get(commit.hash) || []).map(ref => ({ ...ref,
      color: refColor(ref) || (!branch || ref.name === branch ? color : undefined),
      icon: ref.name === current?.name ? 'target' : ref.name.startsWith('refs/remotes/') ? 'cloud' : ref.name.startsWith('refs/tags/') ? 'tag' : 'branch',
    }));
    const priority = ref => ref.name === current?.name ? 1 : ref.name === upstream ? 2 : ref.color ? 4 : 99;
    references.sort((a, b) => priority(a) - priority(b));
    previous = output;
    return { ...commit, column, color, input, output, references, kind: commit.hash === head ? 'HEAD' : 'node',
      width: laneWidth * (Math.max(input.length, output.length, column + 1) + 1) };
  });
  return { rows, continuation: previous.map(lane => lane.hash) };
}

export function graphPaths(row, height = 22) {
  const middle = height / 2, inset = middle - 11;
  const paths = [], { input, output, column, color, parents, hash } = row;
  const add = (d, color) => paths.push({ d, color });
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
    add(`M${index * 11} ${middle}A11 11 0 0 1 ${laneX(index)} ${middle + 11}${inset ? `V${height}` : ''}M${index * 11} ${middle}H${laneX(column)}`, output[index].color);
  }
  if (input[column]?.hash === hash) add(`M${laneX(column)} 0V${middle}`, input[column].color);
  if (parents.length) add(`M${laneX(column)} ${middle}V${height}`, color);
  return paths;
}
