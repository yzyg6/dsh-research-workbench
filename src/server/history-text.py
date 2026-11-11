"""Extract bounded OOXML text for Git review; retain the original DOCX blob separately."""
import io
import sys
import zipfile
import xml.etree.ElementTree as ET

data = sys.stdin.buffer.read(32 * 1024 * 1024 + 1)
if len(data) > 32 * 1024 * 1024:
    raise ValueError('DOCX too large')
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    names = [name for name in archive.namelist() if name == 'word/document.xml' or
             (name.startswith(('word/footnotes', 'word/endnotes', 'word/header', 'word/footer')) and name.endswith('.xml'))]
    if sum(archive.getinfo(name).file_size for name in names) > 32 * 1024 * 1024:
        raise ValueError('OOXML too large')
    for name in names:
        root = ET.fromstring(archive.read(name))
        if name != 'word/document.xml':
            print('\n[' + name + ']')
        for paragraph in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p'):
            print(''.join(node.text or '' for node in paragraph.iter() if node.tag.endswith('}t')))
