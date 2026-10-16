// Explicit reader requests are distinct from optional model browsing. These rules
// cover direct Chinese/English requests; general tool choice remains with the model.
export function webIntent(text: string) {
  const forbidden = /(?:不要|不用|无需|禁止|别).{0,5}(?:联网|上网|搜索|网络请求)|(?:do\s+not|don['’]t|no\s+need\s+to)\s+(?:search|browse|use\s+the\s+web)/iu.test(text);
  const search = !forbidden && /(?:^\s*(?:(?:请|帮我|麻烦|please)\s*)?|[，,。；;！？.!?\n]\s*(?:请|帮我|麻烦|please)\s*)(?:联网|上网|搜索互联网|搜索网络|search\s+the\s+web)/iu.test(text);
  const skipPage = /(?:不要|不用|不必|无需).{0,3}(?:读取|打开|阅读).{0,12}(?:网页|来源)|(?:do\s+not|don['’]t|no\s+need\s+to)\s+(?:read|open|fetch)\b.{0,35}\b(?:page|source|article)/iu.test(text);
  const read = /(?:读取|打开|阅读|看一下|看看).{0,12}(?:网页|来源|原文)|\b(?:read|open|fetch)\b.{0,35}\b(?:page|source|article)(?:s)?\b/iu.test(text);
  return { forbidden, search, page: search && read && !skipPage };
}
