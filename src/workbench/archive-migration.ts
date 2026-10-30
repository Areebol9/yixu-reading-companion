import {activeWorkbenchSession, availableWorkbenchSessions, workbenchSessions} from './store.ts';
import type {CompanionConnection} from './remote-client.ts';

const selectedKey = 'yixu-companion-selected-archive-v1';
const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('');
export function rememberHostArchive(id: string) { localStorage.setItem(selectedKey, id); }
async function bridge(input: unknown) {
  const response = await fetch('/api/companionConnection', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Yixu-Client': 'local-app'}, body: JSON.stringify(input)});
  const value = await response.json(); if (!response.ok) throw Error(value.error ?? '阅读存档正在准备，请稍后再操作'); return value;
}
async function sourceDatabase(id: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('yixu-workbench-' + id);
    request.onupgradeneeded = () => { request.transaction?.abort(); reject(Error('原阅读存档不存在，未建立空档替代')); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
const read = <T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> => new Promise((resolve, reject) => {
  const request = db.transaction(store, 'readonly').objectStore(store).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
/** Read one row per short transaction; uploads never keep an IDB transaction alive. */
async function visit(db: IDBDatabase, stores: string[], callback: (record: string, index: number) => Promise<void>) {
  let digest = '', count = 0;
  for (const store of stores) {
    let after: IDBValidKey | undefined;
    for (;;) {
      const row = await new Promise<{key: IDBValidKey; value: unknown} | undefined>((resolve, reject) => {
        const request = db.transaction(store, 'readonly').objectStore(store).openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true));
        request.onsuccess = () => resolve(request.result ? {key: request.result.key, value: request.result.value} : undefined); request.onerror = () => reject(request.error);
      });
      if (!row) break; after = row.key;
      const text = JSON.stringify({store, key: row.key, value: row.value});
      digest = await sha(digest + await sha(text)); await callback(text, count++);
    }
  }
  return {digest, count};
}

/** Original IDB and metadata are retained. Only a verified transfer publishes host authority. */
export async function prepareCurrentArchive(progress: (message: string) => void): Promise<CompanionConnection> {
  const hostId = localStorage.getItem(selectedKey);
  if (hostId) return bridge({action: 'connect', archiveId: hostId});
  const session = activeWorkbenchSession() ?? availableWorkbenchSessions()[0];
  if (!session) {
    const result = await bridge({action: 'new'}); rememberHostArchive(result.archiveId); return result;
  }
  progress('正在迁移当前阅读存档；原浏览器记录完整保留。请先关闭仍在运行旧版的其它页面。');
  const metadata = workbenchSessions(), prepared = await bridge({action: 'prepare', session, metadata});
  const db = await sourceDatabase(session.id);
  try {
    const hasHead = db.objectStoreNames.contains('head') && !!await read(db, 'head', 'current');
    const stores = (hasHead ? ['head', 'entities', 'memoryBodies', 'memoryIndex', 'taskMaterials', 'textMeta', 'textChunks', 'observations'] : ['state', 'texts', 'memoryBodies', 'memoryIndex', 'taskMaterials', 'observations']).filter(name => db.objectStoreNames.contains(name));
    const first = await visit(db, stores, async (text, index) => {
      if (prepared.phase === 'verify-existing') return;
      const parts = Math.max(1, Math.ceil(text.length / 200000)), hash = await sha(text);
      for (let part = 0; part < parts; part++) await bridge({action: 'part', transferId: prepared.transferId, index, part, parts, hash, text: text.slice(part * 200000, (part + 1) * 200000)});
      if (index % 100 === 0) progress(`正在保存当前存档资料（${index + 1} 项）；原存档不变。`);
    });
    progress('正在核对迁移前后的完整资料摘要…');
    const second = await visit(db, stores, async () => {});
    if (JSON.stringify(first) !== JSON.stringify(second) || JSON.stringify(metadata) !== JSON.stringify(workbenchSessions())) throw Error('迁移时旧存档有了更新，请关闭旧版的其他页面后重新打开客户端，原资料仍保留。');
    const connection = await bridge({action: 'commit', archiveId: session.id, transferId: prepared.transferId, manifest: first});
    rememberHostArchive(session.id); return connection;
  } finally { db.close(); }
}
