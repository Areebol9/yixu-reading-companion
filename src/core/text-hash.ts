export type TextHasher = (text: string) => Promise<string>;
const browserHasher: TextHasher = async text => {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
};
let implementation = browserHasher;
// Installed once by the embedding runtime. This capability is not a model tool.
export function configureTextHasher(hasher: TextHasher = browserHasher) { implementation = hasher; }
export async function hashText(text: string): Promise<string> {
  const hash = await implementation(text);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('正文版本计算失败，未导入资料');
  return hash;
}
