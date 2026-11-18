"""Read a manuscript outline and add paragraph-anchored OOXML comments."""
from datetime import datetime, timezone
from pathlib import PurePosixPath
from xml.parsers import expat
from xml.sax.saxutils import escape, quoteattr
import re
import zipfile
import xml.etree.ElementTree as ET

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
M = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
COMMENT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments'
COMMENT_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'
W14 = 'http://schemas.microsoft.com/office/word/2010/wordml'
W15 = 'http://schemas.microsoft.com/office/word/2012/wordml'
EXT_REL = 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended'
EXT_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml'
RELS = 'word/_rels/document.xml.rels'
TYPES = '[Content_Types].xml'
q = lambda name: f'{{{W}}}{name}'


def body_blocks(root: ET.Element) -> list[ET.Element]:
    return [node for node in root.find(q('body')) if node.tag in (q('p'), q('tbl'))]


def xml_part(archive: zipfile.ZipFile, name: str) -> bytes:
    raw = archive.read(name)
    if b'\x00' in raw or re.search(br'<!DOCTYPE|<!ENTITY', raw, re.I):
        raise ValueError('Word 批注需要无实体声明的 UTF-8 XML。')
    raw.decode('utf-8-sig')
    return raw


def paragraphs(root: ET.Element) -> dict[int, str]:
    return {i: ''.join(item.text or '' for item in node.iter(q('t')))
            for i, node in enumerate(body_blocks(root)) if node.tag == q('p')}


def outline(archive: zipfile.ZipFile, root: ET.Element, *, include_empty=False) -> list[dict]:
    styles = {}
    if 'word/styles.xml' in archive.namelist():
        for style in ET.fromstring(xml_part(archive, 'word/styles.xml')).findall(q('style')):
            styles[style.get(q('styleId'))] = style

    def heading_level(node: ET.Element, text: str) -> int | None:
        props = node.find(q('pPr'))
        style_id = None
        if props is not None:
            direct = props.find(q('outlineLvl'))
            if direct is not None and direct.get(q('val'), '').isdigit():
                return min(int(direct.get(q('val'))), 9) + 1 if int(direct.get(q('val'))) < 9 else None
            style = props.find(q('pStyle'))
            style_id = style.get(q('val')) if style is not None else None
        visited = set()
        while style_id and style_id not in visited:
            visited.add(style_id)
            style = styles.get(style_id)
            name = style.find(q('name')) if style is not None else None
            for label in (style_id, name.get(q('val'), '') if name is not None else ''):
                named = re.fullmatch(r'(?:heading|标题)\s*([1-9])', label, re.I)
                if named:
                    return int(named[1])
            if style is None:
                break
            level = style.find(f'{q("pPr")}/{q("outlineLvl")}')
            if level is not None and level.get(q('val'), '').isdigit() and int(level.get(q('val'))) < 9:
                return int(level.get(q('val'))) + 1
            base = style.find(q('basedOn'))
            style_id = base.get(q('val')) if base is not None else None
        if len(text) > 90 or re.search(r'[。！？!?]\s*$', text):
            return None
        if re.fullmatch(r'摘要|引言|参考文献|致谢|附录|Abstract|Introduction|(?:Materials and )?Methods|Results|Discussion|Conclusions?|References|Acknowledg[e]?ments', text, re.I):
            return 1
        if re.match(r'^第[一二三四五六七八九十\d]+[章节]\s*\S', text):
            return 1
        numbered = re.match(r'^(\d{1,2}(?:[.．]\d{1,2}){0,5})(?:[.．、]|\s+)\s*(?![\d％%])\S', text)
        return len(re.split(r'[.．]', numbered[1])) if numbered else None

    def visible(node: ET.Element) -> str:
        if node.tag == f'{{{M}}}oMath':
            return '〔公式 ' + ''.join(item.text or '' for item in node.iter(f'{{{M}}}t')) + '〕'
        if node.tag == q('t'):
            return node.text or ''
        if node.tag in (q('tab'), q('br'), q('cr')):
            return ' '
        if node.tag in (q('drawing'), q('pict')):
            return '〔插图〕'
        return ''.join(visible(child) for child in node)

    sections, hierarchy = [], []
    current = {'title': '文首', 'path': ['文首'], 'heading': None, 'paragraphs': []}
    exact = paragraphs(root)
    for index, node in enumerate(body_blocks(root)):
        if node.tag == q('tbl'):
            rows = [' | '.join(visible(cell).strip() for cell in row.findall(q('tc'))) for row in node.findall(q('tr'))]
            if any(rows):
                current['paragraphs'].append({'index': index, 'text': '〔表格〕\n' + '\n'.join(rows), 'anchorable': False})
            continue
        text = visible(node).strip()
        if not text:
            continue
        level = heading_level(node, text)
        if level:
            if current['paragraphs'] or include_empty and current['heading'] is not None:
                sections.append(current)
            hierarchy = [(depth, title) for depth, title in hierarchy if depth < level]
            hierarchy.append((level, text[:180]))
            current = {'title': text[:180], 'path': [title for _, title in hierarchy], 'heading': index, 'paragraphs': []}
        else:
            current['paragraphs'].append({'index': index, 'text': text, 'anchorable': bool(exact[index].strip())})
    if current['paragraphs'] or include_empty and current['heading'] is not None:
        sections.append(current)
    return sections


