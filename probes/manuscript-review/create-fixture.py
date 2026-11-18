"""Build an isolated Word manuscript with nested headings and an existing comment."""
from html import escape
from pathlib import Path
import base64
import sys
import zipfile

output = Path(sys.argv[1]).resolve()
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/package/2006/relationships'
C = 'http://schemas.openxmlformats.org/package/2006/content-types'


def paragraph(text, style=None, comment=False, page_break=False, mixed=False):
    style_tag = f'<w:pStyle w:val="{style}"/>' if style else ''
    page_break_tag = '<w:pageBreakBefore/>' if page_break else ''
    props = f'<w:pPr>{style_tag}{page_break_tag}</w:pPr>' if style or page_break else ''
    if mixed:
        run = (f'<w:r><w:t>{escape(text[:2])}</w:t></w:r>'
               f'<w:r><w:rPr><w:b/></w:rPr><w:t>{escape(text[2:])}</w:t></w:r>')
    else:
        run = f'<w:r><w:t>{escape(text)}</w:t></w:r>'
    if comment:
        run = '<w:commentRangeStart w:id="7"/>' + run + '<w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r>'
    return f'<w:p>{props}{run}</w:p>'


range_fixture = '--restricted-review-ranges' in sys.argv[2:]
translation_fixture = '--translation-fixture' in sys.argv[2:]
translation_content = ''.join([
    '<w:p><w:r><w:t>采用公式</w:t></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath><w:r><w:t>计算温室气体排放[8,11]。</w:t></w:r></w:p>',
    '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>' + paragraph('水库面积为 2.5 km²。') + '</w:tc></w:tr></w:tbl>',
    paragraph('图 1 合成排放量', 'Caption'),
    '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="360000" cy="360000"/><wp:docPr id="1" name="Figure 1" descr="坐标轴含中文"/>'
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="chart.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId10"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="360000" cy="360000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>',
    paragraph('参考文献', 'Heading1'),
    paragraph('[8] 合成作者。原始文献题名。2021。'),
]) if translation_fixture else ''
body = ''.join([
    paragraph('1 方法', 'Heading1'),
    paragraph('1.1 合成采样', 'CustomHeadingTwo'),
    paragraph('合成方法采用两种计量口径。', comment=True),
    '' if range_fixture else paragraph('方法段落保留原始单位。'),
    paragraph('2 结果', 'Heading1', page_break='--separate-review-pages' in sys.argv[2:]),
    paragraph('2.1 合成估计值'),
    paragraph('结果沿用合成方法的计量口径。', mixed=range_fixture),
    paragraph('结果段落报告对应区间。'),
    translation_content,
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
if translation_fixture:
    namespaces = (
        ' xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'
        ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
        ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
        ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
        f' xmlns:r="{R}"'
    )
    parts['word/document.xml'] = parts['word/document.xml'].replace(f'xmlns:w="{W}"', f'xmlns:w="{W}"' + namespaces, 1)
    parts['[Content_Types].xml'] = parts['[Content_Types].xml'].replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>')
    parts['word/_rels/document.xml.rels'] = parts['word/_rels/document.xml.rels'].replace('</Relationships>', f'<Relationship Id="rId10" Type="{R}/image" Target="media/chart.png"/></Relationships>')
    parts['word/media/chart.png'] = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=')
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, text in parts.items():
        archive.writestr(name, text)
