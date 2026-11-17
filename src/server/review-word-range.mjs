import { StoreError } from './store.mjs';
import { isDeepStrictEqual } from 'node:util';

export function reviewWordRange(outline, { path, index, original, quote, scope, exactRevision, useCurrent }) {
  const { sections, paragraphs } = outline;
  const matchingSections = sections.filter(section => isDeepStrictEqual(section.path, path));
  const candidates = find(text => text === original);
  const target = exactRevision && candidates.find(item => item.index === index)
    || (candidates.length === 1 ? candidates[0] : null)
    || (useCurrent && candidates.length === 0 ? uniqueQuote() : null);
  if (!target) throw new StoreError('REVIEW_ANCHOR_CHANGED', '批注段落已修改或无法唯一定位。请核对原文或对当前文稿重新审阅。', 409);
  const { section, index: position } = target, text = paragraphs[position];
  const offset = text.indexOf(quote);
  if (offset < 0) throw new StoreError('REVIEW_ANCHOR_CHANGED', '批注原文已变化，请重新审阅。', 409);
  const point = (index, off) => ({ story: 'body', path: [index], off });
  const first = section.paragraphs[0].index, last = section.paragraphs.at(-1).index;
  let wordSelection;
  let chapterBlocks;
  if (scope === 'chapter') {
    chapterBlocks = Array.from({ length: last - first + 1 }, (_, i) => paragraphs[first + i]);
    if (section.paragraphs.length < 2 || chapterBlocks.length > 30 || section.paragraphs.some(item => !item.anchorable) || chapterBlocks.some(item => typeof item !== 'string')) {
      throw new StoreError('REVIEW_CHAPTER_RANGE', '小节优化需要 2–30 个连续普通段落。可选择按段落生成。');
    }
    wordSelection = { anchor: point(first, 0), focus: point(last, Buffer.byteLength(chapterBlocks.at(-1))), text: chapterBlocks.join('\n') };
  } else {
    const full = scope !== 'locate' && [...text].length <= 4000 && text === text.trim() && !/[\r\n\0]/.test(text);
    const start = full ? 0 : offset, selected = full ? text : quote;
    wordSelection = { anchor: point(position, Buffer.byteLength(text.slice(0, start))), focus: point(position, Buffer.byteLength(text.slice(0, start) + selected)), text: selected };
  }
  return { wordSelection, original: text, index: position, chapterBlocks, context: {
    before: (scope === 'chapter' ? sections[sections.indexOf(section) - 1]?.paragraphs.slice(-2) || [] : section.paragraphs.filter(item => item.index < position).slice(-2)).map(item => item.text.slice(-1200)),
    after: (scope === 'chapter' ? sections[sections.indexOf(section) + 1]?.paragraphs.slice(0, 2) || [] : section.paragraphs.filter(item => item.index > position).slice(0, 2)).map(item => item.text.slice(0, 1200)),
  } };

  function find(matches) {
    return matchingSections.flatMap(section => section.paragraphs.filter(item => item.anchorable && matches(paragraphs[item.index])).map(item => ({ section, index: item.index })));
  }

  function uniqueQuote() {
    const matches = find(text => text.includes(quote));
    const text = matches.length === 1 && paragraphs[matches[0].index];
    return text && text.indexOf(quote) === text.lastIndexOf(quote) ? matches[0] : null;
  }
}
