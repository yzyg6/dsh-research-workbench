"""Synthetic DOCX for run boundaries, Unicode and namespace-preserving edits."""
import sys
import zipfile
from pathlib import Path

path = Path(sys.argv[1])
path.parent.mkdir(parents=True, exist_ok=True)
xml = '''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:cx="urn:unchanged" mc:Ignorable="cx"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">前😀重复句。 中间 </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>重复</w:t></w:r><w:r><w:t xml:space = "default">句。 后缀</w:t></w:r></w:p><w:p><w:r><w:t>重复句。</w:t></w:r></w:p><w:p><m:oMath><m:f><m:num><m:r><m:t>x</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath></w:p></w:body></w:document>'''
with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    archive.writestr('word/document.xml', xml)
    archive.writestr('customXml/item1.xml', '<keep>immutable custom payload</keep>')
