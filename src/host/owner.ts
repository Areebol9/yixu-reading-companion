import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import {SESSION_FORMAT_VERSION, SessionId} from '@deepseek-ai/dsh-session';
import {materializeCreateHeader, SessionAlreadyExistsError} from '@deepseek-ai/dsh-session-persistence';

/** Official JSONL ownership, held by a content-free archive control session. */
export async function ownArchive(ctx: Context, archiveId: string, directory: string) {
  const cwd = resolve(directory); await mkdir(cwd, {recursive: true});
  const id = SessionId('yixu-archive-control-' + createHash('sha256').update(archiveId).digest('hex'));
  const persistence = ctx.sessionPersistence;
  const stat = await persistence.stat(id);
  // This content-free session is only an OS lease inside this archive's isolated
  // persistence root. Its ID owns the archive; historical cwd spelling is not
  // an execution directory and can differ across Windows launch environments.
  if (stat && (stat.header.id !== id || stat.header.version !== SESSION_FORMAT_VERSION || stat.header.isSeeded)) throw Error('原生存档控制会话身份不符');
  let handle;
  if (stat) handle = await persistence.open(id, 'write');
  else {
    const header = materializeCreateHeader({version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd, isSeeded: false});
    try { handle = await persistence.create(header); }
    catch (error) { if (!(error instanceof SessionAlreadyExistsError)) throw error; handle = await persistence.open(id, 'write'); }
  }
  try {
    if (handle.header.id !== id || handle.header.version !== SESSION_FORMAT_VERSION || handle.header.isSeeded) throw Error('存档控制会话创建竞争身份不符');
    await handle.flush();
  } catch (error) { await handle.close(); throw error; }
  return async () => { await handle.close(); };
}
