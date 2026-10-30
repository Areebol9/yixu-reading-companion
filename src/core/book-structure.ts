import type { Chapter } from './types.ts';

export type BookStructureKind = 'volume' | 'part' | 'chapter' | 'section' | 'preface' | 'epilogue' | 'appendix' | 'body';
export type StructuredChapter = Chapter & { kind?: BookStructureKind; level?: number; parentIndex?: number };
export type BookStructureCandidate = {
  id: string; start: number; end: number; title: string;
  kind?: BookStructureKind; level?: number; number?: number; accepted: boolean;
  /** Only layout accompanies a possible heading; neighbouring prose is not copied. */
  layout: { line: number; blankBefore: boolean; blankAfter: boolean; separatorBefore?: boolean; separatorAfter?: boolean; indent: number; previousLineLength: number; nextLineLength: number };
};
export type BookStructureDetection = {
  chapters: StructuredChapter[]; candidates: BookStructureCandidate[]; ambiguous: boolean;
  reason?: 'no-reliable-headings' | 'uncertain-headings';
};
export type SelectedBookStructureCandidate = BookStructureCandidate & { parentId?: string };

type Heading = BookStructureCandidate & {
  family: string; strength: 'explicit' | 'numbered' | 'special' | 'styled' | 'possible';
  nonblankBefore: number; scope: number; sequential?: boolean; contentsList?: boolean;
};
const numeral = '[零〇一二三四五六七八九十百千万两兩壹贰貳叁參肆伍陆陸柒捌玖拾佰仟\\d]+';
const chineseHeading = new RegExp(`^(第\\s*(${numeral})\\s*([部卷篇章节回集])|(${numeral})\\s*([部卷篇章节回集]))(.*)$`, 'u');
const unitFirstHeading=new RegExp(`^(卷|部|篇|章|节|回|集|册)\\s*(${numeral}|[上中下])(?=$|[\\s:：、.（()—–-])(.*)$`,'u');
const splitPartHeading=/^([上中下])([部卷篇册])(?=$|[\s:：、.（()—–-])(.*)$/u;
const numberedHeading = new RegExp(`^(?:[（(](${numeral}|[IVXLCDM]+)[）)]|(${numeral}|[IVXLCDM]+)[、.．:：]|(${numeral}|[IVXLCDM]+)\\s+)(.*)$`, 'iu');
const englishHeading = /^(book|volume|vol\.?|part|chapter|section)\s+([\d]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?=$|[\s.:：、—–-])(.*)$/iu;
const specialHeading = /^(序章|序言|前言|前记|前記|引言|引子|楔子|序|终章|終章|尾声|尾聲|后记|後記|结语|結語|跋|番外|外传|外傳|附录|附錄|prologue|preface|foreword|introduction|epilogue|afterword|appendix)(?=$|[\s:：、.（(—–-]|[一二三四五六七八九十\d])(.{0,90})$/iu;

function headingNumber(token: string): number | undefined {
  if (/^\d+$/u.test(token)) { const value = Number(token); return Number.isSafeInteger(value) ? value : undefined; }
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
  const word = words.indexOf(token.toLowerCase()); if (word >= 0) return word;
  if (/^[ivxlcdm]+$/iu.test(token)) {
    // Reject ordinary Latin words and noncanonical Roman numerals.
    if (!/^(?=.)M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/u.test(token.toUpperCase())) return;
    const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    const letters = token.toUpperCase(); let value = 0;
    for (let i = 0; i < letters.length; i++) value += values[letters[i]] * (values[letters[i]] < (values[letters[i + 1]] ?? 0) ? -1 : 1);
    return value;
  }
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 兩: 2, 贰: 2, 貳: 2, 三: 3, 叁: 3, 參: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 陸: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9 };
  const units: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10000 };
  let total = 0, section = 0, digit = 0;
  for (const character of token) {
    if (digits[character] !== undefined) { digit = digit * 10 + digits[character]; continue; }
    const unit = units[character]; if (!unit) return;
    if (unit === 10000) { total += (section + digit || 1) * unit; section = 0; }
    else section += (digit || 1) * unit;
    digit = 0;
  }
  return total + section + digit;
}

