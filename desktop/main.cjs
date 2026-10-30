'use strict';
const {app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, shell} = require('electron');
const {spawn} = require('node:child_process');
const {existsSync, mkdirSync, createWriteStream, readFileSync, writeFileSync, renameSync} = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const {clientPaths} = require('./runtime.cjs');
const {readReadingProject, selectedReadingProject, saveReadingProjectSelection, readingProjectEnvironment} = require('./project-location.cjs');
app.setName('宜序伴读');
app.setAppUserModelId('org.yixu.reading-companion');
let language = 'zh-CN', languageSelected = false;
const normalizeLanguage = value => typeof value === 'string' && /^en(?:-|$)/i.test(value) ? 'en' : 'zh-CN';
const t = (zh, en) => language === 'en' ? en : zh;
const appTitle = () => t('宜序伴读', 'Yixu Reading Companion');
const initiallyHeadless = (process.argv.includes('--headless') || process.argv.includes('--yixu-headless')) && !process.argv.includes('--show');
function projectIntentFromArgs(argv) {
  const directory = argv.find(value => value.startsWith('--yixu-open-project='));
  const request = argv.find(value => value.startsWith('--yixu-project-request='));
  const requestId = request?.slice('--yixu-project-request='.length);
  return directory ? {action: 'open-project', directory: directory.slice('--yixu-open-project='.length), requestId} : argv.includes('--yixu-local-library') ? {action: 'local-library', requestId} : null;
}
const launchProjectIntent = projectIntentFromArgs(process.argv);
// This is an app mode; Chromium's native --headless would prevent later GUI display.
app.commandLine.removeSwitch('headless');
const root = path.resolve(__dirname, '..');
// The app owns one instance per OS user, independently of archive/profile paths.
// Capture that identity before selecting a browser profile or creating any data.
const instanceProfile = path.join(app.getPath('home'), '.yixu-reading', 'desktop-instance');
mkdirSync(instanceProfile, {recursive: true});
app.setPath('userData', instanceProfile);
const primary = app.requestSingleInstanceLock({show: !initiallyHeadless, project: launchProjectIntent});
let config;
if (!primary) app.quit();
else {
  try { config = clientPaths(root); } catch (error) { app.whenReady().then(() => { language = normalizeLanguage(app.getLocale()); if (initiallyHeadless) console.error(error.message); else dialog.showErrorBox(t('宜序伴读启动未完成', 'Yixu Reading Companion Could Not Start'), error.message); app.exit(1); }); }
  if (config) {
    mkdirSync(config.profile, {recursive: true});
    try { const saved = JSON.parse(readFileSync(path.join(config.profile, 'interface-language.json'), 'utf8')); if (saved.language === 'en' || saved.language === 'zh-CN') { language = saved.language; languageSelected = true; } } catch { /* First launch uses the system language. */ }
    app.setPath('userData', config.profile); app.setPath('sessionData', config.profile);
    run();
  }
}
function run() {
  const developerMode = process.argv.includes('--developer');
  let openRequested = !initiallyHeadless, readerReady = false;
  let window, child, childExit, tray, readyURL, startupFailed = false, quitting = false, allowQuit = false, closing = false, statusTimer, switching = false, readingProject;
  let startupStatus = {phase: 'starting', message: ''};
  let startupFinished = false, deferredProjectIntent, projectRequest = {};
  const requests = new Map(), autoRequests = new Map();
  function state() { return {visible: !!window && !window.isDestroyed() && window.isVisible() && !window.isMinimized(), focused: !!window && !window.isDestroyed() && window.isFocused(), minimized: !!window && !window.isDestroyed() && window.isMinimized(), headless: !openRequested, trayAvailable: !!tray && !tray.isDestroyed(), readerReady, developerMode, readingProjectOpen: !!readingProject, switching, startupFailed, projectSelectionRequestId: projectRequest.id, projectSelectionError: projectRequest.error}; }
  function publish() { if (window && !window.isDestroyed()) window.webContents.send('yixu:window-state-changed', state()); }
  function showWindow() { openRequested = true; if (!window || window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); cancelBackgroundExit(); publish(); }
  function cancelBackgroundExit() { if (statusTimer) clearInterval(statusTimer); statusTimer = undefined; }
  function destroyTray() { if (tray) { tray.destroy(); tray = undefined; } cancelBackgroundExit(); }
  function updateMenus() {
    const items = [{label: t('文件', 'File'), submenu: [{label: t('打开书籍工程', 'Open Book Project'), enabled: !switching && !quitting, click: () => void chooseAndOpenReadingProject()}, {label: t('返回本机书架', 'Return to Local Library'), enabled: !switching && !quitting, click: () => { try { acceptReadingProject(null); } catch (error) { failed(error); } }}, {type: 'separator'}, {label: t('打开数据目录', 'Open Data Folder'), click: () => shell.openPath(config.dataRoot)}, {type: 'separator'}, {label: t('暂停后台处理', 'Pause Background Work'), enabled: !switching, click: pauseBackground}, {label: t('保存并退出', 'Save and Quit'), enabled: !switching, click: () => exitGracefully()}]}, {label: t('视图', 'View'), submenu: [{role: 'reload', label: t('刷新', 'Reload')}, {role: 'resetZoom', label: t('实际大小', 'Actual Size')}, {role: 'zoomIn', label: t('放大', 'Zoom In')}, {role: 'zoomOut', label: t('缩小', 'Zoom Out')}, {role: 'togglefullscreen', label: t('全屏', 'Full Screen')}, ...(developerMode ? [{role: 'toggleDevTools', label: t('开发者工具', 'Developer Tools')}] : [])]}];
    Menu.setApplicationMenu(Menu.buildFromTemplate(items));
    if (tray) { tray.setToolTip(appTitle()); tray.setContextMenu(Menu.buildFromTemplate([{label: t('打开宜序伴读', 'Open Yixu Reading Companion'), click: showWindow}, {label: t('保存并退出', 'Save and Quit'), click: () => exitGracefully()}])); }
  }
  function ensureTray() {
    if (!tray) {
      tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'app-icon-32.png')));
      updateMenus();
      tray.on('double-click', showWindow); tray.on('click', showWindow);
    }
  }
  function hideWindow() { openRequested = false; cancelBackgroundExit(); ensureTray(); window?.hide(); publish(); }
  function background() {
    ensureTray(); window.hide(); publish();
    if (!statusTimer) statusTimer = setInterval(async () => {
      try { if (!busy(await rpc('status'))) await exitGracefully(false); } catch { /* Keep a reachable tray when saving failed. */ }
    }, 2500);
  }
  function handleNativeControl(message, sender) {
    if (typeof message.id !== 'string' || !sender.connected) return;
    const respond = value => sender.send({type: 'native-response', id: message.id, value});
    if (message.action === 'status') return respond({...state(), quitting});
    if (message.action === 'open-project' || message.action === 'local-library') {
      try { return respond(acceptReadingProject(message.action === 'local-library' ? null : message.data?.directory)); }
      catch (error) { return sender.send({type: 'native-response', id: message.id, error: error.message}); }
    }
    if (message.action === 'open') {
      showWindow();
      const deadline = Date.now() + 3000;
      const confirm = () => {
        const current = state();
        if (current.visible) return respond({...current, accepted: true});
        if (Date.now() >= deadline) return child?.connected && child.send({type: 'native-response', id: message.id, error: '暂时无法确认阅读窗口是否已打开，请查看窗口状态后再操作。'});
        setTimeout(confirm, 25);
      };
      confirm(); return;
    }
    if (message.action === 'start-auto-reading') {
      if (!readyURL || !window || window.isDestroyed()) return child.send({type: 'native-response', id: message.id, error: '阅读页面尚未就绪。'});
      if (!readerReady) return child.send({type: 'native-response', id: message.id, error: '阅读页面正在准备，请稍后启动自动阅读。'});
      if (autoRequests.size) return child.send({type: 'native-response', id: message.id, error: '正在启动自动阅读，请等待完成。'});
      const id = randomUUID();
      const finish = result => {
        const pending = autoRequests.get(id); if (!pending) return;
        clearTimeout(pending.timer); autoRequests.delete(id);
        if (child?.connected) child.send({type: 'native-response', id: message.id, ...(result.ok ? {value: result} : {error: result.error || '自动阅读启动未完成。'})});
      };
      const timer = setTimeout(() => finish({ok: false, error: '暂时无法确认自动阅读是否已启动，请查看当前状态后再操作。'}), 90000);
      autoRequests.set(id, {timer, finish});
      const dispatch = () => { if (autoRequests.has(id)) window.webContents.send('yixu:auto-reading-request', {id, settings: message.data}); };
      if (window.webContents.isLoading()) window.webContents.once('did-finish-load', dispatch); else dispatch();
      return;
    }
    if (message.action === 'archive-changed') { window?.webContents.reload(); return respond({...state(), accepted: true}); }
    if (message.action === 'hide') {
      hideWindow();
      return respond({...state(), accepted: true});
    }
    if (message.action === 'quit') {
      if (switching) return sender.send({type: 'native-response', id: message.id, error: t('正在打开工程，请等待完成后再退出。', 'A project is opening. Wait for it to finish before quitting.')});
      respond({accepted: true, quitting: true});
      setImmediate(() => void exitGracefully(false));
      return;
    }
    child.send({type: 'native-response', id: message.id, error: '未知原生窗口操作。'});
  }
  function rpc(action) {
    if (!child?.connected) return Promise.reject(Error(t('后台服务连接已中断；存档保持，请重新打开客户端检查。', 'The background service is disconnected. Your saved data is retained. Reopen the app to check.')));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = action === 'shutdown' ? undefined : setTimeout(() => { requests.delete(id); reject(Error(t('后台状态暂时未返回，请稍后重试。', 'The background service has not returned its status. Please try again shortly.'))); }, 15000);
      requests.set(id, {resolve, reject, timer, child}); child.send({type: 'control', id, action});
    });
  }
  function busy(value) {
    return value.hosts.some(host => {
      const life = host;
      if (!life) return true;
      return life.busy === true || !['ready', 'closed'].includes(life.phase) || life.activeCommands > 0 || life.transfers > 0 || life.inFlight > 0 || life.following === true;
    });
  }
  async function exitGracefully(foreground = true) {
    if (quitting || switching) return;
    quitting = true;
    if (foreground) showWindow();
    window?.setTitle(startupFailed ? t('正在退出 · 宜序伴读', 'Quitting · Yixu Reading Companion') : t('正在等待回复并保存，请稍候 · 宜序伴读', 'Waiting for Replies and Saving · Yixu Reading Companion')); window?.setProgressBar(2);
    window?.webContents.send('yixu:lifecycle-status', {phase: 'saving', message: t('正在等待已发出的回复并保存，完成后自动退出。', 'Waiting for pending replies and saving. The app will quit when finished.')});
    try {
      if (child?.connected) await rpc('shutdown');
      const ended = childExit ? await childExit : {code: 0}; if (ended.code !== 0 && !startupFailed) throw Error(t('后台服务未正常退出，原存档已保留。', 'The background service did not exit normally. Your saved reading data is retained.'));
      window?.webContents.session.flushStorageData();
      destroyTray(); allowQuit = true; app.quit();
    } catch (error) {
      quitting = false; closing = false; if (openRequested) showWindow(); window?.setProgressBar(-1); window?.setTitle(appTitle());
      window?.webContents.send('yixu:lifecycle-status', {phase: 'error', message: error.message});
      if (!openRequested) { console.error('保存退出尚未完成：' + error.message); return; }
      await dialog.showMessageBox(window, {type: 'error', title: t('保存退出尚未完成', 'Save and Quit Could Not Finish'), message: error.message, detail: t('窗口和原记录保持，请检查后台状态后再次退出。', 'Your window and records are retained. Check background activity, then try quitting again.'), buttons: [t('返回客户端', 'Return to App')]});
    }
  }
  async function pauseBackground(item) {
    if (quitting || switching) return;
    item.enabled = false;
    try {
      await rpc('pause');
      window?.setTitle(t('后台已暂停，正在等待回复并保存 · 宜序伴读', 'Background Paused, Saving Replies · Yixu Reading Companion'));
      window?.webContents.send('yixu:lifecycle-status', {phase: 'paused', message: t('后台已暂停。已发出的回复仍会接收并保存；点击阅读界面的“继续伴读”可继续。', 'Background work is paused. Pending replies will still be received and saved. Select Resume Companion in the reading view to continue.')});
    } catch (error) {
      showWindow();
      await dialog.showMessageBox(window, {type: 'error', title: t('暂停后台尚未完成', 'Background Work Could Not Pause'), message: error.message, buttons: [t('返回客户端', 'Return to App')]});
    } finally { item.enabled = true; }
  }
  async function requestClose() {
    if (quitting || closing || switching) return;
    closing = true;
    try {
      if (!child || child.exitCode !== null) { quitting = true; allowQuit = true; app.quit(); return; }
      if (initiallyHeadless) { closing = false; hideWindow(); return; }
      if (!openRequested) { closing = false; await exitGracefully(false); return; }
      const status = await rpc('status');
      if (!busy(status)) { closing = false; await exitGracefully(); return; }
      const {response} = await dialog.showMessageBox(window, {type: 'question', title: t('仍有后台工作', 'Background Work Is Still Running'), message: t('伙伴仍在回应或整理阅读内容。', 'Your companion is still replying or organizing reading material.'), detail: t('留在后台会继续处理，完成后自动退出；保存并退出会停止新增处理，等待已发出的回复并保存后退出。', 'Continue in Background keeps processing and quits when finished. Save and Quit stops new work, waits for pending replies, saves, and then quits.'), buttons: [t('留在后台处理', 'Continue in Background'), t('保存并退出', 'Save and Quit'), t('返回阅读', 'Return to Reading')], defaultId: 0, cancelId: 2, noLink: true});
      closing = false;
      if (response === 0) background();
      else if (response === 1) await exitGracefully();
    } catch (error) { closing = false; showWindow(); await dialog.showMessageBox(window, {type: 'error', title: t('暂时无法确认后台状态', 'Background Status Is Unavailable'), message: error.message, buttons: [t('返回客户端', 'Return to App')]}); }
  }
  function setStartupStatus(phase, message) {
    startupStatus = {phase, message};
    window?.webContents.send('yixu:lifecycle-status', startupStatus);
  }
  function projectChoiceError() {
    return Error(t('书籍工程暂时无法打开。请选择包含 project.json 和已保存阅读资料的完整工程目录。', 'The book project could not be opened. Choose a complete project folder containing project.json and saved reading data.'));
  }
  async function chooseReadingProjectDirectory(current) {
    const selected = await dialog.showOpenDialog(window, {title: t('打开书籍工程', 'Open Book Project'), ...(typeof current === 'string' && path.isAbsolute(current) ? {defaultPath: current} : {}), properties: ['openDirectory'], buttonLabel: t('打开工程', 'Open Project')});
    return selected.canceled ? null : selected.filePaths[0] ?? null;
  }
  async function chooseAndOpenReadingProject() {
    try { const selected = await chooseReadingProjectDirectory(readingProject?.directory); if (selected) acceptReadingProject(selected); }
    catch { await dialog.showMessageBox(window, {type: 'error', title: t('工程暂时无法打开', 'Project Could Not Open'), message: projectChoiceError().message, buttons: [t('返回客户端', 'Return to App')]}); }
  }
  function acceptReadingProject(directory, requestId) {
    if (quitting || switching || autoRequests.size) throw Error(t('正在保存、打开工程或启动阅读，请等待当前操作完成。', 'Saving, opening a project, or starting reading is in progress. Wait for it to finish.'));
    let project;
    try { project = directory === null ? null : readReadingProject(directory); }
    catch { throw projectChoiceError(); }
    projectRequest = {id: requestId};
    if (!project && !readingProject && !startupFailed && !existsSync(path.join(config.dataRoot, 'project-selection.json'))) return {accepted: true, localLibrary: true};
    switching = true; cancelBackgroundExit(); updateMenus(); publish();
    // The acknowledgement is queued before shutdown. Graceful server close also
    // waits for the accepted agent HTTP response to finish.
    setImmediate(() => void switchReadingProject(project));
    return {accepted: true, switching: true};
  }
  async function switchReadingProject(project) {
    let stopped = false;
    setStartupStatus('saving', t('正在保存当前阅读记录并打开工程…', 'Saving current reading records and opening the project…'));
    window?.setProgressBar(2);
    try {
      if (child?.connected) await rpc('shutdown');
      if (childExit) {
        const ended = await childExit;
        if (ended.code !== 0 && !startupFailed) throw Error('HOST_NOT_SAVED');
      }
      stopped = true; child = undefined; childExit = undefined; readyURL = undefined; readerReady = false;
      saveReadingProjectSelection(config.dataRoot, project);
      readingProject = project;
      setStartupStatus('starting', project ? t('正在打开书籍工程…', 'Opening the book project…') : t('正在打开本机书架…', 'Opening the local library…'));
      await window.loadFile(path.join(__dirname, 'starting.html'));
      await startServer(project);
      window?.setProgressBar(-1); window?.setTitle(appTitle());
    } catch (error) {
      projectRequest.error = t('工程尚未完成打开，原阅读记录保持。请核对客户端状态后再操作。', 'The project has not finished opening. Existing reading records are retained. Check the client status before proceeding.');
      if (!stopped && child?.connected && readyURL) {
        window?.setProgressBar(-1);
        setStartupStatus('error', t('当前阅读记录尚未完成保存，请稍后再次打开工程。原目录选择保持。', 'Current reading records have not finished saving. Try opening the project again later. The previous selection is retained.'));
      } else failed(error);
    } finally { switching = false; updateMenus(); publish(); }
  }
  function failed() {
    startupFailed = true; readyURL = undefined; readerReady = false;
    const message = t('书籍工程或阅读服务暂时无法打开，原目录选择保持。请重新选择完整工程目录，或返回本机书架。', 'The book project or reading service could not be opened. The selected location is retained. Choose a complete project folder again, or return to the local library.');
    projectRequest.error = message;
    window?.setTitle(t('工程暂时无法打开 · 宜序伴读', 'Project Could Not Open · Yixu Reading Companion')); window?.setProgressBar(-1);
    setStartupStatus('error', message);
    if (window && !window.isDestroyed()) void window.loadFile(path.join(__dirname, 'starting.html')).then(() => setStartupStatus('error', message)).catch(() => {});
    if (!openRequested) console.error(message);
    updateMenus(); publish();
  }
  async function startServer(project) {
    const bundledNode = path.join(root, 'runtime', 'node', 'node.exe');
    const node = process.env.YIXU_NODE_EXE || (existsSync(bundledNode) ? bundledNode : process.env.npm_node_execpath);
    if (!node || !existsSync(node)) throw Error('NODE_RUNTIME_UNAVAILABLE');
    const logs = path.join(config.dataRoot, 'client-launcher'); mkdirSync(logs, {recursive: true});
    const output = createWriteStream(path.join(logs, 'desktop-host.log'), {flags: 'a'});
    const serverChild = spawn(node, ['--experimental-transform-types', path.join(__dirname, 'server.mjs')], {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {...process.env, YIXU_DESKTOP: '1', YIXU_DEVELOPER_MODE: developerMode ? '1' : '0', YIXU_PORT: String(config.port), YIXU_BOOK_PROJECT_ROOT: path.join(app.getPath('documents'), '宜序伴读', '书籍工程'), ...readingProjectEnvironment(config.dataRoot, project)}});
    child = serverChild; startupFailed = false;
    childExit = new Promise(resolve => serverChild.once('close', (code, signal) => resolve({code, signal})));
    serverChild.stdout.pipe(output, {end: false}); serverChild.stderr.pipe(output, {end: false});
    return new Promise((resolve, reject) => {
      let settled = false;
      const rejectStartup = () => { if (!settled) { settled = true; reject(Error('READING_SERVICE_UNAVAILABLE')); } else if (!quitting && !switching && child === serverChild) failed(); };
      serverChild.on('message', message => {
        if (message.type === 'native-control') { handleNativeControl(message, serverChild); return; }
        if (message.type === 'ready') {
          if (child !== serverChild) return;
          readyURL = message.url;
          window.loadURL(readyURL).then(() => { if (!settled) { settled = true; startupFailed = false; setStartupStatus('ready', ''); publish(); resolve(); } }).catch(rejectStartup);
        } else if (message.type === 'fatal') rejectStartup();
        else if (message.type === 'response') { const request = requests.get(message.id); if (!request || request.child !== serverChild) return; clearTimeout(request.timer); requests.delete(message.id); message.error ? request.reject(Error(message.error)) : request.resolve(message.value); }
      });
      serverChild.once('error', rejectStartup);
      serverChild.once('exit', () => {
        output.end();
        for (const [id, request] of requests) if (request.child === serverChild) { clearTimeout(request.timer); requests.delete(id); request.reject(Error(t('后台服务已退出。', 'The background service has exited.'))); }
        if (!settled || !quitting && !switching) rejectStartup();
      });
    });
  }
  function receiveProjectIntent(intent) {
    try { acceptReadingProject(intent.action === 'local-library' ? null : intent.directory, intent.requestId); }
    catch {
      projectRequest = {id: intent.requestId, error: projectChoiceError().message};
      if (readyURL) { setStartupStatus('error', projectRequest.error); publish(); }
      else failed();
    }
  }
  app.on('second-instance', (_event, _argv, _cwd, intent) => {
    if (intent?.project) { if (startupFinished) receiveProjectIntent(intent.project); else deferredProjectIntent = intent.project; }
    if (intent?.show === true) showWindow();
  });
  app.on('activate', showWindow);
  app.on('before-quit', event => { if (!allowQuit) { event.preventDefault(); if (!quitting) requestClose(); } });
  app.on('window-all-closed', () => { if (allowQuit) app.quit(); });
  app.whenReady().then(async () => {
    if (!languageSelected) language = normalizeLanguage(app.getLocale());
    window = new BrowserWindow({width: 1440, height: 960, minWidth: 960, minHeight: 640, title: appTitle(), icon: path.join(__dirname, 'assets', 'app-icon.ico'), backgroundColor: '#f7f4ed', show: false, webPreferences: {preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false, devTools: developerMode}});
    ensureTray();
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    const trustedRenderer = event => {
      const source = event.senderFrame;
      return event.sender === window.webContents && source === window.webContents.mainFrame && (readyURL ? source.url === readyURL : source.url === pathToFileURL(path.join(__dirname, 'starting.html')).href);
    };
    ipcMain.handle('yixu:get-language', event => {
      if (!trustedRenderer(event)) throw Error('窗口来源不符。');
      return {language};
    });
    ipcMain.handle('yixu:set-language', (event, value) => {
      if (!trustedRenderer(event) || (value !== 'zh-CN' && value !== 'en')) throw Error('界面语言无效。');
      const languageFile = path.join(config.profile, 'interface-language.json');
      const pendingFile = languageFile + '.tmp';
      writeFileSync(pendingFile, JSON.stringify({language: value}) + '\n'); renameSync(pendingFile, languageFile);
      language = value; languageSelected = true;
      updateMenus();
      if (!quitting && !startupFailed) window.setTitle(appTitle());
      return {language};
    });
    ipcMain.handle('yixu:window-state', event => {
      if (!trustedRenderer(event)) throw Error('窗口来源不符。');
      return state();
    });
    ipcMain.handle('yixu:startup-status', event => {
      if (!trustedRenderer(event)) throw Error('窗口来源不符。');
      return startupStatus;
    });
    ipcMain.handle('yixu:choose-reading-project-directory', async(event, current) => {
      if (!trustedRenderer(event)) throw Error('窗口来源不符。');
      return chooseReadingProjectDirectory(current);
    });
    ipcMain.handle('yixu:open-reading-project-directory', (event, directory) => {
      if (!trustedRenderer(event)) throw Error('窗口来源不符。');
      return acceptReadingProject(directory);
    });
    ipcMain.handle('yixu:use-local-library', event => {
      if (!trustedRenderer(event)) throw Error('窗口来源不符。');
      return acceptReadingProject(null);
    });
    ipcMain.handle('yixu:choose-project-directory',async(event,current)=>{
      if(!trustedRenderer(event))throw Error('窗口来源不符。');
      const selected=await dialog.showOpenDialog(window,{title:t('选择工程副本的存放文件夹','Choose a Parent Folder for the Project Copy'),...(typeof current==='string'&&path.isAbsolute(current)?{defaultPath:current}:{}),properties:['openDirectory','createDirectory'],buttonLabel:t('保存到此文件夹','Save in This Folder')});
      return selected.canceled?null:selected.filePaths[0]??null;
    });
    ipcMain.handle('yixu:open-source-file-directory',async(event,filename)=>{
      if(!trustedRenderer(event)||typeof filename!=='string'||!path.isAbsolute(filename))throw Error(t('原文文件位置无效。','Invalid source file location.'));
      const error=await shell.openPath(path.dirname(filename));if(error)throw Error(error);
    });
    ipcMain.handle('yixu:auto-reader-ready', (event, ready) => {
      if (!trustedRenderer(event) || !readyURL || event.senderFrame.url !== readyURL || typeof ready !== 'boolean') throw Error('阅读页面就绪通知来源不符。');
      readerReady = ready; return {accepted: true};
    });
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) readerReady = false; });
    ipcMain.handle('yixu:auto-reading-result', (event, id, result) => {
      if (!trustedRenderer(event) || !readyURL || event.senderFrame.url !== readyURL) throw Error('无法确认自动阅读结果来自当前阅读窗口。');
      if (typeof id !== 'string' || typeof result?.ok !== 'boolean' || (result.error !== undefined && typeof result.error !== 'string')) throw Error('无法处理自动阅读返回的结果。');
      const pending = autoRequests.get(id); if (!pending) throw Error('该自动阅读启动请求已结束，请核对当前状态。');
      pending.finish({ok: result.ok, ...(result.error ? {error: result.error.slice(0, 2000)} : {})});
      return {accepted: true};
    });
    for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore']) window.on(event, publish);
    window.on('close', event => { if (!allowQuit) { event.preventDefault(); if (!quitting) requestClose(); } });
    window.webContents.on('did-finish-load', publish);
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('will-navigate', (event, url) => {
      const expected = readyURL || pathToFileURL(path.join(__dirname, 'starting.html')).href;
      if (url !== expected) event.preventDefault();
    });
    updateMenus();
    await window.loadFile(path.join(__dirname, 'starting.html')); if (openRequested) showWindow();
    try {
      if (launchProjectIntent) {
        projectRequest = {id: launchProjectIntent.requestId};
        readingProject = launchProjectIntent.action === 'local-library' ? null : readReadingProject(launchProjectIntent.directory);
        saveReadingProjectSelection(config.dataRoot, readingProject);
      } else readingProject = selectedReadingProject(config.dataRoot);
      await startServer(readingProject);
    } catch (error) { failed(error); }
    finally { startupFinished = true; if (deferredProjectIntent) receiveProjectIntent(deferredProjectIntent); }
  }).catch(error => { if (openRequested) dialog.showErrorBox(t('宜序伴读启动未完成', 'Yixu Reading Companion Could Not Start'), error.message); else console.error(error.message); quitting = true; allowQuit = true; app.quit(); });
}
