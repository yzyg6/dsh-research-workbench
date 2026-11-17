"""Build an isolated Word manuscript with nested headings and an existing comment."""
from html import escape
from pathlib import Path
import sys
import zipfile

output = Path(sys.argv[1]).resolve()
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/package/2006/relationships'
C = 'http://schemas.openxmlformats.org/package/2006/content-types'


def paragraph(text, style=None, comment=False):
    props = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ''
    run = f'<w:r><w:t>{escape(text)}</w:t></w:r>'
    if comment:
        run = '<w:commentRangeStart w:id="7"/>' + run + '<w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r>'
    return f'<w:p>{props}{run}</w:p>'


body = ''.join([
    paragraph('1 方法', 'Heading1'),
    paragraph('1.1 合成采样', 'CustomHeadingTwo'),
    paragraph('合成方法采用两种计量口径。', comment=True),
    paragraph('方法段落保留原始单位。'),
    paragraph('2 结果', 'Heading1'),
    paragraph('2.1 合成估计值'),
    paragraph('结果沿用合成方法的计量口径。'),
    paragraph('结果段落报告对应区间。'),
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr>',
])
parts = {
    '[Content_Types].xml': f'<Types xmlns="{C}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': f'<Relationships xmlns="{P}"><Relationship Id="rId1" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': f'<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>',
    'word/styles.xml': f'<w:styles xmlns:w="{W}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="CustomHeadingTwo"><w:name w:val="合成自定义样式"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>',
    'word/comments.xml': f'<w:comments xmlns:w="{W}"><w:comment w:id="7" w:author="合成作者"><w:p><w:r><w:t>已有的合成批注。</w:t></w:r></w:p></w:comment></w:comments>',
    'word/_rels/document.xml.rels': f'<Relationships xmlns="{P}"><Relationship Id="rId8" Type="{R}/comments" Target="comments.xml"/><Relationship Id="rId9" Type="{R}/styles" Target="styles.xml"/></Relationships>',
}
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, text in parts.items():
        archive.writestr(name, text)
