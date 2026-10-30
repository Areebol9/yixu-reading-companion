import {readFile, mkdir, writeFile, symlink, realpath, stat,lstat,readlink,unlink,rename} from 'node:fs/promises';
import {resolve, dirname, join, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {bindNativeHome} from '../../src/host/native-home.ts';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const version = '0.2.1-rc.2';
const directCli = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function argumentsOf(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--archive', '--domain-module', '--dsh-package', '--data-root', '--home', '--port', '--origin'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('宿主参数无效：' + key);
    if (key === '--origin') (values.origins ??= []).push(args[++i]);
    else { if (Object.hasOwn(values, key)) throw Error('重复宿主参数：' + key); values[key] = args[++i]; }
  }
  if (!/^[a-z0-9-]{1,100}$/i.test(values['--archive'] ?? '')) throw Error('请用--archive指定原阅读存档ID');
  if (!values['--domain-module']) throw Error('需要--domain-module指向宿主领域工厂；不会回退浏览器执行');
  return values;
}
async function exactTemplate(source, destination) {
  const expected = await readFile(source, 'utf8');
  try { const current = await readFile(destination, 'utf8'); if (current !== expected) throw Error('专用profile已有不同配置，未覆盖：' + destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(destination, expected, {flag: 'wx', mode: 0o600}); }
}
/** Only these declared profile resources can move with a desktop release. */
export async function ensureCompanionResourceLink(link,target,name){
  if(!['@yixu/dsh-companion-bundle','@yixu/dsh-companion-host'].includes(name))throw Error('未知宿主资源包');
  const canonicalTarget=await realpath(target),recordFile=link+'.managed.json';
  const checkPackage=async directory=>{const metadata=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));if(metadata.name!==name||metadata.private!==true||metadata.version!==version)throw Error('宿主资源包身份不符，原链接保持');return metadata;};
  await checkPackage(canonicalTarget);
  let existing;try{existing=await lstat(link);}catch(error){if(error.code!=='ENOENT')throw error;}
  let previousTarget;
  if(existing){
    if(!existing.isSymbolicLink())throw Error('宿主资源位置已有真实目录或文件，未替换');
    previousTarget=resolve(dirname(link),await readlink(link));
    // A recorded junction remains identifiable after the old program folder moves.
    try{await checkPackage(link);}
    catch(error){
      if(error.code!=='ENOENT')throw error;
      let record;try{record=JSON.parse(await readFile(recordFile,'utf8'));}catch{throw Error('原资源链接来源不明，未替换');}
      if(record.schema!=='yixu-profile-resource-link-v1'||record.name!==name||record.version!==version||record.kind!==(process.platform==='win32'?'junction':'dir')||resolve(record.target)!==previousTarget)throw Error('原资源链接身份不符，未替换');
    }
    if(previousTarget!==canonicalTarget){
      // unlink removes this verified link only; package contents and archive data stay put.
      await unlink(link);
      try{await symlink(canonicalTarget,link,process.platform==='win32'?'junction':'dir');}
      catch(error){await symlink(previousTarget,link,process.platform==='win32'?'junction':'dir').catch(()=>{});throw error;}
    }
  }else await symlink(canonicalTarget,link,process.platform==='win32'?'junction':'dir');
  const record={schema:'yixu-profile-resource-link-v1',name,version,kind:process.platform==='win32'?'junction':'dir',target:canonicalTarget};
  await writeFile(recordFile+'.pending',JSON.stringify(record),{mode:0o600});await rename(recordFile+'.pending',recordFile);
}

/** Invoke the original DSH bin, not a reconstructed Cordis boot loop. */
export async function startCompanionHost(args = process.argv.slice(2)) {
  const options = argumentsOf(args);
  const dataRoot = resolve(workspaceRoot, options['--data-root'] ?? '.local/companion-host/data');
  const home = resolve(workspaceRoot, options['--home'] ?? '.local/companion-host/dsh-home');
  // Never accept the normal shared home by accidental environment inheritance.
  const inside=(parent,path)=>{const child=relative(parent,path);return !!child&&!child.startsWith('..')&&!isAbsolute(child);};
  const desktopRoot=process.env.YIXU_DESKTOP==='1'&&process.env.YIXU_CLIENT_DATA_ROOT?resolve(process.env.YIXU_CLIENT_DATA_ROOT):undefined;
  if (!inside(join(workspaceRoot,'.local'),home)&&!(desktopRoot&&inside(desktopRoot,dataRoot)&&inside(desktopRoot,home))) throw Error('专用宿主home须在本项目.local或明确客户端数据目录内，不能采用共享DSH_HOME');
  const nativeBinding=await bindNativeHome(dataRoot,home);
  const packageFile = options['--dsh-package'] ? join(resolve(options['--dsh-package']), 'package.json') : require.resolve('@deepseek-ai/dsh/package.json');
  const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== version) throw Error('伴读宿主要求官方DSH ' + version);
  const bin = resolve(dirname(packageFile), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.dsh);
  const domainModule = resolve(workspaceRoot, options['--domain-module']);
  if (!(await stat(domainModule)).isFile()) throw Error('宿主领域模块不可用');
  const port = Number(options['--port'] ?? 0);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw Error('宿主端口无效');
  for (const origin of options.origins ?? []) { const url = new URL(origin); if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.origin !== origin) throw Error('仅允许明确的本机页面Origin'); }
  const profile = join(home, 'profiles', 'companion');
  await mkdir(join(profile, 'node_modules', '@yixu'), {recursive: true});
  await exactTemplate(join(workspaceRoot, 'dsh/profile/package.json'), join(profile, 'package.json'));
  await exactTemplate(join(workspaceRoot, 'dsh/profile/cordis.patch.yml'), join(profile, 'cordis.patch.yml'));
  const bundle = join(workspaceRoot, 'dsh/bundle'), link = join(profile, 'node_modules/@yixu/dsh-companion-bundle');
  await ensureCompanionResourceLink(link,bundle,'@yixu/dsh-companion-bundle');
  const plugin=join(workspaceRoot,'dsh/plugin'),pluginLink=join(profile,'node_modules/@yixu/dsh-companion-host');
  await ensureCompanionResourceLink(pluginLink,plugin,'@yixu/dsh-companion-host');
  const diagnostics = join(dataRoot, 'archives', options['--archive'], 'diagnostics');
  await mkdir(diagnostics, {recursive: true, mode: 0o700});
  const child = spawn(process.execPath, ['--report-on-fatalerror', '--report-exclude-env', '--report-directory='+diagnostics, '--experimental-transform-types', bin, '--profile', 'companion'], {
    cwd: workspaceRoot, stdio: 'inherit', windowsHide: true,
    env: {...process.env, DSH_HOME: nativeBinding.nativeHome, DSH_TELEMETRY_DISABLED: '1',
      YIXU_COMPANION_DATA_ROOT: dataRoot, YIXU_COMPANION_ARCHIVE_ID: options['--archive'],
      YIXU_COMPANION_DOMAIN_MODULE: domainModule, YIXU_COMPANION_HOST_PORT: String(port),
      YIXU_COMPANION_ORIGINS: JSON.stringify(options.origins ?? [])},
  });
  // Console signals also reach the non-detached official launcher. Do not emulate
  // a Windows signal with child.kill(), which would bypass domain collection.
  if (directCli) {
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  }
  return child;
}
if (directCli) startCompanionHost().catch(error => { console.error(error.message); process.exitCode = 1; });