def element_close(raw: bytes, expected: str) -> int:
    parser = expat.ParserCreate(namespace_separator=' ')
    starts, endings = [], []

    def start(tag, _attrs):
        starts.append(tag)

    def end(tag):
        starts.pop()
        if not starts and tag == expected:
            endings.append(parser.CurrentByteIndex)

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.Parse(raw, True)
    if not endings:
        raise ValueError('无法识别 Word 批注部件的根元素。')
    return endings[0]


def append_elements(raw: bytes, namespace: str, tag: str, content: bytes) -> bytes:
    offset = element_close(raw, namespace + ' ' + tag)
    if raw[offset:offset + 2] == b'</':
        return raw[:offset] + content + raw[offset:]
    # Expat reports the byte immediately after the opening self-closing tag.
    match = re.search(br'<([a-zA-Z0-9_.:-]+)(?:\s[^<]*)?/\s*>\s*$', raw[:offset])
    if not match:
        raise ValueError('无法扩展空的 Word 批注部件。')
    slash = raw.rfind(b'/', match.start(), offset)
    return raw[:slash] + b'>' + content + b'</' + match[1] + b'>' + raw[offset:]


def anchor_comments(raw: bytes, groups: dict[int, list[int]]) -> bytes:
    parser = expat.ParserCreate(namespace_separator=' ')
    stack, edits = [], []
    block_index = -1

    def marker(tag, number):
        return f'<rw:{tag} xmlns:rw="{W}" rw:id="{number}"/>'.encode()

    def start(tag, _attrs):
        nonlocal block_index
        if stack == [W + ' document', W + ' body'] and tag in (W + ' p', W + ' tbl'):
            block_index += 1
        if len(stack) == 3 and stack[-1] == W + ' p' and block_index in groups and tag != W + ' pPr':
            if not any(index == block_index and kind == 'start' for index, kind, _, _ in edits):
                edits.append((block_index, 'start', parser.CurrentByteIndex,
                              b''.join(marker('commentRangeStart', n) for n in groups[block_index])))
        stack.append(tag)

    def end(tag):
        stack.pop()
        if stack == [W + ' document', W + ' body'] and tag == W + ' p' and block_index in groups:
            suffix = b''.join(marker('commentRangeEnd', n) for n in reversed(groups[block_index]))
            for n in groups[block_index]:
                suffix += f'<rw:r xmlns:rw="{W}"><rw:rPr><rw:rStyle rw:val="CommentReference"/></rw:rPr><rw:commentReference rw:id="{n}"/></rw:r>'.encode()
            edits.append((block_index, 'end', parser.CurrentByteIndex, suffix))

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.Parse(raw, True)
    if len(edits) != 2 * len(groups):
        raise ValueError('部分审阅段落无法安全锚定。')
    for _, _, offset, content in reversed(edits):
        raw = raw[:offset] + content + raw[offset:]
    ET.fromstring(raw)
    return raw


def comment_lines(finding):
    return [line for item in (f'[{finding["id"]}] {finding["issue"]}', f'建议：{finding["suggestion"]}',
                              f'修改路径：{finding["steps"]}', f'提示词：{finding["prompt"]}') for line in item.splitlines()]


