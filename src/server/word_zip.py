"""Copy untouched ZIP blocks verbatim; a reversible edit stores only XML block + directory."""
import base64
import copy
import gzip
import hashlib
import io
import json
import struct
import zipfile
from pathlib import Path

LIMIT = 32 * 1024 * 1024
RECORD_LIMIT = 48 * 1024 * 1024
CD = struct.Struct(zipfile.structCentralDir)
END = struct.Struct(zipfile.structEndArchive)
MEMBER = 'word/document.xml'


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read(path: str) -> bytes:
    with open(path, 'rb') as stream:
        data = stream.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('Word 文件超过32 MiB。')
    return data


def directory_layout(data: bytes):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos, start = archive.infolist(), archive.start_dir
    if not infos or len(infos) > 4000:
        raise ValueError('Word ZIP 目录无效。')
    records, pos = [], start
    for info in infos:
        fields = list(CD.unpack_from(data, pos))
        if fields[0] != b'PK\x01\x02' or fields[18] != info.header_offset or info.extract_version >= 45:
            raise ValueError('此 Word 使用特殊 ZIP 格式，请使用直接编辑保存后再选句。')
        end = pos + CD.size + sum(fields[12:15])
        records.append((fields, data[pos + CD.size:end]))
        pos = end
    fields = list(END.unpack_from(data, pos))
    if (fields[0] != b'PK\x05\x06' or fields[1:3] != [0, 0]
            or fields[3:5] != [len(infos), len(infos)] or fields[5] != pos - start
            or fields[6] != start or pos + END.size + fields[7] != len(data)):
        raise ValueError('Word ZIP 目录不能安全重写。')
    return infos, start, records, fields, data[pos + END.size:]


def local_blocks(infos, start):
    ordered = sorted(infos, key=lambda item: item.header_offset)
    stops = [item.header_offset for item in ordered[1:]] + [start]
    return {item.filename: (item.header_offset, stop) for item, stop in zip(ordered, stops)}


def layout(data: bytes):
    infos, start, records, fields, comment = directory_layout(data)
    ordered = sorted(infos, key=lambda item: item.header_offset)
    member = next(item for item in ordered if item.filename == MEMBER)
    index = ordered.index(member)
    stop = ordered[index + 1].header_offset if index + 1 < len(ordered) else start
    return infos, start, records, fields, comment, member, stop


def replace_parts(source: str, parts: dict, output: str, undo: str = None) -> dict:
    data = read(source)
    infos, start, records, ending, comment = directory_layout(data)
    previous = local_blocks(infos, start)
    buffer = io.BytesIO()
    old_info = {item.filename: item for item in infos}
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED, allowZip64=False) as archive:
        for name, value in parts.items():
            existing = old_info.get(name)
            archive.writestr(copy.copy(existing) if existing else name, value)
    changed = buffer.getvalue()
    fresh_infos, fresh_start, fresh_records, _, _ = directory_layout(changed)
    replacements = local_blocks(fresh_infos, fresh_start)
    fresh = dict(zip((item.filename for item in fresh_infos), fresh_records))
    old = dict(zip((item.filename for item in infos), records))
    names = list(previous) + [name for name in replacements if name not in previous]
    blocks = [data[:next(iter(previous.values()))[0]]]
    offsets, cursor = {}, len(blocks[0])
    for name in names:
        offsets[name] = cursor
        origin, (a, b) = (changed, replacements[name]) if name in replacements else (data, previous[name])
        blocks.append(origin[a:b])
        cursor += b - a
    directory = []
    for name in list(old) + [name for name in fresh if name not in old]:
        fields, tail = fresh[name] if name in fresh else old[name]
        fields = fields.copy()
        fields[18] = offsets[name]
        directory.append(CD.pack(*fields) + tail)
    directory = b''.join(directory)
    ending[3:7] = [len(names), len(names), len(directory), cursor]
    result = b''.join(blocks) + directory + END.pack(*ending) + comment
    if len(result) > LIMIT:
        raise ValueError('修改后的 Word 超过32 MiB。')
    result_info = {}
    if undo:
        payload = {'schema': 2, 'before': digest(data), 'after': digest(result), 'members': list(previous),
                   'blocks': {name: base64.b64encode(data[a:b]).decode('ascii') for name, (a, b) in previous.items() if name in parts},
                   'directory': base64.b64encode(data[start:]).decode('ascii')}
        record = gzip.compress(json.dumps(payload, separators=(',', ':')).encode('utf-8'), mtime=0)
        with open(undo, 'xb') as stream:
            stream.write(record)
        result_info['undoSha256'] = digest(record)
    Path(output).write_bytes(result)
    return result_info


def replace_xml(source: str, xml: bytes, output: str, undo: str = None, *, source_bytes=None) -> dict:
    data = read(source) if source_bytes is None else source_bytes
    infos, start, records, ending, comment, member, stop = layout(data)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', allowZip64=False) as single:
        single.writestr(copy.copy(member), xml)
    one = buffer.getvalue()
    _, local_end, new_records, _, _, _, _ = layout(one)
    local = one[:local_end]
    shift = len(local) - (stop - member.header_offset)
    packed = []
    for info, (fields, tail) in zip(infos, records):
        fields = fields.copy()
        if info.filename == MEMBER:
            # Compression, flags, CRC and sizes must match the new local block.
            fields[3:12] = new_records[0][0][3:12]
        fields[18] = info.header_offset + (shift if info.header_offset >= stop else 0)
        packed.append(CD.pack(*fields) + tail)
    directory = b''.join(packed)
    ending[5], ending[6] = len(directory), start + shift
    result = data[:member.header_offset] + local + data[stop:start] + directory + END.pack(*ending) + comment
    if len(result) > LIMIT:
        raise ValueError('修改后的 Word 超过32 MiB。')
    record = None
    if undo:
        payload = {'schema': 1, 'before': digest(data), 'after': digest(result),
                   'block': base64.b64encode(data[member.header_offset:stop]).decode('ascii'),
                   'directory': base64.b64encode(data[start:]).decode('ascii')}
        record = gzip.compress(json.dumps(payload, separators=(',', ':')).encode('utf-8'), mtime=0)
        with open(undo, 'xb') as stream:
            stream.write(record)
    Path(output).write_bytes(result)
    return {'undoSha256': digest(record)} if record is not None else {}


def restore(source: str, undo: str, output: str) -> None:
    data = read(source)
    with gzip.open(undo, 'rb') as stream:
        payload = stream.read(RECORD_LIMIT + 1)
    if len(payload) > RECORD_LIMIT:
        raise ValueError('撤回记录超过上限。')
    record = json.loads(payload)
    if record.get('schema') not in (1, 2) or record['after'] != digest(data):
        raise ValueError('正文已更新，不能直接撤回此修改。')
    directory = base64.b64decode(record['directory'], validate=True)
    if record['schema'] == 1:
        _, start, _, _, _, member, stop = layout(data)
        block = base64.b64decode(record['block'], validate=True)
        result = data[:member.header_offset] + block + data[stop:start] + directory
    else:
        infos, start, _, _, _ = directory_layout(data)
        blocks = local_blocks(infos, start)
        original = [data[:next(iter(blocks.values()))[0]]]
        for name in record['members']:
            a, b = blocks[name]
            original.append(base64.b64decode(record['blocks'][name], validate=True) if name in record['blocks'] else data[a:b])
        result = b''.join(original) + directory
    if len(result) > LIMIT or digest(result) != record['before']:
        raise ValueError('撤回记录校验失败，当前文稿保留。')
    Path(output).write_bytes(result)
