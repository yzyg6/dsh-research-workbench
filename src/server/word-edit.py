"""Bounded DOCX inspection and lossless single-paragraph text patching.

Only changed w:t payloads are rewritten. Unselected XML, namespace declarations,
relationships, equations and every other ZIP member retain their original bytes.
"""
import json
import re
import sys
import os
import zipfile
import io
import base64
from contextlib import redirect_stdout
from difflib import SequenceMatcher
from pathlib import Path
import xml.etree.ElementTree as ET
from xml.parsers import expat
from xml.sax.saxutils import escape
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.dont_write_bytecode = True
from word_zip import replace_parts, replace_xml, restore
from word_format import format_document
from word_review import outline, paragraphs as review_paragraphs, add_comments, resolve_comments

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
            'drawings': len(list(root.iter(q('drawing')))),
            'hasComments': next(root.iter(q('commentReference')), None) is not None}


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


def wordcraft_text_offset(block: ET.Element, offset: int) -> int:
    """Wordcraft retains each comment start/end as one UTF-8 inline sentinel."""
    cursor, visible = 0, 0
    for node in block.iter():
        if node.tag in (q('commentRangeStart'), q('commentRangeEnd')):
            if offset <= cursor + 3:
                return visible
            cursor += 3
        elif node.tag == q('t'):
            width = len((node.text or '').encode('utf-8'))
            if offset <= cursor + width:
                return visible + offset - cursor
            cursor += width
            visible += width
    return visible + offset - cursor


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
    if anchor.get('coordinate') == 'wordcraft' and all(type(off) is int for off in (byte_start, byte_end)):
        byte_start, byte_end = (wordcraft_text_offset(block, off) for off in (byte_start, byte_end))
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


def chapter_selection(root, selection):
    endpoints = [selection['anchor'], selection['focus']]
    for point in endpoints:
        path = point.get('path')
        if point.get('story', 'body') != 'body' or not isinstance(path, list) or len(path) != 1 or type(path[0]) is not int or path[0] < 0 or type(point.get('off')) is not int or point['off'] < 0:
            raise ValueError('请选择 Word 正文中连续的普通段落。')
    first, last = sorted(endpoints, key=lambda point: (point['path'][0], point['off']))
    start, end = first['path'][0], last['path'][0]
    body = root.find(q('body'))
    blocks = [node for node in body if node.tag in (q('p'), q('tbl'))]
    allowed = ('p', 'tbl', 'sectPr', 'bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd')
    if any(node.tag not in tuple(map(q, allowed)) for node in body) or end >= len(blocks):
        raise ValueError('章节选区含有无法安全定位的 Word 结构。')
    if selection.get('coordinate') == 'wordcraft':
        first = {**first, 'off': wordcraft_text_offset(blocks[start], first['off'])}
        last = {**last, 'off': wordcraft_text_offset(blocks[end], last['off'])}
    if end > start and last['off'] == 0:
        end -= 1 # A selection ending at the next paragraph's start excludes it.
    if not 2 <= end-start+1 <= 30:
        raise ValueError('章节优化请选择连续的 2–30 个正文段落。')

    def plain(node):
        return ''.join(text.text or '' for text in node.iter(q('t')))

    def is_heading(node):
        props = node.find(q('pPr'))
        if props is None:
            return False
        style = props.find(q('pStyle'))
        return props.find(q('outlineLvl')) is not None or (
            style is not None and bool(re.search(r'heading|标题|^title$', style.get(q('val'), ''), re.I)))

    paragraphs, ranges = [], []
    for index in range(start, end+1):
        block = blocks[index]
        text = plain(block)
        props = block.find(q('pPr'))
        if block.tag != q('p') or is_heading(block) or (props is not None and any(props.find(q(name)) is not None for name in ('numPr', 'sectPr'))):
            raise ValueError('章节优化请选择小节正文，避开标题、编号列表、表格和分节符。')
        runs = [run for run in block.findall(q('r')) if not (
            run.find(q('commentReference')) is not None and
            all(child.tag in (q('rPr'), q('commentReference')) for child in run))]
        if any(child.tag not in (q('pPr'), q('r'), q('commentRangeStart'), q('commentRangeEnd')) for child in block) or any(child.tag not in (q('rPr'), q('t')) for run in runs for child in run):
            raise ValueError('章节选区含有公式、域、超链接或其他复杂结构，请缩小选区。')
        if not text.strip():
            continue # Blank paragraphs keep their place in the document.
        styles = set()
        for run in runs:
            if any(item.text for item in run.findall(q('t'))):
                properties = run.find(q('rPr'))
                styles.add(ET.tostring(properties) if properties is not None else b'')
        if len(styles) > 1 or text != text.strip() or len(text) > 4000:
            raise ValueError('章节选区含有混合行内格式或过长段落，请缩小选区或按自然段精修。')
        point = {'story': 'body', 'path': [index], 'off': 0}
        exact = {'anchor': point, 'focus': {**point, 'off': len(text.encode('utf-8'))}, 'text': text}
        ranges.append((*selected(root, exact), index))
        paragraphs.append(text)
    if len(paragraphs) < 2 or sum(map(len, paragraphs)) > 16000:
        raise ValueError('章节优化需要至少两个有效段落，合计不超过 16000 字符。')

    pieces = []
    for index in range(start, last['path'][0]+1):
        data = plain(blocks[index]).encode('utf-8')
        left = first['off'] if index == start else 0
        right = last['off'] if index == last['path'][0] else len(data)
        if not 0 <= left <= right <= len(data):
            raise ValueError('章节选区与已保存 Word 不一致，请重新选择。')
        pieces.append(data[left:right].decode('utf-8'))
    # Wordcraft may use paragraph separators that differ from XML's newlines.
    if re.sub(r'\s+', '', '\n'.join(pieces)) != re.sub(r'\s+', '', selection['text']):
        raise ValueError('章节选区与已保存 Word 不一致，请重新选择。')
    return paragraphs, ranges, {
        'heading': next((plain(node)[:300] for node in reversed(blocks[:start]) if is_heading(node)), ''),
        'before': [plain(node)[:1200] for node in blocks[max(0,start-2):start]],
        'after': [plain(node)[:1200] for node in blocks[end+1:end+3]],
    }


