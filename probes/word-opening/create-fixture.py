"""Synthetic manuscript with explicit Chinese/Latin fonts and a saved 180% zoom."""
import sys
import subprocess
import zipfile
from pathlib import Path

target = Path(sys.argv[1]).resolve()
subprocess.run([sys.executable, '-I', str(Path(__file__).resolve().parents[1] / 'word-reader/create-fixture.py'), '--output', str(target), '--paragraphs', '12'], check=True, capture_output=True)
with zipfile.ZipFile(target) as source:
    entries = [(info, source.read(info.filename)) for info in source.infolist()]
w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as output:
    for info, data in entries:
        if info.filename == 'word/document.xml':
            data = data.replace(b'<w:r><w:t>', '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="22"/></w:rPr><w:t>'.encode())
        output.writestr(info, data)
    output.writestr('word/styles.xml', f'<w:styles xmlns:w="{w}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>')
    output.writestr('word/settings.xml', f'<w:settings xmlns:w="{w}"><w:zoom w:percent="180"/></w:settings>')
    output.writestr('word/footnotes.xml', f'<w:footnotes xmlns:w="{w}"><w:footnote w:id="1"><w:p><w:r><w:rPr><w:rFonts w:eastAsia="楷体"/></w:rPr><w:t>合成脚注</w:t></w:r></w:p></w:footnote></w:footnotes>')
    output.writestr('word/theme/theme1.xml', '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme name="Synthetic"><a:majorFont><a:latin typeface="Cambria"/></a:majorFont></a:fontScheme></a:themeElements></a:theme>')
