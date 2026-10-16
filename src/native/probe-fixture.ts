export const probeTitle = '原生运行工程资料🙂';
export const probePage = '工程登记：设备AX为3件，编号001，存放于甲柜。本条用于验证原生运行、取消与中文处理。';
export const probeSentinel = 'NATIVE-UNREAD-SENTINEL';
export const probeText = '第一章 工程登记\n' + probePage + '\n第二章 未读\n' + probeSentinel;
export const unicodeFixture = '甲乙🙂\u0000\ud800';
export function largeProbeText(length: number): string {
  const heading = '第一章 工程规模资料\n', line = '工程规模记录：设备条目仅用于导入、哈希与保存检查。\n';
  return heading + line.repeat(Math.ceil((length - heading.length) / line.length)).slice(0, length - heading.length);
}
