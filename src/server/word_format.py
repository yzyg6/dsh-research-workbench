"""Bounded formatting of plain body runs; preserve unrelated XML and ZIP bytes."""
import re
import xml.etree.ElementTree as ET
from xml.parsers import expat
from xml.sax.saxutils import escape

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
M = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
Q = lambda name: '{' + W + '}' + name


def spans(raw, root):
    parser = expat.ParserCreate(namespace_separator='}')
    opened, finished = [], []
    def begin(name, _attrs):
        start = parser.CurrentByteIndex
        # XML names and quoted attribute values may contain >.
        quote, end = None, start
        while end < len(raw):
            value = raw[end]
            if quote:
                if value == quote:
                    quote = None
            elif value in (34, 39):
                quote = value
            elif value == 62:
                break
            end += 1
        opened.append([name, start, end + 1, raw[start:end].rstrip().endswith(b'/')])
    def finish(name):
        entry = opened.pop()
        entry.append(entry[2] if entry[3] else parser.CurrentByteIndex)
        entry.append(entry[2] if entry[3] else raw.index(b'>', parser.CurrentByteIndex) + 1)
        finished.append(entry)
    parser.StartElementHandler, parser.EndElementHandler = begin, finish
    parser.Parse(raw, True)
    entries = sorted(finished, key=lambda item: item[1])
    nodes = list(root.iter())
    if len(entries) != len(nodes):
        raise ValueError('格式修改无法安全定位 Word XML。')
    return {id(node): entry for node, entry in zip(nodes, entries)}


def clean_indices(text):
    removed = set()
    han = '\u3400-\u9fff\uf900-\ufaff'
    for match in re.finditer('(?<=[' + han + '])[ \u3000]+(?=[' + han + '，。；：！？、）】》])', text):
        removed.update(range(match.start(), match.end()))
    for match in re.finditer('(?<=[（【《，。；：！？、])[ \u3000]+(?=[' + han + '])', text):
        removed.update(range(match.start(), match.end()))
    for match in re.finditer(r' {2,}', text):
        if match.start() > 0:  # Preserve manually indented leading text.
            removed.update(range(match.start() + 1, match.end()))
    match = re.search('[ \u3000]+$', text)
    if match:
        removed.update(range(match.start(), match.end()))
    return removed


