import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { git } from './git.ts';
import { createWatchers } from './watch.ts';
import { toMessage, type MessageKey } from './i18n.ts';

const isErrorKey = (key: MessageKey) => (error: unknown) => toMessage(error).key === key;

async function quiet(watchers: ReturnType<typeof createWatchers>, owner: string, id: string, revision: number) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const update = await watchers.wait(owner, id, revision);
    revision = update.revision;
    if (!update.changed) return revision;
  }
  assert.fail('watch events did not settle');
}

async function init(repo: string) {
  await git(repo, ['init', '-b', 'main']);
  for (const [key, value] of [['user.name', 'Watch Test'], ['user.email', 'watch@example.invalid'],
    ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) await git(repo, ['config', key, value]);
  await mkdir(join(repo, 'node_modules', 'tracked'), { recursive: true });
  await writeFile(join(repo, 'node_modules', 'tracked', 'file.txt'), 'original\n');
  await git(repo, ['add', '-A']); await git(repo, ['commit', '-m', 'Initial']);
}

test('recursive events, bounded delivery, idle waiting and panel ownership', async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'git-graph-watch-')));
  const watchers = createWatchers({ waitMs: 500, leaseMs: 30000, debounceMs: 50 });
  try {
    await init(repo);
    const first = await watchers.start('thread', repo), second = await watchers.start('thread', repo);
    assert.notEqual(first.watchId, second.watchId);
    assert.equal(watchers.getRepoPath('thread', first.watchId), repo);
    assert.throws(() => watchers.getRepoPath('other', first.watchId), isErrorKey('backend.watch.stopped'));
    assert.throws(() => watchers.stop('other', first.watchId), isErrorKey('backend.watch.stopped'));
    await assert.rejects(watchers.wait('thread', first.watchId, 1), isErrorKey('backend.watch.invalidRevision'));

    let revision = first.revision;
    const changed = async (operation: () => Promise<unknown>) => {
      const result = watchers.wait('thread', first.watchId, revision);
      void result.catch(() => {});
      await operation();
      const update = await result;
      assert.equal(update.changed, true);
      assert.ok(update.revision > revision);
      revision = update.revision;
      // Drain late OS events before attributing the next update to another operation.
      revision = await quiet(watchers, 'thread', first.watchId, revision);
    };
    await changed(() => writeFile(join(repo, 'node_modules', 'tracked', 'file.txt'), 'changed\n'));
    await changed(async () => {
      await mkdir(join(repo, 'nested', 'new'), { recursive: true });
      await writeFile(join(repo, 'nested', 'new', 'untracked.txt'), 'new\n');
    });
    await changed(() => git(repo, ['add', '-A']));
    await changed(() => rename(join(repo, 'nested', 'new', 'untracked.txt'), join(repo, 'nested', 'new', 'renamed.txt')));
    await changed(() => rm(join(repo, 'nested', 'new', 'renamed.txt')));

    const originalPath = process.env.PATH;
    try {
      process.env.PATH = '/git-must-not-run-during-idle-wait';
      const idle = await watchers.wait('thread', first.watchId, revision);
      assert.deepEqual(idle, { watchId: first.watchId, revision, changed: false });
    } finally { process.env.PATH = originalPath; }

    let writing = true;
    const continuous = (async () => {
      for (let index = 0; writing; index++) {
        await writeFile(join(repo, 'node_modules', 'tracked', 'file.txt'), `${index}\n`);
        await delay(10);
      }
    })();
    try {
      const update = await watchers.wait('thread', first.watchId, revision);
      assert.equal(update.changed, true, 'continuous events must not starve a waiter');
      revision = update.revision;
    } finally { writing = false; await continuous; }

    const canceled = new AbortController();
    canceled.abort();
    await assert.rejects(watchers.wait('thread', first.watchId, revision, canceled.signal), { name: 'AbortError' });
    revision = await quiet(watchers, 'thread', first.watchId, revision);
    const cancel = new AbortController();
    const pending = watchers.wait('thread', first.watchId, revision, cancel.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    cancel.abort(); await rejected;
    const stoppedWait = watchers.wait('thread', first.watchId, revision);
    const stoppedResult = assert.rejects(stoppedWait, isErrorKey('backend.watch.stopped'));
    watchers.stop('thread', first.watchId); await stoppedResult;
    watchers.stop('thread', first.watchId);
    assert.equal(watchers.getRepoPath('thread', second.watchId), repo, 'stopping a panel keeps its sibling alive');
    const sibling = await quiet(watchers, 'thread', second.watchId, second.revision);
    const siblingWait = watchers.wait('thread', second.watchId, sibling);
    void siblingWait.catch(() => {});
    await writeFile(join(repo, 'node_modules', 'tracked', 'file.txt'), 'sibling still watching\n');
    assert.equal((await siblingWait).changed, true);
  } finally { watchers.close(); await rm(repo, { recursive: true, force: true }); }
});

