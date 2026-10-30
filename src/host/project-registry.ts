import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, writeFile, realpath, readdir, lstat, copyFile} from 'node:fs/promises';
import {constants} from 'node:fs';
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
/** A book folder contains approved working files only; no archive/database copy. */
async function copyProjectFiles(source:string,target:string,top=true){
  for(const entry of await readdir(source,{withFileTypes:true})){
    // Runtime spill files stay beside their immutable session headers. They
    // are not working documents and may contain private preparation material.
    if(top&&['project.json','.dsh'].includes(entry.name.toLowerCase()))continue;
    const from=join(source,entry.name),to=join(target,entry.name);if(entry.isSymbolicLink())throw Error('书籍工程迁移不跟随链接：'+from);
    let existing;try{existing=await lstat(to);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(existing?.isSymbolicLink())throw Error('目标工程含链接，未覆盖：'+to);
    if(entry.isDirectory()){if(existing&&!existing.isDirectory())throw Error('目标工程有同名文件：'+to);await mkdir(to,{recursive:true});await copyProjectFiles(from,to,false);}
    else if(entry.isFile()){
      if(existing){if(!existing.isFile()||!Buffer.from(await readFile(from)).equals(Buffer.from(await readFile(to))))throw Error('目标工程有不同内容，未覆盖：'+to);}
      else await copyFile(from,to,constants.COPYFILE_EXCL);
    }else throw Error('书籍工程含不支持的文件：'+from);
  }
}
export class BookProjectRegistry implements ProjectRegistry {
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private ctx: Context, private archiveId: string, private directory: string) {}
  private get locationFile(){return join(dirname(dirname(this.directory)),'book-project-location.json');}
  private async rootDirectory():Promise<string>{
    const raw=await readOptional(this.locationFile);if(raw===undefined)return process.env.YIXU_BOOK_PROJECT_ROOT??join(homedir(),'Documents','宜序伴读','书籍工程');
    let value;try{value=JSON.parse(raw);}catch{throw Error('书籍工程位置记录无效，未改用默认目录');}
    if(value?.schema!=='yixu-book-project-location-v1'||!absoluteDirectory(value.rootDirectory))throw Error('书籍工程位置记录无效，未改用默认目录');
    const root=await realpath(value.rootDirectory);if(!(await lstat(root)).isDirectory())throw Error('已登记书籍工程位置不是文件夹');return root;
  }
  private async saveProjects(projects:BookProject[]){const file=join(this.directory,'book-projects.json');await writeFile(file+'.pending',JSON.stringify(projects),{mode:0o600});await rename(file+'.pending',file);}
  async getLocations():Promise<BookProjectLocations>{await this.writing;return{rootDirectory:await this.rootDirectory(),projects:await this.list()};}
  setRootDirectory(rootDirectory:string):Promise<BookProjectLocations>{
    const task=this.writing.then(async()=>{
      if(!absoluteDirectory(rootDirectory))throw Error('请选择完整的书籍工程文件夹路径');
      const requested=resolve(rootDirectory);await mkdir(requested,{recursive:true});const root=await realpath(requested),projects=await this.list();
      if(!(await lstat(root)).isDirectory())throw Error('书籍工程位置必须是文件夹');
      const prepared:BookProject[]=[];
      // Validate every destination before copying any existing project.
      for(const project of projects){
        const source=await realpath(project.directory),target=await destination(root,project,new Set(prepared.map(item=>item.directory.toLowerCase())));
        if(await readOptional(join(source,'project.json'))!==undefined)await checkIdentity(source,project);
        if(await samePhysicalPath(source,target)){prepared.push({...project,directory:source});continue;}
        if(contains(source,target)||contains(target,source))throw Error('书籍工程原位置与目标位置不能相互包含');
        let stat;try{stat=await lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(stat){if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('目标工程必须是普通文件夹：'+target);await checkIdentity(target,project,true);}
        prepared.push({...project,directory:target});
      }
      for(const project of prepared){const original=projects.find(item=>item.id===project.id)!;if(await samePhysicalPath(original.directory,project.directory)){await writeIdentity(project.directory,project);continue;}
        await mkdir(project.directory,{recursive:true});await writeIdentity(project.directory,project);await copyProjectFiles(original.directory,project.directory);
      }
      // Only the book registry changes; immutable native cwd/workspace and originals stay.
      await writeFile(this.locationFile+'.pending',JSON.stringify({schema:'yixu-book-project-location-v1',rootDirectory:root}),{mode:0o600});
      await this.saveProjects(prepared);
      try{await rename(this.locationFile+'.pending',this.locationFile);}catch(error){await this.saveProjects(projects);throw error;}
      return{rootDirectory:root,projects:prepared};
    });this.writing=task.catch(()=>{});return task;
  }
  async list(): Promise<BookProject[]> {
      const raw=await readOptional(join(this.directory,'book-projects.json'));if(raw===undefined)return[];
      const values = JSON.parse(raw);
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
      if(previous&&previous.title===book.title&&previous.contentVersion===book.version&&this.ctx.workspaceRegistry.get(previous.workspaceId as never))return previous;
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
      if (previous && previous.workspaceId !== workspace.id) throw Error('书籍工程Workspace映射发生变化，须明确迁移');
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
      const previous=projects.find(item=>item.partnerId===partner.id),expectedDirectory=join(this.directory,'partners',projectId(this.archiveId,partner.id));
      if(previous&&!(await samePhysicalPath(previous.directory,expectedDirectory)))throw Error('伙伴工程登记身份不符');
      if(previous&&previous.name===partner.name&&this.ctx.workspaceRegistry.get(previous.workspaceId as never))return;
      const directory=previous?.directory??expectedDirectory;await mkdir(directory,{recursive:true});
      const workspace=await this.ctx.workspaceRegistry.create(directory,partner.name+' · 个人阅读资料');
      const next=[...projects.filter(item=>item.partnerId!==partner.id),{partnerId:partner.id,directory,workspaceId:workspace.id,name:partner.name}];
      await writeFile(file+'.pending',JSON.stringify(next),{mode:0o600});await rename(file+'.pending',file);
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