def format_document(raw, root, plan):
    operations = plan['operations']
    if not isinstance(operations, list) or not 1 <= len(operations) <= 8:
        raise ValueError('格式操作数量无效。')
    if any(not isinstance(op, dict) or op.get('type') not in ('normalize_spaces', 'set_font') for op in operations):
        raise ValueError('不支持此格式操作。')
    scope = plan.get('scope', 'body')
    if scope not in ('body', 'all_text'):
        raise ValueError('格式修改范围无效。')
    lookup = spans(raw, root)
    prefix_match = re.search(rb'xmlns:([\w.-]+)=[\'"]' + W.encode() + rb'[\'"]', raw)
    prefix = prefix_match.group(1).decode() if prefix_match else 'wfmt'
    ns = '' if prefix_match else ' xmlns:' + prefix + '="' + W + '"'
    tag = lambda name, attrs='': ('<' + prefix + ':' + name + ns + attrs + '/>').encode()
    edits, samples = [], []
    stats = {'removedSpaces': 0, 'formattedRuns': 0, 'skippedParagraphs': 0}
    clean = any(op['type'] == 'normalize_spaces' for op in operations)
    font = next((op for op in operations if op['type'] == 'set_font'), None)
    parents = {id(child): parent for parent in root.iter() for child in parent}
    for paragraph in root.find(Q('body')).iter(Q('p')):
        style = paragraph.find('./' + Q('pPr') + '/' + Q('pStyle'))
        style_name = style.get(Q('val'), '') if style is not None else ''
        ancestor, in_table = parents.get(id(paragraph)), False
        while ancestor is not None:
            in_table = in_table or ancestor.tag == Q('tbl')
            ancestor = parents.get(id(ancestor))
        if scope == 'body' and (in_table or re.search(r'heading|title|caption|标题|题注|toc', style_name, re.I)):
            continue
        protected = ('fldChar', 'fldSimple', 'instrText', 'ins', 'del', 'tab', 'drawing', 'object', 'pict')
        if re.search(r'code|代码|preformatted', style_name, re.I) or any(list(paragraph.iter(Q(name))) for name in protected) or list(paragraph.iter('{' + M + '}oMath')):
            stats['skippedParagraphs'] += 1
            continue
        nodes = list(paragraph.iter(Q('t')))
        text = ''.join(node.text or '' for node in nodes)
        removed = clean_indices(text) if clean else set()
        if removed:
            after = ''.join(char for index, char in enumerate(text) if index not in removed)
            if len(samples) < 30:
                samples.append({'before': text[:500], 'after': after[:500]})
            stats['removedSpaces'] += len(removed)
            pos = 0
            for node in nodes:
                value = node.text or ''
                changed = ''.join(char for index, char in enumerate(value, pos) if index not in removed)
                if changed != value:
                    _, start, content, empty, end, _ = lookup[id(node)]
                    if empty:
                        raise ValueError('无法修改自闭合的文字节点。')
                    edits.append((content, end, escape(changed).encode()))
                pos += len(value)
        if not font:
            continue
        for run in paragraph.iter(Q('r')):
            if run.find(Q('t')) is None:
                continue
            properties = run.find(Q('rPr'))
            family, latin = font.get('fontFamily'), font.get('latinFontFamily') or font.get('fontFamily')
            replacements = {}
            if family:
                attrs = ''.join(' ' + prefix + ':' + name + '="' + escape(value, {'"': '&quot;'}) + '"' for name, value in [('eastAsia', family), ('ascii', latin), ('hAnsi', latin), ('cs', latin)])
                replacements['rFonts'] = tag('rFonts', attrs)
            if font.get('fontSizePt') is not None:
                attrs = ' ' + prefix + ':val="' + str(round(font['fontSizePt'] * 2)) + '"'
                replacements.update({'sz': tag('sz', attrs), 'szCs': tag('szCs', attrs)})
            if properties is None:
                _, start, content, _, _, _ = lookup[id(run)]
                value = ('<' + prefix + ':rPr' + ns + '>').encode() + b''.join(replacements.values()) + ('</' + prefix + ':rPr>').encode()
                edits.append((content, content, value))
            else:
                _, start, content, empty, end, stop = lookup[id(properties)]
                existing = raw[start:stop]
                if empty:
                    value = ('<' + prefix + ':rPr' + ns + '>').encode() + b''.join(replacements.values()) + ('</' + prefix + ':rPr>').encode()
                else:
                    local = []
                    order = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange']
                    for name, value in replacements.items():
                        child = properties.find(Q(name))
                        if child is None:
                            later = next((item for item in properties if item.tag.startswith('{' + W + '}') and item.tag.split('}')[-1] in order and order.index(item.tag.split('}')[-1]) > order.index(name)), None)
                            position = lookup[id(later)][1] - start if later is not None else end - start
                            local.append((position, position, value))
                        else:
                            _, a, _, _, _, b = lookup[id(child)]
                            local.append((a-start, b-start, value))
                    value = existing
                    for a, b, replacement in sorted(local, reverse=True):
                        value = value[:a] + replacement + value[b:]
                if value == existing:
                    continue
                edits.append((start, stop, value))
            stats['formattedRuns'] += 1
    changed = raw
    for start, end, value in sorted(edits, reverse=True):
        changed = changed[:start] + value + changed[end:]
    ET.fromstring(changed)
    return changed, {**stats, 'samples': samples, 'changed': changed != raw, 'scope': scope}
