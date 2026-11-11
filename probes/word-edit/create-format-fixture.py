"""Create a disposable formatting fixture; never targets research manuscripts."""
import sys, zipfile
from pathlib import Path
target=Path(sys.argv[1]);target.parent.mkdir(parents=True,exist_ok=True)
w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
m='http://schemas.openxmlformats.org/officeDocument/2006/math'
xml=f'''<w:document xmlns:w="{w}" xmlns:m="{m}"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标 题</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t xml:space="preserve">中 </w:t></w:r><w:r><w:t xml:space="preserve"> 文 句 子。 English  words G-res 1.25 kg </w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="黑体"/><w:sz w:val="22"/></w:rPr><w:t>普 通 正 文。</w:t></w:r></w:p>
<w:p><w:r><w:t>公 式：</w:t></w:r><m:oMath><m:r><m:t>x+2</m:t></m:r></m:oMath></w:p>
<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">a  =  b</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表 格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>'''
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
 z.writestr('word/document.xml',xml)
 z.writestr('word/header1.xml',f'<w:hdr xmlns:w="{w}"><w:p><w:r><w:t>页 眉</w:t></w:r></w:p></w:hdr>')
 z.writestr('word/media/unchanged.bin',bytes(range(256))*16)
print(target)