def text_anchors(raw, root):
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
    return {id(node): span for node, span in zip(all_nodes, spans)}


def patch_edits(raw, lookup, nodes, start, end, replacement):
    edits, pos, inserted = [], 0, False
    for node in nodes:
        text = node.text or ''; stop = pos + len(text)
        if stop > start and pos < end:
            left, right = max(0, start-pos), min(len(text), end-pos)
            new = text[:left] + (replacement if not inserted else '') + text[right:]
            inserted = True
            edits.append(run_edit(raw, lookup[id(node)], new))
        pos = stop
    return edits


def run_edit(raw, location, new):
    tag_start, start, end = location
    if raw[start-2:start] == b'/>':
        raise ValueError('无法修改空的 Word 文字锚点。')
    tag = raw[tag_start:start]
    if re.search(rb'\bxml:space\s*=', tag):
        tag = re.sub(rb'xml:space\s*=\s*([\'\"])[^\'\"]*\1', b'xml:space="preserve"', tag)
    else:
        tag = tag[:-1] + b' xml:space="preserve">'
    return tag_start, end, tag + escape(new).encode('utf-8')


def text_changes(original, replacement, offset=0):
    return [(offset+i, offset+j, replacement[k:l]) for kind, i, j, k, l in
            SequenceMatcher(None, original, replacement, autojunk=False).get_opcodes() if kind != 'equal']


def patch_changed_text(raw, root, nodes, changes):
    anchors = text_anchors(raw, root)
    edits, pos = [], 0
    for node in nodes:
        text = node.text or ''
        if not text:
            continue
        stop = pos + len(text)
        new = text
        for left, right, value in reversed(changes):
            if left == right:
                if pos < left <= stop or left == pos == 0:
                    at = left - pos
                    new = new[:at] + value + new[at:]
            elif pos < right and left < stop:
                insertion = value if left >= pos else ''
                new = new[:max(0, left-pos)] + insertion + new[min(len(text), right-pos):]
        if new != text:
            edits.append(run_edit(raw, anchors[id(node)], new))
        pos = stop
    return apply_edits(raw, edits)


def apply_edits(raw, edits):
    for s, e, value in sorted(edits, reverse=True):
        raw = raw[:s] + value + raw[e:]
    return raw


def patch(raw, root, nodes, start, end, replacement):
    return apply_edits(raw, patch_edits(raw, text_anchors(raw, root), nodes, start, end, replacement))


