import { Node, getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import { Mathematics } from '@tiptap/extension-mathematics';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';

export const Citation = Node.create({
  name: 'citation', group: 'inline', inline: true, atom: true,
  addAttributes() { return { key: { default: null } }; },
  parseHTML() { return [{ tag: 'span[data-citation-key]', getAttrs: el => ({ key: el.getAttribute('data-citation-key') }) }]; },
  renderHTML({ node }) { return ['span', { 'data-citation-key': node.attrs.key, class: 'rw-citation' }, `[@${node.attrs.key}]`]; },
  renderText({ node }) { return `[@${node.attrs.key}]`; },
  parseMarkdown: token => ({ type: 'citation', attrs: { key: token.key } }),
  renderMarkdown: node => `[@${node.attrs.key}]`,
  markdownTokenizer: { name: 'citation', level: 'inline', start: source => source.indexOf('[@'), tokenize: source => {
    const match = source.match(/^\[@([a-zA-Z0-9_:.#/-]+)\]/);
    return match ? { type: 'citation', raw: match[0], key: match[1] } : undefined;
  } },
});

// The editor and server use the same schema and serializer. The server derives
// the replacement itself; it never accepts a client-supplied rewritten article.
export const writingExtensions = ({ resolveImage } = {}) => [StarterKit.configure({ trailingNode: false, link: { openOnClick: false } }), Markdown, TableKit, resolveImage ? Image.extend({ addNodeView() { return ({ node }) => { const dom = document.createElement('img'); const render = value => { dom.src = resolveImage(value.attrs.src); dom.alt = value.attrs.alt || ''; if (value.attrs.title) dom.title = value.attrs.title; }; render(node); return { dom, update(next) { if (next.type.name !== 'image') return false; render(next); return true; } }; }; } }) : Image, Mathematics, Citation];
let codec;
export function documentCodec() {
  if (!codec) { const extensions = writingExtensions(); codec = { schema: getSchema(extensions), markdown: new MarkdownManager({ extensions }) }; }
  return codec;
}
export function sentenceAnchor(json, from, to) {
  const { schema, markdown } = documentCodec();
  const doc = schema.nodeFromJSON(json); doc.check();
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to <= from || to > doc.content.size) throw new Error('请先在正文中选中一句话。');
  const start = doc.resolve(from), end = doc.resolve(to);
  if (!start.sameParent(end) || !['paragraph', 'heading'].includes(start.parent.type.name)) throw new Error('请在同一段正文内选句；公式、表格和跨段选择暂不改写。');
  let unsupported = false;
  doc.nodesBetween(from, to, node => { if (node.isInline && !node.isText && node.type.name !== 'citation') unsupported = true; });
  if (unsupported) throw new Error('这段选择包含公式或其他嵌入对象，请选中旁边的文字。');
  const selectedText = doc.textBetween(from, to, '', node => node.type.name === 'citation' ? `[@${node.attrs.key}]` : '');
  if (!selectedText.trim() || selectedText.length > 4000) throw new Error('请选择不超过 4000 字的正文片段。');
  return { doc, selectedText, markdown: markdown.serialize(json), marks: start.marks() };
}
export function replaceSentence(json, from, to, replacement) {
  const { schema, markdown } = documentCodec();
  const anchor = sentenceAnchor(json, from, to);
  const fragments = replacement.split(/(\[@[a-zA-Z0-9_:.#/-]+\])/g).filter(Boolean).map(part => {
    const citation = part.match(/^\[@(.+)\]$/);
    return citation ? schema.nodes.citation.create({ key: citation[1] }) : schema.text(part, anchor.marks);
  });
  // ProseMirror performs the splice, preserving every node outside the range.
  const selection = anchor.doc.slice(from, to);
  const Fragment = selection.content.constructor, Slice = selection.constructor;
  const next = anchor.doc.replace(from, to, new Slice(Fragment.fromArray(fragments), 0, 0));
  next.check();
  return markdown.serialize(next.toJSON());
}
