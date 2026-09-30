import { watch, type FSWatcher } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import { git, repository } from './git.ts';
import { error as messageError, format, msg, toMessage } from './i18n.ts';

type Result = { watchId: string; revision: number; changed: boolean };
type Waiter = { finish(error?: Error): void };
type Session = {
  watchId: string; owner: string | undefined; repoPath: string; revision: number;
  watchers: FSWatcher[]; waiters: Set<Waiter>; closed: boolean; failure?: Error;
  dirty: boolean; relocate: boolean; processing: boolean;
  timer?: ReturnType<typeof setTimeout>; lease?: ReturnType<typeof setTimeout>;
};
const contains = (parent: string, path: string) => {
  const child = relative(parent, path);
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};
const stopped = () => messageError('backend.watch.stopped');
const abortError = () => Object.assign(new DOMException(format(msg('backend.watch.cancelled'), 'en'), 'AbortError'), { messageDescriptor: msg('backend.watch.cancelled') });

export function createWatchers({ waitMs = 20000, leaseMs = 60000, debounceMs = 75 } = {}) {
  if (![waitMs, leaseMs, debounceMs].every(value => Number.isFinite(value) && value > 0) || leaseMs <= waitMs + debounceMs) {
    throw messageError('backend.watch.invalidTiming');
  }
  const sessions = new Map<string, Session>();
  let closed = false;
  function get(owner: string | undefined, id: string) {
    const session = sessions.get(id);
    if (!session || session.owner !== owner || session.closed) throw stopped();
    return session;
  }
  function dispose(session: Session, error = stopped()) {
    session.closed = true;
    clearTimeout(session.timer); clearTimeout(session.lease);
    for (const watcher of session.watchers) watcher.close();
    session.watchers = [];
    for (const waiter of [...session.waiters]) waiter.finish(error);
    sessions.delete(session.watchId);
  }
  function renew(session: Session) {
    clearTimeout(session.lease);
    session.lease = setTimeout(() => dispose(session), leaseMs);
    session.lease.unref();
  }
  function fail(session: Session, caught: unknown) {
    if (session.closed || session.failure) return;
    session.failure = messageError('backend.watch.failure', { diagnostic: toMessage(caught) }, caught);
    clearTimeout(session.timer);
    for (const watcher of session.watchers) watcher.close();
    session.watchers = [];
    for (const waiter of [...session.waiters]) waiter.finish(session.failure);
  }
  function queue(session: Session, relocate: boolean) {
    if (session.closed || session.failure) return;
    session.dirty = true; session.relocate ||= relocate;
    // Keep the first event's deadline: continuous writes cannot postpone delivery forever.
    if (!session.timer && !session.processing) session.timer = setTimeout(() => { void flush(session); }, debounceMs);
  }
  async function bind(session: Session) {
    const root = await repository(session.repoPath);
    if (root !== session.repoPath) throw messageError('backend.watch.rootChanged');
    const directories = await Promise.all(['--absolute-git-dir', '--git-common-dir'].map(async flag =>
      realpath((await git(root, ['rev-parse', '--path-format=absolute', flag])).replace(/\n$/, ''))));
    if (session.closed || session.failure) return;
    const paths = [...new Set([root, ...directories])];
    const roots = paths.filter(path => !paths.some(other => other !== path && contains(other, path)));
    const next: FSWatcher[] = [];
    try {
      for (const path of roots) {
        const watcher = watch(path, { recursive: true }, (event, filename) => {
          const name = filename?.toString().replaceAll('\\', '/');
          queue(session, event === 'rename' || name == null || ['.git', 'gitdir', 'commondir'].includes(name.split('/').at(-1)!));
        });
        watcher.on('error', error => fail(session, error));
        watcher.unref(); next.push(watcher);
      }
    } catch (error) { for (const watcher of next) watcher.close(); throw error; }
    for (const watcher of session.watchers) watcher.close();
    session.watchers = next;
  }
  async function flush(session: Session) {
    session.timer = undefined;
    if (session.closed || session.failure) return;
    session.processing = true; session.dirty = false;
    const relocate = session.relocate; session.relocate = false;
    try {
      if (relocate) await bind(session);
      if (session.closed || session.failure) return;
      ++session.revision;
      for (const waiter of [...session.waiters]) waiter.finish();
    } catch (error) { fail(session, error); }
    finally {
      session.processing = false;
      if (session.dirty) queue(session, session.relocate);
    }
  }
  return {
    async start(owner: string | undefined, repoPath: string) {
      if (closed) throw stopped();
      const root = await repository(repoPath);
      const session: Session = { watchId: randomUUID(), owner, repoPath: root, revision: 0,
        watchers: [], waiters: new Set(), closed: false, dirty: false, relocate: false, processing: false };
      try {
        await bind(session);
        if (closed) throw stopped();
        sessions.set(session.watchId, session); renew(session);
        return { watchId: session.watchId, revision: session.revision };
      } catch (error) { dispose(session); throw error; }
    },
    async wait(owner: string | undefined, id: string, revision: number, signal?: AbortSignal): Promise<Result> {
      const session = get(owner, id);
      if (session.failure) throw session.failure;
      if (!Number.isInteger(revision) || revision < 0 || revision > session.revision) throw messageError('backend.watch.invalidRevision');
      if (signal?.aborted) throw abortError();
      renew(session);
      if (revision < session.revision) return { watchId: id, revision: session.revision, changed: true };
      return new Promise((resolve, reject) => {
        const cancel = () => waiter.finish(abortError());
        const timer = setTimeout(() => waiter.finish(), waitMs);
        const waiter: Waiter = { finish(error) {
          if (!session.waiters.delete(waiter)) return;
          clearTimeout(timer); signal?.removeEventListener('abort', cancel);
          if (error) reject(error);
          else resolve({ watchId: id, revision: session.revision, changed: session.revision !== revision });
        } };
        session.waiters.add(waiter);
        signal?.addEventListener('abort', cancel, { once: true });
      });
    },
    stop(owner: string | undefined, id: string) {
      if (!sessions.has(id)) return;
      dispose(get(owner, id));
    },
    getRepoPath(owner: string | undefined, id: string) { return get(owner, id).repoPath; },
    close() {
      closed = true;
      for (const session of [...sessions.values()]) dispose(session);
    },
  };
}
