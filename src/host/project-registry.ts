import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, writeFile, realpath, readdir, lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, dirname, resolve, relative, isAbsolute} from 'node:path';
import type {Context} from '@deepseek-ai/cordis';
import type {SessionId} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-workspace';
import type {BookProject, BookProjectLocations, ProjectRegistry} from './contract.ts';
import {samePhysicalPath} from './path-identity.ts';

/** Stable book identity is archive+book, not filename, position or version. */
export function projectId(archiveId: string, bookId: string): string {
  return createHash('sha256').update(JSON.stringify([archiveId, bookId])).digest('hex');
}
const absoluteDirectory=(value:unknown):value is string=>typeof value==='string'&&/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(value);
const contains=(parent:string,child:string)=>{const part=relative(parent,child);return part===''||(!/^\.\.(?:[\\/]|$)/.test(part)&&!isAbsolute(part));};
const identity=(project:Pick<BookProject,'id'|'archiveId'|'bookId'>)=>({schema:'yixu-book-project-folder-v1',id:project.id,archiveId:project.archiveId,bookId:project.bookId});
function bookFolderName(title:string){
  const name=title.replace(/[<>:"/\\|?*\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim().slice(0,80).replace(/[. ]+$/,'')||'未命名书籍';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)?'书籍 '+name:name;
}
async function destination(root:string,project:Pick<BookProject,'id'|'archiveId'|'bookId'|'title'>,reserved:ReadonlySet<string>=new Set()){
  const name=bookFolderName(project.title);
  for(const folder of [name,name+' ('+project.id.slice(0,8)+')']){
    const target=join(root,folder);if(reserved.has(target.toLowerCase()))continue;let entries;
    try{const stat=await lstat(target);if(!stat.isDirectory()||stat.isSymbolicLink())continue;entries=await readdir(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return target;throw error;}
    if(!entries.length)return target;
    const raw=await readOptional(join(target,'project.json'));if(!raw)continue;
    try{const value=JSON.parse(raw);if(Object.entries(identity(project)).every(([key,item])=>value[key]===item))return target;}catch{/* An unrelated folder is never overwritten. */}
  }
  throw Error('所选位置已有同名文件夹，请选择其他位置。');
}
async function readOptional(file:string):Promise<string|undefined>{try{return await readFile(file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}}
async function checkIdentity(directory:string,project:Pick<BookProject,'id'|'archiveId'|'bookId'>,allowEmpty=false){
  const marker=await readOptional(join(directory,'project.json'));
  if(marker!==undefined){let parsed;try{parsed=JSON.parse(marker);}catch{throw Error('书籍工程目录身份文件无效：'+directory);}const expected=identity(project);if(Object.entries(expected).some(([key,value])=>parsed?.[key]!==value))throw Error('目标文件夹属于其他书籍：'+directory);return;}
  if(allowEmpty&&(await readdir(directory)).length===0)return;
  throw Error('目标文件夹非空且未登记为本书工程：'+directory);
}
async function writeIdentity(directory:string,project:Pick<BookProject,'id'|'archiveId'|'bookId'>){
  const marker=join(directory,'project.json');if(await readOptional(marker)!==undefined){await checkIdentity(directory,project);return;}
  await writeFile(marker,JSON.stringify(identity(project),null,2)+'\n',{flag:'wx',mode:0o600});
}
export class BookProjectRegistry implements ProjectRegistry {
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private ctx: Context, private archiveId: string, private directory: string) {}
  private get locationFile(){return join(dirname(dirname(this.directory)),'book-project-location.json');}
  private get openedProjectDirectory(){return process.env.YIXU_OPENED_PROJECT_DIRECTORY?resolve(process.env.YIXU_OPENED_PROJECT_DIRECTORY):undefined;}
  private async rootDirectory():Promise<string>{
    if(this.openedProjectDirectory)return join(this.openedProjectDirectory,'work');
    const raw=await readOptional(this.locationFile);if(raw===undefined)return process.env.YIXU_BOOK_PROJECT_ROOT??join(homedir(),'Documents','宜序伴读','书籍工程');
    let value;try{value=JSON.parse(raw);}catch{throw Error('书籍工程位置记录无效，未改用默认目录');}
    if(value?.schema!=='yixu-book-project-location-v1'||!absoluteDirectory(value.rootDirectory))throw Error('书籍工程位置记录无效，未改用默认目录');
    const root=await realpath(value.rootDirectory);if(!(await lstat(root)).isDirectory())throw Error('已登记书籍工程位置不是文件夹');return root;
  }
  private async saveProjects(projects:BookProject[]){const file=join(this.directory,'book-projects.json'),root=this.openedProjectDirectory;const saved=root?projects.map(project=>({...project,directory:relative(root,project.directory),executionDirectory:relative(root,project.executionDirectory),pathFormat:'project-relative-v1'})):projects;await writeFile(file+'.pending',JSON.stringify(saved),{mode:0o600});await rename(file+'.pending',file);}
  async getLocations():Promise<BookProjectLocations>{await this.writing;return{rootDirectory:await this.rootDirectory(),projects:await this.list(),...(this.openedProjectDirectory?{openedProjectDirectory:this.openedProjectDirectory}:{})};}
  async list(): Promise<BookProject[]> {
      const raw=await readOptional(join(this.directory,'book-projects.json'));if(raw===undefined)return[];
      const values = JSON.parse(raw);
      if(this.openedProjectDirectory&&Array.isArray(values))for(const value of values){
        if(value.pathFormat!=='project-relative-v1'||typeof value.directory!=='string'||typeof value.executionDirectory!=='string')throw Error('该工程的位置登记格式无法识别');
        value.directory=resolve(this.openedProjectDirectory,value.directory);value.executionDirectory=resolve(this.openedProjectDirectory,value.executionDirectory);
        if(!contains(this.openedProjectDirectory,value.directory)||!contains(this.openedProjectDirectory,value.executionDirectory))throw Error('工程工作文件应在所选工程文件夹内');
      }
      if (!Array.isArray(values) || values.some(p => p.schema !== 'yixu-book-project-v1' || p.archiveId !== this.archiveId || p.id !== projectId(this.archiveId, p.bookId))) throw Error('书籍工程登记身份不符');
      for(const project of values){const expected=join(this.directory,'books',project.id);project.executionDirectory??=project.directory;
        if(!absoluteDirectory(project.directory)||!absoluteDirectory(project.executionDirectory)||!(await samePhysicalPath(project.executionDirectory,expected)))throw Error('书籍工程登记身份不符');
        if(!(await lstat(project.directory)).isDirectory())throw Error('书籍工程文件夹不可用：'+project.directory);
        if(!(await samePhysicalPath(project.directory,project.executionDirectory)))await checkIdentity(project.directory,project);
      }
      return values;
  }
  ensure(book: {id: string; title: string; version: string}): Promise<BookProject> {
    const task = this.writing.then(async () => {
      if (!book.id || !book.title || !book.version) throw Error('书籍工程需要作品身份、标题及版本');
      const projects = await this.list(), id = projectId(this.archiveId, book.id);
      const previous = projects.find(p => p.id === id);
      const previousWorkspace=previous&&this.ctx.workspaceRegistry.get(previous.workspaceId as never);
      if(previous&&previous.title===book.title&&previous.contentVersion===book.version&&previousWorkspace&&(previousWorkspace.path===previous.executionDirectory||await samePhysicalPath(previousWorkspace.path,previous.executionDirectory)))return previous;
      const executionDirectory=previous?.executionDirectory??join(this.directory,'books',id);
      const directory = previous?.directory??await destination(await this.rootDirectory(),{id,archiveId:this.archiveId,bookId:book.id,title:book.title});
      if(!previous){let stat;try{stat=await lstat(directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(stat){if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('书籍工程必须是普通文件夹：'+directory);await checkIdentity(directory,{id,archiveId:this.archiveId,bookId:book.id},true);}}
      await mkdir(directory, {recursive: true});
      await mkdir(executionDirectory,{recursive:true});
      await writeIdentity(directory,{id,archiveId:this.archiveId,bookId:book.id});
      // Official WorkspaceRegistry owns canonical paths and native Session membership.
      const workspace = await this.ctx.workspaceRegistry.create(executionDirectory, book.title);
      const project: BookProject = {schema: 'yixu-book-project-v1', id, archiveId: this.archiveId, bookId: book.id, title: book.title, contentVersion: book.version, directory, executionDirectory, workspaceId: workspace.id};
      if (previous && previous.workspaceId !== workspace.id&&!this.openedProjectDirectory) throw Error('书籍工程Workspace映射发生变化，须明确迁移');
      const next = [...projects.filter(p => p.id !== id), project];
      await this.saveProjects(next);
      return project;
    });
    this.writing = task.catch(() => {}); return task;
  }
  ensurePartner(partner:{id:string;name:string}):Promise<void>{
    const task=this.writing.then(async()=>{
      const file=join(this.directory,'partner-projects.json');let projects:{partnerId:string;directory:string;workspaceId:string;name:string}[]=[];
      try{projects=JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const root=this.openedProjectDirectory;
      if(root)for(const project of projects){project.directory=resolve(root,project.directory);if(!contains(root,project.directory))throw Error('伙伴资料应在所选工程文件夹内');}
      const previous=projects.find(item=>item.partnerId===partner.id),expectedDirectory=join(this.directory,'partners',projectId(this.archiveId,partner.id));
      if(previous&&!(await samePhysicalPath(previous.directory,expectedDirectory)))throw Error('伙伴工程登记身份不符');
      const previousWorkspace=previous&&this.ctx.workspaceRegistry.get(previous.workspaceId as never);
      if(previous&&previous.name===partner.name&&previousWorkspace&&(previousWorkspace.path===expectedDirectory||await samePhysicalPath(previousWorkspace.path,expectedDirectory)))return;
      const directory=previous?.directory??expectedDirectory;await mkdir(directory,{recursive:true});
      const workspace=await this.ctx.workspaceRegistry.create(directory,partner.name+' · 个人阅读资料');
      const next=[...projects.filter(item=>item.partnerId!==partner.id),{partnerId:partner.id,directory,workspaceId:workspace.id,name:partner.name}];
      await writeFile(file+'.pending',JSON.stringify(root?next.map(item=>({...item,directory:relative(root,item.directory)})):next),{mode:0o600});await rename(file+'.pending',file);
    });this.writing=task.catch(()=>{});return task;
  }
  async attachSession(bookId: string, sessionId: string): Promise<void> {
    await this.writing;
    const project = (await this.list()).find(p => p.bookId === bookId);
    if (!project) throw Error('任务没有对应书籍工程');
    const workspace = this.ctx.workspaceRegistry.get(project.workspaceId as never);
    if (!workspace) throw Error('书籍工程Workspace不可用');
    // attachSession validates the actual persisted header cwd; no fabricated membership.
    await workspace.attachSession(sessionId as SessionId);
  }
}
