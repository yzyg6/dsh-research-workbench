"""Bounded DOCX inspection and lossless single-paragraph text patching.

Only changed w:t payloads are rewritten. Unselected XML, namespace declarations,
relationships, equations and every other ZIP member retain their original bytes.
"""
import json
import re
import sys
import os
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET
from xml.parsers import expat
from xml.sax.saxutils import escape
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.dont_write_bytecode = True
from word_zip import replace_xml, restore
from word_format import format_document

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
M = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
q = lambda name: '{' + W + '}' + name


def load(path):
    z = zipfile.ZipFile(path)
    infos = z.infolist()
    if len(infos) > 4000 or sum(i.file_size for i in infos) > 96 * 1024 * 1024:
        raise ValueError('Word 展开内容超过安全上限。')
    if len({i.filename for i in infos}) != len(infos) or 'word/document.xml' not in z.namelist():
        raise ValueError('Word 包结构无效。')
    raw = z.read('word/document.xml')
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('不支持含实体声明的 Word。')
    root = ET.fromstring(raw)
    return z, raw, root


def inspect(root):
    body = root.find(q('body'))
    def visible(node):
        if node.tag == '{' + M + '}oMath':
            return '[公式 OOXML：' + ET.tostring(node, encoding='unicode') + ']'
        if node.tag == q('t'):
            return node.text or ''
        return ''.join(visible(child) for child in node)
    text = '\n'.join(visible(p) for p in body.iter(q('p')))
    return {'text': text, 'tables': len(list(root.iter(q('tbl')))),
            'formulas': len(list(root.iter('{' + M + '}oMath'))),
            'drawings': len(list(root.iter(q('drawing'))))}


def font_families(z, root):
    """Read declarations (including styles, themes and secondary stories), never edit them."""
    families = set()
    for name in z.namelist():
        if not re.fullmatch(r'word/(?:document|styles|numbering|footnotes|endnotes|header[^/]*|footer[^/]*|theme/[^/]+)\.xml', name):
            continue
        if name == 'word/document.xml':
            tree = root
        else:
            raw = z.read(name)
            if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
                raise ValueError('不支持含实体声明的 Word。')
            tree = ET.fromstring(raw)
        for node in tree.iter(q('rFonts')):
            for attr in ('ascii', 'hAnsi', 'eastAsia', 'cs'):
                value = node.get(q(attr))
                if value:
                    families.add(value.lstrip('@'))
        if name.startswith('word/theme/'):
            for node in tree.iter():
                value = node.get('typeface')
                if value:
                    families.add(value.lstrip('@'))
    return sorted(families)


def selected(root, anchor):
    a, b = anchor['anchor'], anchor['focus']
    if a.get('story', 'body') != 'body' or b.get('story', 'body') != 'body' or a['path'] != b['path']:
        raise ValueError('请在正文的同一段内选句；页眉、脚注和跨段选区暂不支持 AI 替换。')
    path = a['path']
    if not isinstance(path, list) or not 1 <= len(path) <= 16 or (len(path) - 1) % 3 or any(type(i) is not int or i < 0 for i in path):
        raise ValueError('Word 选区位置无效。')
    container = root.find(q('body'))
    for i in range(0, len(path), 3):
        allowed = (q('p'), q('tbl'), q('sectPr'), q('tcPr'), q('bookmarkStart'), q('bookmarkEnd'), q('commentRangeStart'), q('commentRangeEnd'))
        if any(child.tag not in allowed for child in container):
            raise ValueError('此位置包含暂不支持的包裹结构，请使用直接编辑；AI 选句未改动原文。')
        blocks = [x for x in container if x.tag in (q('p'), q('tbl'))]
        block = blocks[path[i]]
        if i + 1 < len(path):
            if block.tag != q('tbl'):
                raise ValueError('Word 选区与已保存正文不一致。')
            container = block.findall(q('tr'))[path[i+1]].findall(q('tc'))[path[i+2]]
    if block.tag != q('p'):
        raise ValueError('请选择段落文字。')
    # Complex inlines have engine offsets beyond ordinary w:t. Refuse ambiguity.
    protected = ('fldChar', 'fldSimple', 'instrText', 'softHyphen', 'noBreakHyphen', 'cr', 'drawing', 'object', 'pict', 'tab', 'br', 'del', 'ins', 'footnoteReference', 'endnoteReference', 'sym')
    if any(list(block.iter(q(t))) for t in protected) or list(block.iter('{' + M + '}oMath')):
        raise ValueError('此段包含公式、域或复杂内嵌对象，请直接编辑文字，或选择其他普通段落。')
    nodes = list(block.iter(q('t')))
    text = ''.join(x.text or '' for x in nodes)
    byte_start, byte_end = sorted((a['off'], b['off']))
    encoded = text.encode('utf-8')
    if type(byte_start) is not int or type(byte_end) is not int or not 0 <= byte_start < byte_end <= len(encoded):
        raise ValueError('选句与已保存 Word 不一致，请重新选句。')
    try:
        # Wordcraft Pos.off indexes UTF-8 bytes, not Unicode scalars or JS UTF-16.
        start = len(encoded[:byte_start].decode('utf-8'))
        end = len(encoded[:byte_end].decode('utf-8'))
    except UnicodeDecodeError as error:
        raise ValueError('选区位于中文或其他多字节字符内部，请重新选句。') from error
    if end-start > 4000 or text[start:end] != anchor['text']:
        raise ValueError('选句与已保存 Word 不一致，请重新选句。')
    return nodes, text, start, end