def add_comments(archive: zipfile.ZipFile, root: ET.Element, findings: list[dict], output: str, stamp=None) -> None:
    text = paragraphs(root)
    rels = xml_part(archive, RELS) if RELS in archive.namelist() else f'<Relationships xmlns="{REL}"/>'.encode()
    relations = ET.fromstring(rels)
    existing = [item for item in relations if item.get('Type') == COMMENT_REL]
    if len(existing) > 1:
        raise ValueError('Word 含多个批注关系，无法安全写入。')
    if existing:
        target = existing[0].get('Target', '')
        path = target.lstrip('/') if target.startswith('/') else str(PurePosixPath('word', target))
        if existing[0].get('TargetMode') == 'External' or '..' in PurePosixPath(path).parts or path not in archive.namelist():
            raise ValueError('Word 既有批注关系无法安全读取。')
    else:
        path = 'word/comments.xml'
        if path in archive.namelist():
            raise ValueError('Word 含未关联的批注部件，无法安全写入。')
        ids = {item.get('Id') for item in relations}
        key = next(f'rIdReview{i}' for i in range(len(ids) + 1) if f'rIdReview{i}' not in ids)
        rels = append_elements(rels, REL, 'Relationships',
                               f'<Relationship xmlns="{REL}" Id="{key}" Type="{COMMENT_REL}" Target="comments.xml"/>'.encode())

    comments = xml_part(archive, path) if existing else f'<w:comments xmlns:w="{W}"/>'.encode()
    annotations = {int(value) for node in ET.fromstring(comments).iter()
                   if (value := node.get(q('id'))) is not None and value.isdecimal()}
    annotations.update(int(value) for node in root.iter()
                       if node.tag in (q('commentRangeStart'), q('commentRangeEnd'), q('commentReference'))
                       and (value := node.get(q('id'))) is not None and value.isdecimal())
    number = max(annotations, default=-1) + 1
    if number + len(findings) >= 2 ** 31:
        raise ValueError('Word 批注 ID 超出范围。')
    stamp = stamp or datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    groups, entries = {}, []
    for finding in findings:
        index, quote = finding['index'], finding['quote']
        if not quote or quote not in text.get(index, ''):
            raise ValueError('审阅锚点已变动，批注未写入。')
        groups.setdefault(index, []).append(number)
        author = quoteattr('科研工作台 · ' + finding['author'][:45])
        body = ''.join(f'<w:p><w:r><w:t xml:space="preserve">{escape(line)}</w:t></w:r></w:p>' for line in comment_lines(finding))
        entries.append(f'<w:comment xmlns:w="{W}" w:id="{number}" w:author={author} w:initials="RW" w:date="{stamp}">{body}</w:comment>')
        number += 1

    types = xml_part(archive, TYPES)
    parts = ET.fromstring(types)
    overrides = [item for item in parts if item.get('PartName') == '/' + path]
    if overrides and any(item.get('ContentType') != COMMENT_CT for item in overrides):
        raise ValueError('Word 批注的内容类型有冲突。')
    changed = {'word/document.xml': anchor_comments(xml_part(archive, 'word/document.xml'), groups),
               path: append_elements(comments, W, 'comments', ''.join(entries).encode())}
    if not existing:
        changed[RELS] = rels
    if not overrides:
        changed[TYPES] = append_elements(types, CT, 'Types',
                                         f'<Override xmlns="{CT}" PartName={quoteattr("/" + path)} ContentType="{COMMENT_CT}"/>'.encode())
    for value in changed.values():
        ET.fromstring(value)
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, allowZip64=False) as result:
        result.comment = archive.comment
        for member in archive.infolist():
            content = changed.pop(member.filename, None)
            result.writestr(member, archive.read(member) if content is None else content)
        for name, content in changed.items():
            result.writestr(name, content)


def related_part(archive, relations, kind):
    matches = [item for item in relations if item.get('Type') == kind]
    if not matches:
        return None
    if len(matches) != 1 or matches[0].get('TargetMode') == 'External':
        raise ValueError('Word 批注部件关系有冲突。')
    target = matches[0].get('Target', '')
    path = target.lstrip('/') if target.startswith('/') else str(PurePosixPath('word', target))
    if '..' in PurePosixPath(path).parts or path not in archive.namelist():
        raise ValueError('Word 批注部件无法安全读取。')
    return path


def opening_tags(raw, namespace, tag):
    parser = expat.ParserCreate(namespace_separator=' ')
    parser.namespace_prefixes = True
    result = []
    pattern = re.compile(br'''<(?:[^>"']|"[^"]*"|'[^']*')*>''')

    def start(name, attrs):
        key = name.split(' ', 2)
        if key[:2] == [namespace, tag]:
            offset = parser.CurrentByteIndex
            token = pattern.match(raw, offset).group()
            result.append((offset, token, attrs))

    parser.StartElementHandler = start
    parser.Parse(raw, True)
    return result


def attribute_edit(tag, namespace, name, value):
    offset, token, attrs = tag
    qualified = next((key.rsplit(' ', 1)[-1] + ':' + name for key in attrs if key.startswith(namespace + ' ' + name + ' ')), None)
    if qualified:
        pattern = rb'(\s' + re.escape(qualified.encode()) + rb'\s*=\s*)(["\'])[^"\']*\2'
        replacement = re.sub(pattern, lambda match: match[1] + b'"' + value.encode() + b'"', token, count=1)
    else:
        prefix = 'rwReview'
        while f'xmlns:{prefix}='.encode() in token:
            prefix += 'x'
        suffix = b'/>' if token.endswith(b'/>') else b'>'
        attr = f' xmlns:{prefix}="{namespace}" {prefix}:{name}="{value}"'.encode()
        replacement = token[:-len(suffix)] + attr + suffix
    return offset, offset + len(token), replacement


def apply_edits(raw, edits):
    for start, end, value in sorted(edits, reverse=True):
        raw = raw[:start] + value + raw[end:]
    ET.fromstring(raw)
    return raw


