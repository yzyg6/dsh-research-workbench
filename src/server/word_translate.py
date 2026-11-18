"""Build translation units and patch only the selected Word text nodes."""
import re
from collections import defaultdict
from pathlib import Path, PurePosixPath
from posixpath import normpath
import xml.etree.ElementTree as ET

from word_review import W, M, q, body_blocks, outline, xml_part
from word_zip import replace_xml


HAN = re.compile(r'[\u3400-\u9fff\uf900-\ufaff\U00020000-\U000323af]')
MARKER = re.compile(r'⟦\d+⟧')
REFERENCES = re.compile(r'^(?:\d+(?:[.．]\d+)*[.．、\s]+)?(?:参考文献(?:\s*[/（(]?\s*References[)）]?)?|References|Bibliography|Literature cited)\s*[:：]?$', re.I)
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
ART = ('drawing', 'pict', 'object')
PROTECTED = ('fldSimple', 'tab', 'br', 'cr', 'sym', 'softHyphen', 'noBreakHyphen',
             'footnoteReference', 'endnoteReference', 'separator', 'continuationSeparator') + ART
PROTECTED_TAGS = {q(name) for name in PROTECTED}


def located_paragraphs(container, prefix=()):
    for index, block in enumerate(node for node in container if node.tag in (q('p'), q('tbl'))):
        path = (*prefix, index)
        if block.tag == q('p'):
            yield path, block
        else:
            for ri, row in enumerate(block.findall(q('tr'))):
                for ci, cell in enumerate(row.findall(q('tc'))):
                    yield from located_paragraphs(cell, (*path, ri, ci))


def text_groups(paragraph):
    """Temporary markers keep equations, fields, breaks and inline styles in position."""
    groups, field = [], 0
    def barrier():
        if groups and groups[-1] is not None:
            groups.append(None)

    def walk(node, style=None, link=None):
        nonlocal field
        tag = node.tag
        if tag in (q('del'), q('rPr'), q('pPr'), q('moveFrom')):
            return
        if tag == q('fldChar'):
            action = node.get(q('fldCharType'))
            field = max(0, field + {'begin': 1, 'end': -1}.get(action, 0))
            barrier()
            return
        if field or tag in (q('instrText'), q('delText')):
            return
        if tag in PROTECTED_TAGS or tag in (f'{{{M}}}oMath', f'{{{M}}}oMathPara'):
            barrier()
            return
        if tag == q('r'):
            props = node.find(q('rPr'))
            # Track actual emphasis, not unrelated language or proofreading changes.
            emphasis = {'b', 'bCs', 'i', 'iCs', 'u', 'vertAlign', 'smallCaps', 'rStyle'}
            style = tuple(ET.tostring(prop) for prop in props if prop.tag.split('}')[-1] in emphasis) if props is not None else ()
        if tag == q('hyperlink'):
            link = id(node)
        if tag == q('t'):
            if node.text:
                key = (style, link)
                if groups and groups[-1] is not None and groups[-1][0] != key:
                    barrier()
                if not groups or groups[-1] is None:
                    groups.append((key, [node]))
                else:
                    groups[-1][1].append(node)
            return
        for child in node:
            if child.tag != q('p'):
                walk(child, style, link)

    walk(paragraph)
    if groups and groups[-1] is None:
        groups.pop()
    return groups


def unit(ordinal, paragraph, limits=None):
    groups = text_groups(paragraph)
    pieces, anchors, begin, count = [], [], 0, 0
    for group in groups:
        if group is None:
            continue
        nodes = group[1]
        text = ''.join(node.text for node in nodes)
        end = begin + len(text)
        left, right = (max(0, limits[0] - begin), min(len(text), limits[1] - begin)) if limits else (0, len(text))
        begin = end
        if left < right:
            if MARKER.search(text[left:right]):
                raise ValueError('原文含翻译保护标记，请先调整选区。')
            if pieces:
                count += 1
                pieces.append(f'⟦{count}⟧')
            pieces.append(text[left:right])
            anchors.append((nodes, left, right))
    source = ''.join(pieces)
    if not HAN.search(source):
        return None
    return {'id': f'p{ordinal}', 'source': source}, anchors