def main(args=None):
    args = json.load(sys.stdin) if args is None else args
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
        if args.get('reviewOutline'):
            print(json.dumps({'sections': outline(z, root), 'paragraphs': review_paragraphs(root)}, ensure_ascii=False))
            return
        if 'reviewComments' in args:
            add_comments(z, root, args['reviewComments'], args['output'], args.get('reviewCommentDate'))
            print(json.dumps({'comments': len(args['reviewComments'])}))
            return
        parts = {}
        statuses = None
        if 'resolveReviewComments' in args:
            parts, statuses, resolved_ids = resolve_comments(z, args['resolveReviewComments'])
            if 'selection' not in args and 'chapterSelection' not in args:
                result = {'reviewCommentStates': statuses, 'changed': bool(parts)}
                if parts and args.get('output'):
                    result.update(replace_parts(args['path'], parts, args['output'], args.get('undo')))
                print(json.dumps(result))
                return
        result = inspect(root)
        live = []

        def write_document(changed):
            if parts:
                parts['word/document.xml'] = changed
                return replace_parts(args['path'], parts, args['output'], args.get('undo'))
            return replace_xml(args['path'], changed, args['output'], args.get('undo'))

        if 'formatting' in args:
            changed, result['formatting'] = format_document(raw, root, args['formatting'])
            if args.get('output'):
                result.update(write_document(changed))
        if 'chapterSelection' in args:
            paragraphs, ranges, surroundings = chapter_selection(root, args['chapterSelection'])
            result.update(chapterParagraphs=paragraphs, chapterSurroundings=surroundings)
            if 'chapterReplacement' in args:
                values = args['chapterReplacement']
                if not isinstance(values, list) or len(values) != len(paragraphs) or any(not isinstance(value, str) or not value or value != value.strip() or len(value)>4000 or any(c in value for c in '\r\n\x00') for value in values):
                    raise ValueError('章节改写必须提供与原文等量的非空段落。')
                anchors = text_anchors(raw, root)
                edits = []
                for (nodes, _, start, end, index), old, value in zip(ranges, paragraphs, values):
                    if value != old:
                        edits.extend(patch_edits(raw, anchors, nodes, start, end, value))
                        if args.get('liveRevision'):
                            live.append({'path': [index], 'before': old, 'after': value, 'changes': text_changes(old, value)})
                changed = apply_edits(raw, edits)
                ET.fromstring(changed)
                result.update(write_document(changed))
        if statuses is not None:
            result['reviewCommentStates'] = statuses
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
                if args.get('preserveRuns'):
                    changes = text_changes(text[start:end], replacement, start)
                    changed = patch_changed_text(raw, root, nodes, changes)
                    if args.get('liveRevision'):
                        live.append({'path': args['selection']['anchor']['path'], 'before': text,
                                     'after': text[:start] + replacement + text[end:], 'changes': changes})
                else:
                    changed = patch(raw, root, nodes, start, end, replacement)
                ET.fromstring(changed)  # Refuse malformed replacements before any version is saved.
                result.update(write_document(changed))
        if live and sum(len(part['changes']) for part in live) <= 48:
            if statuses is None or statuses == ['resolved'] and len(resolved_ids) == 1:
                result['liveRevision'] = {'paragraphs': live, 'resolvedCommentId': resolved_ids[0] if statuses else None}
        if args.get('summary'):
            result.pop('text', None)
            result['fontFamilies'] = font_families(z, root)
        print(json.dumps(result, ensure_ascii=False))
    finally:
        z.close()


def history_text(data):
    if len(data) > 32 * 1024 * 1024:
        raise ValueError('DOCX too large')
    lines = []
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = [name for name in archive.namelist() if name == 'word/document.xml' or
                 (name.startswith(('word/footnotes', 'word/endnotes', 'word/header', 'word/footer')) and name.endswith('.xml'))]
        if sum(archive.getinfo(name).file_size for name in names) > 32 * 1024 * 1024:
            raise ValueError('OOXML too large')
        for name in names:
            raw = archive.read(name)
            if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
                raise ValueError('不支持含实体声明的 Word。')
            root = ET.fromstring(raw)
            if name != 'word/document.xml':
                lines.append('\n[' + name + ']')
            for paragraph in root.iter(q('p')):
                lines.append(''.join(node.text or '' for node in paragraph.iter() if node.tag.endswith('}t')))
    return '\n'.join(lines) + '\n'


def worker():
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            args = request['args']
            if 'historyBase64' in args:
                result = {'text': history_text(base64.b64decode(args['historyBase64'], validate=True))}
            else:
                buffer = io.StringIO()
                with redirect_stdout(buffer):
                    main(args)
                result = json.loads(buffer.getvalue())
            response = {'id': request['id'], 'result': result}
        except Exception as error:
            response = {'id': request.get('id'), 'error': str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == '__main__' and '--worker' in sys.argv:
    worker()
elif __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, IndexError, ET.ParseError, zipfile.BadZipFile, expat.ExpatError) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
