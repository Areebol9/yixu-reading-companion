'use strict';
let currentStatus;
let english = false;
const desktop = window.yixuDesktop;
function showLanguage(language) {
  english = /^en(?:-|$)/i.test(language);
  document.documentElement.lang = english ? 'en' : 'zh-CN';
  document.title = english ? 'Yixu Reading Companion' : '宜序伴读';
  document.getElementById('app-name').textContent = document.title;
  document.getElementById('open-project').textContent = english ? 'Open Book Project' : '打开书籍工程';
  document.getElementById('local-library').textContent = english ? 'Return to Local Library' : '返回本机书架';
  if (!currentStatus?.message) document.getElementById('startup-message').textContent = english ? 'Connecting to your reading library…' : '正在连接阅读存档…';
}
showLanguage(navigator.language);
desktop?.getLanguage().then(({language}) => showLanguage(language)).catch(() => {});
function receive(status) {
  currentStatus = status;
  if (typeof status?.message === 'string' && status.message) document.getElementById('startup-message').textContent = status.message;
  document.getElementById('project-actions').hidden = status?.phase !== 'error';
}
desktop?.onLifecycleStatus(receive);
desktop?.getStartupStatus().then(receive).catch(() => {});
async function choose(action) {
  const buttons = [...document.querySelectorAll('button')]; buttons.forEach(button => { button.disabled = true; });
  try { await action(); }
  catch { receive({phase: 'error', message: english ? 'The project could not be opened. Choose a complete project folder again, or return to the local library.' : '工程暂时无法打开。请重新选择完整工程目录，或返回本机书架。'}); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}
document.getElementById('open-project').addEventListener('click', () => void choose(async () => {
  const directory = await desktop?.chooseReadingProjectDirectory();
  if (directory) await desktop.openReadingProjectDirectory(directory);
}));
document.getElementById('local-library').addEventListener('click', () => void choose(() => desktop.useLocalLibrary()));
