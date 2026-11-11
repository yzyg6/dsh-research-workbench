"""Creates only explicitly synthetic, macro-free Word fixtures in a specified directory."""
from pathlib import Path
import argparse,zipfile,base64,html
parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);parser.add_argument('--paragraphs',type=int,default=90);parser.add_argument('--mode',default='normal');args=parser.parse_args()
out=Path(args.output).resolve();out.parent.mkdir(parents=True,exist_ok=True)
w='http://schemas.openxmlformats.org/wordprocessingml/2006/main';r='http://schemas.openxmlformats.org/officeDocument/2006/relationships';m='http://schemas.openxmlformats.org/officeDocument/2006/math';a='http://schemas.openxmlformats.org/drawingml/2006/main'
paragraph=lambda text:f'<w:p><w:r><w:t>{html.escape(text)}</w:t></w:r></w:p>'
parts=[f'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>专用合成 Word 阅读验证</w:t></w:r></w:p>']
parts+=[paragraph(f'第{i+1}段。这是合成文字，不是真实研究结论。'*6)for i in range(args.paragraphs)]
parts+=[paragraph('需要保持的可见文本 <script>alert(1)</script>。')]
parts+=['<w:p><m:oMath><m:f><m:num><m:r><m:t>x</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath></w:p>']
parts+=['<w:tbl>'+''.join('<w:tr>'+''.join('<w:tc>'+paragraph(text)+'</w:tc>'for text in row)+'</w:tr>'for row in [['组别','响应'],['A','1.25']])+'</w:tbl>']
parts+=['<w:p><w:r><w:drawing><a:blip r:embed="image1"/></w:drawing></w:r></w:p>']
if args.mode=='external':parts+=['<w:p><w:r><w:drawing><a:blip r:embed="external"/></w:drawing></w:r></w:p>']
xml=f'<w:document xmlns:w="{w}" xmlns:r="{r}" xmlns:m="{m}" xmlns:a="{a}"><w:body>'+''.join(parts)+'</w:body></w:document>'
if args.mode=='entity':xml='<!DOCTYPE x [<!ENTITY example "expanded">]>'+xml
png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=')
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED)as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
 z.writestr('word/document.xml',xml)
 z.writestr('word/_rels/document.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://invalid.example/no-request.png" TargetMode="External"/></Relationships>')
 z.writestr('word/media/image1.png',png)
 if args.mode=='unsafe':z.writestr('../outside.txt','must not extract')
print(str(out))