def resolve_comments(archive, targets):
    if RELS not in archive.namelist():
        return {}, ['missing'] * len(targets), []
    rels = xml_part(archive, RELS)
    relations = ET.fromstring(rels)
    path = related_part(archive, relations, COMMENT_REL)
    if not path:
        return {}, ['missing'] * len(targets), []
    comments = xml_part(archive, path)
    root = ET.fromstring(comments)
    pid = f'{{{W14}}}paraId'
    ex = lambda key: f'{{{W15}}}{key}'
    elements = list(root.iter(q('p')))
    tags = dict(zip(elements, opening_tags(comments, W, 'p')))
    ids = [node.get(pid).upper() for node in elements if node.get(pid)]
    busy_ids = set(ids)
    ext_path = related_part(archive, relations, EXT_REL)
    ext = xml_part(archive, ext_path) if ext_path else f'<w15:commentsEx xmlns:w15="{W15}"/>'.encode()
    ext_root = ET.fromstring(ext)
    ext_nodes = list(ext_root.iter(ex('commentEx')))
    extra = dict(zip(ext_nodes, opening_tags(ext, W15, 'commentEx')))
    normalize = lambda value: re.sub(r'\s+', '', value)
    bodies = [(comment, normalize(''.join(node.text or '' for node in comment.iter(q('t'))))) for comment in root.findall(q('comment'))]
    matches, comment_edits, ext_edits, additions = [], [], [], []
    resolved_ids = []
    claimed = set()
    next_id = 0x20000000
    for target in targets:
        expected = normalize(''.join(comment_lines(target)))
        author = '科研工作台 · ' + target['author'][:45]
        candidates = [node for node, body in bodies if body == expected and node.get(q('author')) == author
                      and (not target.get('date') or node.get(q('date')) == target['date'])]
        if len(candidates) != 1:
            matches.append('ambiguous' if candidates else 'missing')
            continue
        if candidates[0] in claimed:
            matches.append('ambiguous')
            continue
        claimed.add(candidates[0])
        paragraph = list(candidates[0].iter(q('p')))[-1]
        key = (paragraph.get(pid) or '').upper()
        if key and (ids.count(key) != 1 or not re.fullmatch(r'[0-7][0-9A-F]{7}', key)):
            matches.append('ambiguous')
            continue
        if not key:
            while f'{next_id:08X}' in busy_ids:
                next_id += 1
            key = f'{next_id:08X}'
            busy_ids.add(key)
            comment_edits.append(attribute_edit(tags[paragraph], W14, 'paraId', key))
        existing = [node for node in ext_nodes if (node.get(ex('paraId')) or '').upper() == key]
        if len(existing) > 1 or existing and existing[0].get(ex('paraIdParent')):
            matches.append('ambiguous')
            continue
        if existing:
            if existing[0].get(ex('done')) not in ('1', 'true', 'on'):
                ext_edits.append(attribute_edit(extra[existing[0]], W15, 'done', '1'))
        else:
            additions.append(f'<w15:commentEx xmlns:w15="{W15}" w15:paraId="{key}" w15:done="1"/>'.encode())
        matches.append('resolved')
        comment_id = candidates[0].get(q('id'), '')
        if comment_id.isdecimal():
            resolved_ids.append(int(comment_id))
    changed = {path: apply_edits(comments, comment_edits)} if comment_edits else {}
    if not ext_edits and not additions:
        return changed, matches, resolved_ids
    if not ext_path:
        ext_path = 'word/commentsExtended.xml'
        if ext_path in archive.namelist():
            raise ValueError('Word 含未关联的扩展批注部件。')
        used = {item.get('Id') for item in relations}
        rel_id = next(f'rIdReview{i}' for i in range(len(used) + 1) if f'rIdReview{i}' not in used)
        changed[RELS] = append_elements(rels, REL, 'Relationships',
                                        f'<Relationship xmlns="{REL}" Id="{rel_id}" Type="{EXT_REL}" Target="commentsExtended.xml"/>'.encode())
        types = xml_part(archive, TYPES)
        entries = [item for item in ET.fromstring(types) if item.get('PartName') == '/' + ext_path]
        if entries and any(item.get('ContentType') != EXT_CT for item in entries):
            raise ValueError('Word 扩展批注的内容类型有冲突。')
        if not entries:
            changed[TYPES] = append_elements(types, CT, 'Types',
                                             f'<Override xmlns="{CT}" PartName="/{ext_path}" ContentType="{EXT_CT}"/>'.encode())
    ext = apply_edits(ext, ext_edits)
    changed[ext_path] = append_elements(ext, W15, 'commentsEx', b''.join(additions)) if additions else ext
    ET.fromstring(changed[ext_path])
    return changed, matches, resolved_ids
