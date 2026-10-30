import {readFileSync, mkdirSync, statSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {dirname,resolve} from 'node:path';
import type {WorkbenchSession} from '../workbench/contract.ts';
import type {WorkbenchSessionRepository} from '../workbench/environment.ts';

const connections=new Map<string,DatabaseSync>();
type SessionCatalog={sessions:WorkbenchSession[];activeId?:string};
const databasePath=(filename:string)=>resolve(filename.replace(/\.json$/i,'')+'.sqlite');
function validateCatalog(value:unknown):SessionCatalog{
  const catalog=value as SessionCatalog;
  if(!catalog||!Array.isArray(catalog.sessions)||catalog.sessions.some(session=>!session||typeof session.id!=='string')||(catalog.activeId!==undefined&&typeof catalog.activeId!=='string'))throw Error('阅读存档目录无效');
  return catalog;
}
/** Shared archive metadata uses SQLite transactions; the original JSON is retained. */
export class SessionRepository implements WorkbenchSessionRepository {
  private db:DatabaseSync;
  /** Inspect startup authority without creating a database or repairing a lost index. */
  static readCatalog(filename:string):SessionCatalog|undefined{
    const database=databasePath(filename);
    try{statSync(database);}catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      try{return validateCatalog(JSON.parse(readFileSync(filename,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    }
    const db=new DatabaseSync(database,{readOnly:true});
    try{
      if(db.prepare("SELECT value FROM catalog_meta WHERE key='initialized'").get()?.value!=='1')throw Error('阅读存档目录尚未完整保存，未创建替代空档');
      const sessions=db.prepare('SELECT json FROM archive_catalog ORDER BY ordering DESC,id').all().map(row=>JSON.parse(String(row.json)) as WorkbenchSession);
      const activeId=db.prepare("SELECT value FROM catalog_meta WHERE key='activeId'").get()?.value;
      return validateCatalog({sessions,...(activeId!==undefined?{activeId}: {})});
    }finally{db.close();}
  }
  constructor(filename: string, private exportArchive: (id: string) => Promise<string>) {
    const database=databasePath(filename);mkdirSync(dirname(database),{recursive:true});
    let db=connections.get(database);if(!db){db=new DatabaseSync(database);db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS archive_catalog(id TEXT PRIMARY KEY,json TEXT NOT NULL,ordering INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS catalog_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');connections.set(database,db);}this.db=db;
    this.transaction(()=>{
      if(this.db.prepare("SELECT 1 FROM catalog_meta WHERE key='initialized'").get())return;
      let old:SessionCatalog={sessions:[]};try{old=validateCatalog(JSON.parse(readFileSync(filename,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      for(let index=0;index<old.sessions.length;index++)this.db.prepare('INSERT INTO archive_catalog VALUES(?,?,?)').run(old.sessions[index].id,JSON.stringify(old.sessions[index]),old.sessions.length-index);
      if(old.activeId)this.meta('activeId',old.activeId);this.meta('sequence',String(old.sessions.length));this.meta('initialized','1');
    });
  }
  private transaction<T>(work:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const value=work();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private meta(key:string,value:string){this.db.prepare('INSERT INTO catalog_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  list() { return this.db.prepare('SELECT json FROM archive_catalog ORDER BY ordering DESC,id').all().map(row=>JSON.parse(String(row.json)) as WorkbenchSession); }
  available() { return this.list().filter(session => !session.archivedAt); }
  active() { const row=this.db.prepare("SELECT value FROM catalog_meta WHERE key='activeId'").get();return row?this.available().find(session=>session.id===row.value):undefined; }
  remember(session: WorkbenchSession) { this.transaction(()=>{const previous=this.list().find(item=>item.id===session.id),sequence=Number(this.db.prepare("SELECT value FROM catalog_meta WHERE key='sequence'").get()?.value??0)+1;this.meta('sequence',String(sequence));this.db.prepare('INSERT INTO archive_catalog VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,ordering=excluded.ordering').run(session.id,JSON.stringify({...session,...(previous?.archivedAt?{archivedAt:previous.archivedAt}:{})}),sequence);}); }
  markActive(id: string) { this.transaction(()=>{if (!this.available().some(session => session.id === id)) throw Error('阅读存档不存在或已归档');this.meta('activeId',id);}); }
  archive(ids: readonly string[], currentId: string) {
    const selected = new Set(ids); if (selected.has(currentId)) throw Error('当前阅读存档不能归档');
    return this.transaction(()=>{let count=0;const at=Date.now();for(const session of this.list())if(selected.has(session.id)&&!session.archivedAt){this.db.prepare('UPDATE archive_catalog SET json=? WHERE id=?').run(JSON.stringify({...session,archivedAt:at}),session.id);count++;}return count;});
  }
  async flush() {}
  exportArchivedBackup(id: string) { if (!this.list().some(session => session.id === id && session.archivedAt)) throw Error('归档存档不存在'); return this.exportArchive(id); }
}