test('linked worktree watches shared refs and preserves a Git pointer failure', async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'git-graph-watch-linked-')));
  const linked = `${repo}-worktree`;
  const watchers = createWatchers({ waitMs: 1000, leaseMs: 5000, debounceMs: 50 });
  try {
    await init(repo);
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['worktree', 'add', '--detach', linked, head]);
    const active = await watchers.start('linked', linked);
    let revision = active.revision;
    const refs = watchers.wait('linked', active.watchId, revision);
    void refs.catch(() => {});
    await git(repo, ['update-ref', 'refs/heads/new-reference', head]);
    const update = await refs;
    assert.equal(update.changed, true); revision = update.revision;
    revision = await quiet(watchers, 'linked', active.watchId, revision);
    const packed = watchers.wait('linked', active.watchId, revision);
    void packed.catch(() => {});
    await git(repo, ['pack-refs', '--all']);
    assert.equal((await packed).changed, true);
    revision = await quiet(watchers, 'linked', active.watchId, revision);
    const pointer = await readFile(join(linked, '.git'));
    const replacement = watchers.wait('linked', active.watchId, revision);
    void replacement.catch(() => {});
    await writeFile(join(linked, 'new-git-pointer'), pointer);
    await rename(join(linked, 'new-git-pointer'), join(linked, '.git'));
    assert.equal((await replacement).changed, true);
    revision = await quiet(watchers, 'linked', active.watchId, revision);
    const failed = assert.rejects(watchers.wait('linked', active.watchId, revision), isErrorKey('backend.watch.failure'));
    await rename(join(linked, '.git'), join(linked, 'saved-git-pointer'));
    await failed;
    await assert.rejects(watchers.wait('linked', active.watchId, revision), isErrorKey('backend.watch.failure'));
    watchers.stop('linked', active.watchId);
    await rename(join(linked, 'saved-git-pointer'), join(linked, '.git'));
    const retry = await watchers.start('linked', linked);
    assert.notEqual(retry.watchId, active.watchId);
    assert.equal((await watchers.wait('linked', retry.watchId, retry.revision)).changed, false);
  } finally {
    watchers.close(); await rm(linked, { recursive: true, force: true }); await rm(repo, { recursive: true, force: true });
  }
});

test('leases and close release sessions even without host cancellation', async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'git-graph-watch-lease-')));
  const watchers = createWatchers({ waitMs: 40, leaseMs: 200, debounceMs: 10 });
  try {
    await init(repo);
    const expired = await watchers.start(undefined, repo);
    assert.equal((await watchers.wait(undefined, expired.watchId, expired.revision)).changed, false);
    await delay(230);
    assert.throws(() => watchers.getRepoPath(undefined, expired.watchId), isErrorKey('backend.watch.stopped'));
    const active = await watchers.start('thread', repo);
    const pending = assert.rejects(watchers.wait('thread', active.watchId, active.revision), isErrorKey('backend.watch.stopped'));
    watchers.close(); await pending;
    assert.throws(() => watchers.getRepoPath('thread', active.watchId), isErrorKey('backend.watch.stopped'));
    await assert.rejects(watchers.start('thread', repo), isErrorKey('backend.watch.stopped'));
  } finally { watchers.close(); await rm(repo, { recursive: true, force: true }); }
});