function classify(line: string): Pick<Heading, 'kind' | 'number' | 'family' | 'strength' | 'level'> | undefined {
  let value = line.normalize('NFKC');
  const markdown = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/u.exec(value);
  if (markdown) value = markdown[2];
  else if (/^(?:【.*】|\[.*\]|《.*》|\*\*.*\*\*)$/u.test(value)) value = value.replace(/^(?:【|\[|《|\*\*)|(?:】|\]|》|\*\*)$/gu, '').trim();
  const postfixed=unitFirstHeading.exec(value),split=splitPartHeading.exec(value);
  if(postfixed||split){const unit=postfixed?.[1]??split![2],token=postfixed?.[2]??split![1],kind:BookStructureKind=unit==='部'?'part':['卷','册','集'].includes(unit)?'volume':unit==='节'?'section':'chapter';return{kind,number:({上:1,中:2,下:3} as Record<string,number>)[token]??headingNumber(token),family:`unit-first:${unit}`,strength:'explicit'};}
  const chinese = chineseHeading.exec(value);
  if (chinese) {
    const unit = chinese[3] ?? chinese[5], suffix = chinese[6];
    // An unprefixed numeral needs a lexical boundary after the unit. A book
    // title or a prose word containing 章 is not evidence of a chapter heading.
    if (!chinese[2] && suffix && !/^[\s:：、.（(—–-]/u.test(suffix)) return;
    const kind: BookStructureKind = unit === '部' ? 'part' : unit === '卷' || unit === '集' ? 'volume' : unit === '节' ? 'section' : 'chapter';
    if(kind==='part'||kind==='volume'){
      if(/^(?:总结|總結|后记|後記|感言|卷末语|卷末語)$/u.test(suffix.trim()))return{kind:'epilogue',family:'special:epilogue',strength:'special'};
      if(suffix&&!/^[\s:：、.（(—–-]/u.test(suffix))return;
    }
    if(/[。；;]/u.test(suffix))return;
    return { kind, number: headingNumber(chinese[2] ?? chinese[4]), family: `zh:${chinese[2] ? 'ordinal' : 'unit'}:${unit}`, strength: chinese[2] ? 'explicit' : 'numbered' };
  }
  const english = englishHeading.exec(value);
  if (english) {
    const unit = english[1].toLowerCase().replace('.', '');
    const kind: BookStructureKind = unit === 'book' || unit === 'part' ? 'part' : unit === 'volume' || unit === 'vol' ? 'volume' : unit === 'section' ? 'section' : 'chapter';
    const number = headingNumber(english[2]);
    return number === undefined ? { family: 'possible', strength: 'possible' } : { kind, number, family: `en:${kind}`, strength: 'explicit' };
  }
  const special = specialHeading.exec(value);
  if (special) {
    const name = special[1].toLowerCase();
    const kind: BookStructureKind = /^(?:番外|外传|外傳|附录|附錄|appendix)$/u.test(name) ? 'appendix' : /^(?:终章|終章|尾声|尾聲|后记|後記|结语|結語|跋|epilogue|afterword)$/u.test(name) ? 'epilogue' : 'preface';
    return { kind, family: `special:${kind}`, strength: 'special' };
  }
  if (markdown) return { kind: markdown[1].length > 1 ? 'section' : 'chapter', level: markdown[1].length - 1, family: `markdown:${markdown[1].length}`, strength: 'styled' };
  const numbered = numberedHeading.exec(value);
  if (numbered) {
    const token = numbered[1] ?? numbered[2] ?? numbered[3];
    if (!numbered[4].trim() || /^[.．…]/u.test(numbered[4]) || /[。；;!?！？“”「」]/u.test(numbered[4])) return;
    const number = headingNumber(token); if (number === undefined) return;
    return { kind: 'chapter', number, family: `numbered:${numbered[1] ? 'bracket' : numbered[2] ? 'punctuation' : 'space'}:${/^\d/u.test(token) ? 'arabic' : /^[ivxlcdm]/iu.test(token) ? 'roman' : 'chinese'}`, strength: 'numbered' };
  }
  const bare=headingNumber(value);if(bare!==undefined)return{kind:'chapter',number:bare,family:/^\d/u.test(value)?'bare:arabic':/^[ivxlcdm]/iu.test(value)?'bare:roman':'bare:chinese',strength:'numbered'};
  if (value.length <= 60 && !/[。；;，,!?！？“”「」：:]/u.test(value) && /[\p{L}\p{N}]/u.test(value)) return { family: 'possible', strength: 'possible' };
}

/** Independent rule and layout parser. Text is never rewritten, split by a
 * target length, or sent to a model. Uncertain lines remain review candidates. */
export function detectBookStructure(title: string, text: string): BookStructureDetection {
  const headings: Heading[] = [];
  const titleKey=(value:string)=>value.normalize('NFKC').trim().replace(/^#{1,6}\s+/u,'').replace(/^《|》$/gu,'').trim();
  const bookTitle = titleKey(title.replace(/\.txt$/iu, ''));
  let previousLength = 0, previousBlank = true, previousSeparator = false, nonblank = 0, scope = 0, lineNumber = 0;
  let pending: Heading | undefined;
  // The scan stores candidate headings, not every line of a potentially large book.
  for (const match of text.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/gu)) {
    if (!match[0].length) break;
    const raw = match[1], line = raw.trim(), blank = /^[\s\p{Cf}]*$/u.test(line);
    // Printed ornaments serve the same layout role as empty lines. Keep them
    // in the source and record their role separately from literal blank lines.
    const separator = !blank && /^[\s\p{P}\p{S}\p{Cf}]+$/u.test(line);
    if (pending) { pending.layout.blankAfter = blank; pending.layout.separatorAfter = separator; pending.layout.nextLineLength = line.length; pending = undefined; }
    if (!blank && line.length <= 120 && titleKey(line) !== bookTitle) {
      const parsed = classify(line);
      if (parsed && (parsed.strength !== 'possible' || previousBlank || previousSeparator)) {
        if (parsed.kind === 'volume' || parsed.kind === 'part') scope++;
        const start = match.index!, candidate: Heading = {
          ...parsed, id: `line-${lineNumber}-${start}`, start, end: start + raw.length, title: line,
          accepted: false, nonblankBefore: nonblank, scope,
          layout: { line: lineNumber, blankBefore: previousBlank, blankAfter: false, separatorBefore: previousSeparator, indent: raw.length - raw.trimStart().length, previousLineLength: previousLength, nextLineLength: 0 },
        };
        headings.push(candidate); pending = candidate;
      }
    }
    if (!blank && !separator) nonblank++;
    previousLength = line.length; previousBlank = blank; previousSeparator = separator; lineNumber++;
  }
  if (pending) pending.layout.blankAfter = true;

  // Adjacent heading-only runs are a printed contents list, rather than two
  // narrative chapter boundaries. The final entry of the run is excluded too.
  for (let i = 1; i < headings.length; i++) {
    const before = headings[i - 1], current = headings[i];
    if (before.family === current.family && current.number !== undefined && current.nonblankBefore === before.nonblankBefore + 1) before.contentsList = current.contentsList = true;
  }
  const previousByFamily = new Map<string, Heading>();
  for (const candidate of headings) {
    if (candidate.contentsList || candidate.number === undefined) continue;
    const before = previousByFamily.get(candidate.family);
    if (before && (candidate.number === before.number! + 1 || candidate.number === 1 && before.scope !== candidate.scope)) before.sequential = candidate.sequential = true;
    previousByFamily.set(candidate.family, candidate);
  }
  const establishedStyles=new Set(headings.filter(candidate=>candidate.sequential&&!candidate.contentsList).map(candidate=>`${candidate.family}:${candidate.layout.indent}:${candidate.layout.blankBefore}`));
  for (const candidate of headings) {
    if (candidate.contentsList) continue;
    const layout = candidate.layout, isolated = (layout.blankBefore || layout.separatorBefore) && (layout.blankAfter || layout.separatorAfter);
    if (candidate.strength === 'explicit') candidate.accepted = !!candidate.sequential || isolated && candidate.number === 1 || layout.blankBefore&&establishedStyles.has(`${candidate.family}:${layout.indent}:${layout.blankBefore}`);
    else if (candidate.strength === 'numbered') candidate.accepted = !!candidate.sequential && (isolated || candidate.family.startsWith('zh:unit:'));
    else if (candidate.strength === 'styled') candidate.accepted = true;
  }
  // A single volume/part can be established by its actual child chapters, even
  // where the heading and first chapter have no empty line between them.
  let nextAcceptedRank: number | undefined;
  for (let index = headings.length - 1; index >= 0; index--) {
    const candidate = headings[index];
    const rank = candidate.kind === 'part' ? 0 : candidate.kind === 'volume' ? 1 : candidate.kind === 'section' ? 3 : 2;
    if ((candidate.kind === 'part' || candidate.kind === 'volume') && !candidate.contentsList) {
      if (nextAcceptedRank !== undefined && nextAcceptedRank > rank) candidate.accepted = true;
      nextAcceptedRank = candidate.accepted ? rank : undefined;
    } else if (candidate.accepted) nextAcceptedRank = rank;
  }
  const hasNumberedStructure = headings.some(c => c.accepted);
  for (const candidate of headings) {
    if (candidate.strength === 'special') candidate.accepted = (candidate.layout.blankBefore || !!candidate.layout.separatorBefore) && (candidate.layout.blankAfter || !!candidate.layout.separatorAfter || hasNumberedStructure);
  }

  const accepted = headings.filter(candidate => candidate.accepted);
  const selected: SelectedBookStructureCandidate[] = [];
  const parents: { id: string; rank: number; level: number }[] = [];
  for (const candidate of accepted) {
    const rank = candidate.strength === 'styled' ? candidate.level! : candidate.kind === 'part' ? 0 : candidate.kind === 'volume' ? 1 : candidate.kind === 'section' ? 3 : 2;
    while (parents.length && parents.at(-1)!.rank >= rank) parents.pop();
    const parent = parents.at(-1), level = parent ? parent.level + 1 : 0;
    candidate.level = level;
    selected.push({ ...candidate, ...(parent ? { parentId: parent.id } : {}) });
    if (candidate.kind === 'part' || candidate.kind === 'volume' || candidate.kind === 'chapter' || candidate.strength === 'styled') parents.push({ id: candidate.id, rank, level });
  }
  const uncertain = !accepted.length || headings.some(c => !c.accepted && !c.contentsList && c.strength !== 'possible');
  return {
    chapters: rebuildStructuredChapters(text, selected),
    candidates: headings.filter(c => c.strength !== 'possible' || c.layout.blankAfter || c.layout.separatorAfter).map(({ id, start, end, title, kind, level, number, accepted: included, layout }) => ({ id, start, end, title, kind, level, number, accepted: included, layout })),
    ambiguous: uncertain,
    ...(uncertain ? { reason: accepted.length ? 'uncertain-headings' as const : 'no-reliable-headings' as const } : {}),
  };
}

/** Rebuild only from source candidates. A model may select their IDs and
 * parents, but may not supply replacement text or character coordinates. */
export function rebuildStructuredChapters(text: string, selectedCandidates: readonly SelectedBookStructureCandidate[]): StructuredChapter[] {
  const selected = [...selectedCandidates];
  // The rule path is already ordered and stays linear. Assisted selections can
  // arrive in another order, so only that path needs sorting.
  if (selected.some((candidate, index) => index > 0 && selected[index - 1].start > candidate.start)) selected.sort((a, b) => a.start - b.start);
  const chapters: StructuredChapter[] = [], indexes = new Map<string, number>(), ancestors: number[] = [];
  if (!selected.length || selected[0].start > 0) chapters.push({ title: selected.length ? '卷首' : '正文', index: 0, start: 0, end: selected[0]?.start ?? text.length, kind: 'body', level: 0 });
  for (const candidate of selected) {
    if (!Number.isSafeInteger(candidate.start) || !Number.isSafeInteger(candidate.end) || candidate.start < 0 || candidate.end <= candidate.start || candidate.end > text.length ||
      indexes.has(candidate.id) || chapters.at(-1)?.start === candidate.start ||
      candidate.start > 0 && !/[\r\n]/u.test(text[candidate.start - 1]) || candidate.end < text.length && !/[\r\n]/u.test(text[candidate.end]) ||
      /[\r\n]/u.test(text.slice(candidate.start, candidate.end)) || text.slice(candidate.start, candidate.end).trim() !== candidate.title) throw new Error('目录候选与原始标题行不一致');
    const parentIndex = candidate.parentId === undefined ? undefined : indexes.get(candidate.parentId);
    if (candidate.parentId !== undefined && parentIndex === undefined) throw new Error('目录父标题必须是前面已选择的标题');
    if (parentIndex === undefined) ancestors.length = 0;
    else {
      while (ancestors.length && ancestors.at(-1) !== parentIndex) ancestors.pop();
      if (!ancestors.length) throw new Error('目录父标题已在前面的分组中结束');
    }
    let contentStart = candidate.end;
    if (text[contentStart] === '\r') contentStart++;
    if (text[contentStart] === '\n') contentStart++;
    const index = chapters.length, level = parentIndex === undefined ? 0 : (chapters[parentIndex].level ?? 0) + 1;
    chapters.push({ title: candidate.title, index, start: candidate.start, end: text.length, contentStart, kind: candidate.kind ?? 'chapter', level, ...(parentIndex === undefined ? {} : { parentIndex }) });
    indexes.set(candidate.id, index);
    ancestors.push(index);
  }
  for (let index = 0; index < chapters.length; index++) {
    const chapter = chapters[index]; chapter.end = chapters[index + 1]?.start ?? text.length;
    let start = Math.min(chapter.contentStart ?? chapter.start, chapter.end), end = chapter.end;
    while (start < end && /\s/u.test(text[start])) start++;
    while (end > start && /\s/u.test(text[end - 1])) end--;
    chapter.contentStart = start; chapter.contentEnd = end;
  }
  return chapters;
}