def scope_limits(selection, locations, to_offset):
    points = [selection.get('anchor', {}), selection.get('focus', {})]
    if any(point.get('story', 'body') != 'body' or type(point.get('path')) is not list
           or not point['path'] or len(point['path']) > 16
           or any(type(part) is not int or part < 0 for part in point['path'])
           or type(point.get('off')) is not int or point['off'] < 0 for point in points):
        raise ValueError('请在 Word 正文或表格中选择文字。')
    first, last = sorted(points, key=lambda point: (point['path'], point['off']))
    start, stop = tuple(first['path']), tuple(last['path'])
    if start not in locations or stop not in locations:
        raise ValueError('Word 选区无法对应到保存后的段落。')
    def complex_offsets(paragraph):
        return any(node.tag in PROTECTED_TAGS or node.tag in (q('fldChar'), q('ins'), q('del'))
                   or node.tag.startswith(f'{{{M}}}') for node in paragraph.iter())
    result, selected = {}, []
    for path, paragraph in locations.items():
        if not start <= path <= stop:
            continue
        groups = text_groups(paragraph)
        plain = ''.join(node.text for group in groups if group for node in group[1])
        complex_endpoints = complex_offsets(paragraph)
        if path == start == stop and complex_endpoints:
            text = selection.get('text', '').replace('\ufffc', '')
            begin = plain.find(text)
            if text and first['off'] != last['off'] and begin >= 0 and plain.find(text, begin + 1) < 0:
                return {paragraph: (begin, begin + len(text))}
        # Wordcraft offsets for ordinary paragraphs include comment sentinels.
        # Other inline objects can change the offset map, so reject ambiguous endpoint slices.
        def boundary(point):
            if point['off'] == 0:
                return 0
            if complex_endpoints:
                raise ValueError('选区端点包含复杂 Word 对象，请调整端点或使用全文翻译。')
            offset = to_offset(paragraph, point['off']) if selection.get('coordinate') == 'wordcraft' else point['off']
            data = plain.encode('utf-8')
            if not 0 <= offset <= len(data):
                raise ValueError('Word 选区与已保存的段落不一致。')
            return len(data[:offset].decode('utf-8'))
        left = boundary(first) if path == start else 0
        right = boundary(last) if path == stop else len(plain)
        if left < right:
            result[paragraph] = (left, right)
            selected.append(plain[left:right])
    def normalized(text):
        return re.sub(r'\s+|\ufffc', '', text)
    if not result or normalized(''.join(selected)) != normalized(selection.get('text', '')):
        raise ValueError('Word 选区与已保存的原文不一致，请重新选中文字。')
    return result


def images_in(archive, root, assignments):
    relation_part = 'word/_rels/document.xml.rels'
    relations = {}
    if relation_part in archive.namelist():
        for relation in ET.fromstring(xml_part(archive, relation_part)):
            if relation.get('Type', '').endswith('/image') and relation.get('TargetMode') != 'External':
                target = relation.get('Target', '')
                part = normpath(target.lstrip('/') if target.startswith('/') else str(PurePosixPath('word') / target))
                if part in archive.namelist() and part.startswith('word/media/'):
                    relations[relation.get('Id')] = part
    report = defaultdict(list)
    for paragraph in root.iter(q('p')):
        if paragraph not in assignments:
            continue
        section, _ = assignments[paragraph]
        art = [item for item in paragraph if item.tag != q('pPr')]
        for drawing in (item for node in art for item in node.iter() if item.tag in (q(t) for t in ART)):
            description = ' '.join(value for item in drawing.iter() for key, value in item.attrib.items()
                                   if key.split('}')[-1] in ('descr', 'title', 'alt'))
            parts = list(dict.fromkeys(relations[image_id] for node in drawing.iter()
                                        for attr in ('embed', 'id', 'link')
                                        if (image_id := node.get(f'{{{R}}}{attr}')) in relations))
            if parts or not list(drawing.iter(q('p'))):
                report[section].append({'description': description[:200], 'parts': parts,
                                        'state': 'chinese' if HAN.search(description) else 'unknown'})
    return report


