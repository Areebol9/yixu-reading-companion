'use strict';
function showLanguage(language) {
  const english = /^en(?:-|$)/i.test(language);
  document.documentElement.lang = english ? 'en' : 'zh-CN';
  document.title = english ? 'Yixu Reading Companion' : '宜序伴读';
  document.getElementById('app-name').textContent = document.title;
  document.getElementById('startup-message').textContent = english ? 'Connecting to your local reading library…' : '正在连接本地阅读存档…';
}
showLanguage(navigator.language);
window.yixuDesktop?.getLanguage().then(({language}) => showLanguage(language)).catch(() => {});