def patch(raw, root, nodes, start, end, replacement):
    # Expat indexes bytes, unlike ET serialization which rewrites namespace prefixes.
    spans, opened = [], []
    parser = expat.ParserCreate(namespace_separator='}')
    def begin(name, attrs):
        if name == W + '}t':
            offset = parser.CurrentByteIndex
            opened.append((offset, raw.index(b'>', offset) + 1))
    def finish(name):
        if name == W + '}t':
            tag_start, text_start = opened.pop()
            spans.append((tag_start, text_start, parser.CurrentByteIndex))
    parser.StartElementHandler, parser.EndElementHandler = begin, finish
    parser.Parse(raw, True)
    all_nodes = list(root.iter(q('t')))
    if len(spans) != len(all_nodes):
        raise ValueError('Word XML 文字锚点无法安全映射。')
    lookup = {id(node): span for node, span in zip(all_nodes, spans)}
    edits, pos, inserted = [], 0, False
    for node in nodes:
        text = node.text or ''; stop = pos + len(text)
        if stop > start and pos < end:
            left, right = max(0, start-pos), min(len(text), end-pos)
            new = text[:left] + (replacement if not inserted else '') + text[right:]
            inserted = True
            tag_start, s, e = lookup[id(node)]
            if raw[s-2:s] == b'/>':
                raise ValueError('无法修改空的 Word 文字锚点。')
            tag = raw[tag_start:s]
            if re.search(rb'\bxml:space\s*=', tag):
                tag = re.sub(rb'xml:space\s*=\s*([\'\"])[^\'\"]*\1', b'xml:space="preserve"', tag)
            else:
                tag = tag[:-1] + b' xml:space="preserve">'
            edits.append((tag_start, e, tag + escape(new).encode('utf-8')))
        pos = stop
    for s, e, value in sorted(edits, reverse=True):
        raw = raw[:s] + value + raw[e:]
    return raw


def main():
    args = json.load(sys.stdin)
    if os.name == 'nt':
        for key in ('path', 'output', 'undo'):
            if args.get(key) and not args[key].startswith('\\\\?\\'):
                absolute = os.path.abspath(args[key])
                args[key] = '\\\\?\\UNC\\' + absolute[2:] if absolute.startswith('\\\\') else '\\\\?\\' + absolute
    if args.get('restoreUndo'):
        restore(args['path'], args['undo'], args['output'])
        print(json.dumps({'restored': True}))
        return
    z, raw, root = load(args['path'])
    try:
        result = inspect(root)
        if 'formatting' in args:
            changed, result['formatting'] = format_document(raw, root, args['formatting'])
            if args.get('output'):
                result.update(replace_xml(args['path'], changed, args['output'], args.get('undo')))
        if 'selection' in args:
            nodes, text, start, end = selected(root, args['selection'])
            result['selectedText'] = text[start:end]
            if 'replacement' in args:
                replacement = args['replacement']
                if not isinstance(replacement, str) or not replacement or len(replacement) > 8000 or any(c in replacement for c in '\r\n\x00'):
                    raise ValueError('改写必须为有效的单段文字。')
                # Preserve leading/trailing whitespace: affected source runs already carry
                # xml:space in normal Word exports; reject otherwise rather than lose it.
                if replacement != replacement.strip():
                    raise ValueError('改写两端不能包含空格。')
                changed = patch(raw, root, nodes, start, end, replacement)
                ET.fromstring(changed)  # Refuse malformed replacements before any version is saved.
                result.update(replace_xml(args['path'], changed, args['output'], args.get('undo')))
        if args.get('summary'):
            result.pop('text', None)
            result['fontFamilies'] = font_families(z, root)
        print(json.dumps(result, ensure_ascii=False))
    finally:
        z.close()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, IndexError, ET.ParseError, zipfile.BadZipFile, expat.ExpatError) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