def inspect_translation(archive, root, selection, to_offset):
    body = root.find(q('body'))
    locations = dict(located_paragraphs(body))
    paths = {paragraph: list(path) for path, paragraph in locations.items()}
    ordinals = {node: index for index, node in enumerate(body.iter(q('p')))}
    limits = scope_limits(selection, locations, to_offset) if selection else None
    sections = {item['heading']: item for item in outline(archive, root, include_empty=True) if item['heading'] is not None}
    top_indices = {node: index for index, node in enumerate(body_blocks(root))}
    headings, parts, assignments = {0: '文首'}, {0: {'id': 'c0', 'title': '文首'}}, {}
    section, reference_level, reference_mode = 0, None, False
    part = parts[0]
    for block in body:
        block_index = top_indices.get(block)
        heading = sections.get(block_index)
        text = ''.join(node.text or '' for node in block.iter(q('t'))).strip() if block.tag == q('p') else ''
        references = bool(REFERENCES.fullmatch(text))
        if heading or references:
            section = (block_index or 0) + 1
            headings[section] = heading['title'] if heading else text
            level = len(heading['path']) if heading else 1
            if level == 1:
                part = {'id': f'c{section}', 'title': headings[section]}
            parts[section] = part
            if references:
                reference_level, reference_mode = level, True
            elif reference_level is None or level <= reference_level:
                reference_level, reference_mode = None, False
        for paragraph in block.iter(q('p')):
            if limits is not None and paragraph not in limits:
                continue
            if reference_mode and paragraph is not block:
                continue
            if reference_mode and not references:
                continue
            assignments[paragraph] = (section, bool(paragraph is block and (heading or references)))
    groups, anchors = defaultdict(list), {}
    for paragraph, (section, title) in assignments.items():
        item = unit(ordinals[paragraph], paragraph, limits.get(paragraph) if limits else None)
        if item:
            public, targets = item
            style = paragraph.find(f'{q("pPr")}/{q("pStyle")}')
            named_caption = style is not None and re.search(r'caption|题注', style.get(q('val'), ''), re.I)
            if title:
                public['kind'] = 'heading'
            elif named_caption or re.match(r'^\s*[图表]\s*\d', public['source']):
                public['kind'] = 'caption'
            elif len(paths.get(paragraph, [])) > 1:
                public['kind'] = 'table-cell'
            else:
                public['kind'] = 'paragraph'
            if paragraph in paths:
                public['path'] = paths[paragraph]
            groups[section].append(public)
            anchors[public['id']] = targets
    art = images_in(archive, root, assignments)
    chapters = [{'id': f'c{key}', 'title': headings[key], 'part': parts[key], 'units': groups[key],
                 'images': art[key]} for key in headings if groups[key] or art[key]]
    if not any(chapter['units'] for chapter in chapters):
        raise ValueError('所选范围没有可翻译的中文正文。')
    return chapters, anchors


def apply_translation(source, source_bytes, raw, root, anchors, versions, output, text_anchors, run_edit, apply_edits):
    offsets = text_anchors(raw, root)
    edits = []
    for key, english in versions.items():
        groups = anchors[key]
        pieces = MARKER.split(english)
        if len(pieces) != len(groups):
            raise ValueError('译文已改变公式、域或行内格式的位置。')
        for (nodes, left, right), value in zip(groups, pieces):
            cursor = 0
            inserted = False
            for node in nodes:
                text = node.text
                if left < cursor + len(text) and cursor < right:
                    start, end = max(0, left - cursor), min(len(text), right - cursor)
                    changed = text[:start] + (value if not inserted else '') + text[end:]
                    if changed != text:
                        edits.append(run_edit(raw, offsets[id(node)], changed))
                    inserted = True
                cursor += len(text)
    changed = apply_edits(raw, edits)
    ET.fromstring(changed)
    replace_xml(source, changed, output, source_bytes=source_bytes)


def extract_images(archive, requested, directory):
    files = []
    for index, part in enumerate(dict.fromkeys(requested)):
        suffix = PurePosixPath(part).suffix.lower()
        if index >= 160 or suffix not in ('.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.gif', '.svg') or not part.startswith('word/media/'):
            continue
        info = archive.getinfo(part)
        if info.file_size > 12 * 1024 * 1024:
            continue
        path = Path(directory) / f'{index}{suffix}'
        path.write_bytes(archive.read(info))
        files.append({'part': part, 'path': str(path)})
    return files
