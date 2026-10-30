import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Ask the authenticated host to stop/save before the official launcher exits.
// No process-name search, external kill, or browser manipulation is involved.
const file = process.argv[2];
if (!file) throw Error('请指定此宿主私有connection.json路径');
const connection = JSON.parse(await readFile(resolve(file), 'utf8'));
const url = new URL(connection.url);
if (connection.schema !== 'yixu-companion-connection-v1' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^[a-f0-9]{64}$/.test(connection.token)) throw Error('宿主连接身份无效');
const result = await fetch(new URL('/shutdown', url), {method: 'POST', headers: {Authorization: 'Bearer ' + connection.token}});
if (!result.ok) throw Error('宿主未接受正常收尾：' + await result.text());
console.log('宿主已接纳收尾请求；完成与失败以原领域回执和进程退出为准。');
