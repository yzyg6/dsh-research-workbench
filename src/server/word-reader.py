"""Isolated, bounded DOCX content reader. Standard library only; never edits source."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import posixpath
import struct
import time
import xml.etree.ElementTree as ET
import zipfile

W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
M='http://schemas.openxmlformats.org/officeDocument/2006/math'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
A='http://schemas.openxmlformats.org/drawingml/2006/main'
NS={'w':W,'m':M,'r':R,'a':A}
def tag(node): return node.tag.rsplit('}',1)[-1]
def attr(node,name='val',default=None): return default if node is None else node.get('{'+W+'}'+name,node.get('{'+M+'}'+name,default))
def value(node,path,default=''): return attr(node.find(path,NS),default=default)
def mnode(name,*children,**attributes): return {'tag':name,'children':list(children),**({'attributes':attributes}if attributes else {})}

def math(node):
    name=tag(node)
    child=lambda key: math(node.find('m:'+key,NS)) if node.find('m:'+key,NS)is not None else mnode('mrow')
    if name=='t': return mnode('mtext',node.text or '')
    if name=='f': return mnode('mfrac',child('num'),child('den'))
    if name in ('sSup','sSub','sSubSup'): return mnode({'sSup':'msup','sSub':'msub','sSubSup':'msubsup'}[name],child('e'),*([child('sub')]if name!='sSup'else []),*([child('sup')]if name!='sSub'else []))
    if name=='rad':
        degree=node.find('m:deg',NS)
        return mnode('mroot',child('e'),math(degree))if degree is not None and ''.join(degree.itertext()).strip()else mnode('msqrt',child('e'))
    if name=='nary':
        op=mnode('mo',value(node,'m:naryPr/m:chr','∑'));sub=node.find('m:sub',NS);sup=node.find('m:sup',NS)
        if sub is not None and sup is not None: op=mnode('munderover',op,child('sub'),child('sup'))
        elif sub is not None: op=mnode('munder',op,child('sub'))
        elif sup is not None: op=mnode('mover',op,child('sup'))
        return mnode('mrow',op,child('e'))
    if name=='d':
        children=[mnode('mo',value(node,'m:dPr/m:begChr','('))]
        for i,e in enumerate(node.findall('m:e',NS)):
            if i: children.append(mnode('mo',value(node,'m:dPr/m:sepChr','|')))
            children.append(math(e))
        return mnode('mrow',*children,mnode('mo',value(node,'m:dPr/m:endChr',')')))
    if name=='m': return mnode('mtable',*[mnode('mtr',*[mnode('mtd',math(e))for e in row.findall('m:e',NS)])for row in node.findall('m:mr',NS)])
    if name=='eqArr': return mnode('mtable',*[mnode('mtr',mnode('mtd',math(e)))for e in node.findall('m:e',NS)])
    if name in ('limLow','limUpp'): return mnode('munder'if name=='limLow'else'mover',child('e'),child('lim'))
    if name=='acc': return mnode('mover',child('e'),mnode('mo',value(node,'m:accPr/m:chr','̂')))
    if name=='bar': return mnode('munder'if value(node,'m:barPr/m:pos')=='bot'else'mover',child('e'),mnode('mo','¯'))
    return mnode('mrow',*[math(c)for c in node if not tag(c).endswith('Pr')])

def dimensions(data,extension):
    if extension=='.png'and len(data)>=24 and data[:8]==b'\x89PNG\r\n\x1a\n':
        offset=8
        while offset+8<=len(data):
            length=int.from_bytes(data[offset:offset+4],'big');kind=data[offset+4:offset+8]
            if kind==b'acTL':return None
            if kind==b'IDAT':break
            offset+=length+12
        return struct.unpack('>II',data[16:24])
    if extension=='.gif'and data[:3]==b'GIF':return struct.unpack('<HH',data[6:10])
    if extension in ('.jpg','.jpeg')and data[:2]==b'\xff\xd8':
        i=2
        while i+9<len(data):
            if data[i]!=255:i+=1;continue
            marker=data[i+1];i+=2
            if marker in (0xd8,0xd9):continue
            length=int.from_bytes(data[i:i+2],'big')
            if marker in (0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf):
                height,width=struct.unpack('>HH',data[i+3:i+7]);return width,height
            if length<2:break
            i+=length
    return None

class Reader:
    def __init__(self,source,destination,expected):
        self.source=source;self.out=destination;self.expected=expected;self.images={};self.assets={};self.warnings=set();self.characters=0;self.paragraphs=0;self.tables=0;self.formulas=0;self.numbering={};self.number_formats={}
    def xml(self,name,limit=12*1024*1024):
        info=self.archive.getinfo(name)
        if info.file_size>limit:raise ValueError('Word XML 超出阅读上限，请拆分稿件。')
        data=self.archive.read(name)
        normalized=data.replace(b'\0',b'')
        if b'<!DOCTYPE'in normalized or b'<!ENTITY'in normalized:raise ValueError('不支持包含自定义 XML 实体的文档。')
        if data.count(b'<')>220000:raise ValueError('Word XML 节点过多，请拆分文档。')
        return ET.fromstring(data)
    def image(self,relationship):
        if relationship in self.images:return self.images[relationship]
        target=self.relations.get(relationship)
        result={'unavailable':'该图片不是内嵌的受支持图片，请在原 Word 查看。'}
        if target and target in self.names:
            extension=PurePosixPath(target).suffix.lower();info=self.archive.getinfo(target)
            if extension in ('.png','.jpg','.jpeg')and info.file_size<=12*1024*1024:
                data=self.archive.read(target);size=dimensions(data,extension)
                if size and size[0]>0 and size[1]>0 and size[0]*size[1]<=12_000_000:
                    if len(self.assets)>=300:raise ValueError('Word 内嵌图片超过300张，请拆分文档。')
                    name=f'image-{len(self.assets)+1}{extension}';(self.out/name).write_bytes(data)
                    self.assets[name]={'bytes':len(data),'width':size[0],'height':size[1]}
                    result={'id':name,'width':size[0],'height':size[1]}
                else: result={'unavailable':'此图片分辨率过高或格式无法识别，未在阅读页解码；可在原 Word 查看。'}
        if 'unavailable'in result:self.warnings.add('部分外链、高分辨率或特殊格式图片未内嵌，以控制内存；原 Word 保留。')
        self.images[relationship]=result;return result
    def inline(self,node,marks=None):
        marks=marks or {};result=[]
        for part in node:
            name=tag(part)
            if name in ('pPr','rPr','sdtPr','del','moveFrom'):continue
            if part.tag in ('{'+M+'}oMath','{'+M+'}oMathPara'):
                self.formulas+=1;result.append({'math':math(part)});continue
            if name=='r':
                properties=part.find('w:rPr',NS);sty=dict(marks)
                if properties is not None:
                    hidden=properties.find('w:vanish',NS)
                    if hidden is not None and attr(hidden,default='true')not in ('0','false'):continue
                    for flag,key in [('b','bold'),('i','italic'),('u','underline')]:
                        entry=properties.find('w:'+flag,NS)
                        if entry is not None and attr(entry,default='true')not in ('0','false','none'):sty[key]=True
                    position=value(properties,'w:vertAlign')
                    if position in ('superscript','subscript'):sty['position']=position
                result.extend(self.inline(part,sty))
            elif name=='t':result.append({'text':part.text or '',**marks})
            elif name=='tab':result.append({'text':'\t',**marks})
            elif name=='br':result.append({'text':'\n',**marks})
            elif name in ('drawing','pict'):
                embeds=part.findall('.//a:blip',NS)
                legacy=[e for e in part.iter()if tag(e)=='imagedata']
                if not embeds and not legacy:result.append({'image':{'unavailable':'此旧式图形请在原 Word 查看。'}})
                for embed in embeds:result.append({'image':self.image(embed.get('{'+R+'}embed',''))})
                if not embeds:
                    for embed in legacy:result.append({'image':self.image(embed.get('{'+R+'}id',''))})
            elif name in ('footnoteReference','endnoteReference'):result.append({'text':'['+str(attr(part,'id',''))+']','position':'superscript'})
            elif name=='hyperlink':
                href=self.links.get(part.get('{'+R+'}id',''),'');result.extend(self.inline(part,{**marks,**({'href':href}if href.startswith(('https://','http://'))else{})}))
            elif name=='sym':
                try:result.append({'text':chr(int(attr(part,'char'),16)),**marks})
                except (ValueError,TypeError):pass
            elif name=='AlternateContent':
                choice=next((entry for entry in part if tag(entry)=='Choice'),None)
                if choice is None:choice=next((entry for entry in part if tag(entry)=='Fallback'),None)
                if choice is not None:result.extend(self.inline(choice,marks))
            else:result.extend(self.inline(part,marks))
        return result
    def paragraph(self,node):
        runs=self.inline(node);length=sum(len(r.get('text',''))for r in runs)
        self.characters+=length;self.paragraphs+=1
        if self.characters>3_000_000 or self.paragraphs>30000:raise ValueError('Word 正文超出阅读上限，请拆分文档。')
        properties=node.find('w:pPr',NS);block={'type':'paragraph','runs':runs}
        if properties is not None:
            style=value(properties,'w:pStyle');outline=value(properties,'w:outlineLvl',None)
            if outline is not None and outline.isdigit():block['level']=min(6,int(outline)+1)
            elif style.lower().startswith(('heading','标题')):
                digits=''.join(c for c in style if c.isdigit());block['level']=min(6,int(digits or 1))
            align=value(properties,'w:jc')
            if align in ('center','right','both'):block['align']=align
            num=properties.find('w:numPr',NS)
            if num is not None:
                key=value(num,'w:numId')+':'+value(num,'w:ilvl','0');self.numbering[key]=self.numbering.get(key,0)+1
                block['marker']='•'if self.number_formats.get(key)=='bullet'else str(self.numbering[key])+'.';block['indent']=min(6,int(value(num,'w:ilvl','0')))
        return block
    def table(self,node):
        self.tables+=1;rows=[];merge={}
        for row in node.findall('w:tr',NS):
            cells=[];column=0
            for cell in row.findall('w:tc',NS):
                properties=cell.find('w:tcPr',NS);span=max(1,min(100,int(value(properties,'w:gridSpan','1'))))if properties is not None else 1
                vertical=properties.find('w:vMerge',NS)if properties is not None else None
                if vertical is not None and attr(vertical,default='continue')!='restart'and column in merge:
                    merge[column]['rowspan']=merge[column].get('rowspan',1)+1;column+=span;continue
                content=[self.paragraph(p)for p in cell.findall('w:p',NS)]
                item={'blocks':content,'colspan':span};cells.append(item)
                if vertical is not None:merge[column]=item
                else:merge.pop(column,None)
                column+=span
            rows.append({'cells':cells,'header':row.find('w:trPr/w:tblHeader',NS)is not None})
            if len(rows)>2000 or column>100:raise ValueError('Word 表格超出阅读上限，请拆分表格。')
        # Keep merged tables intact; ordinary long tables are divided into bounded chunks.
        if any(c.get('rowspan',1)>1 for row in rows for c in row['cells']):
            if len(rows)>100 or sum(len(row['cells'])for row in rows)>2000:raise ValueError('包含跨行合并的大表格请在原 Word 查看。')
            return [{'type':'table','rows':rows}]
        headers=[row for row in rows if row['header']]
        return [{'type':'table','rows':([]if i==0 else headers)+rows[i:i+24],'continuation':i>0}for i in range(0,len(rows),24)]
    def blocks(self,container):
        result=[]
        for node in container:
            if node.tag=='{'+W+'}p':result.append(self.paragraph(node))
            elif node.tag=='{'+W+'}tbl':result.extend(self.table(node))
            elif tag(node)in ('sdt','sdtContent','customXml'):result.extend(self.blocks(node))
        return result
    def run(self):
        started=time.perf_counter()
        if self.source.stat().st_size>32*1024*1024:raise ValueError('Word 文件超过32 MiB，请使用原应用或拆分稿件。')
        hasher=hashlib.sha256()
        handle=self.source.open('rb')
        for chunk in iter(lambda:handle.read(1024*1024),b''):hasher.update(chunk)
        digest=hasher.hexdigest()
        if digest!=self.expected:raise ValueError('Word 版本已变化，请重新扫描工作区。')
        handle.seek(0)
        self.archive=zipfile.ZipFile(handle);entries=self.archive.infolist();self.names={entry.filename for entry in entries}
        if len(entries)>4000 or len(self.names)!=len(entries)or sum(e.file_size for e in entries)>96*1024*1024:raise ValueError('Word 展开大小或部件数量超出阅读上限。')
        for entry in entries:
            name=entry.filename
            if name.startswith(('/','\\'))or'\\'in name or':'in name or'..'in PurePosixPath(name).parts or entry.flag_bits&1:raise ValueError('Word 包含不支持的部件路径或加密内容。')
        self.relations={};self.links={}
        if 'word/numbering.xml'in self.names:
            numbers=self.xml('word/numbering.xml',2*1024*1024);abstract={}
            for entry in numbers.findall('w:abstractNum',NS):
                abstract[attr(entry,'abstractNumId')]={attr(level,'ilvl'):value(level,'w:numFmt')for level in entry.findall('w:lvl',NS)}
            for number in numbers.findall('w:num',NS):
                for level,kind in abstract.get(value(number,'w:abstractNumId'),{}).items():self.number_formats[attr(number,'numId')+':'+level]=kind
        if 'word/_rels/document.xml.rels'in self.names:
            for rel in self.xml('word/_rels/document.xml.rels',2*1024*1024):
                rid=rel.get('Id');target=rel.get('Target','')
                if rel.get('TargetMode')=='External':self.links[rid]=target;continue
                name=posixpath.normpath(posixpath.join('word',target))
                if name.startswith('word/'):self.relations[rid]=name
        document=self.xml('word/document.xml');body=document.find('w:body',NS)
        if body is None:raise ValueError('未找到 Word 正文。')
        self.out.mkdir(parents=True,exist_ok=True);blocks=self.blocks(body)
        for filename,label in [('word/footnotes.xml','脚注'),('word/endnotes.xml','尾注')]:
            if filename in self.names:
                notes=self.xml(filename,2*1024*1024)
                for note in notes:
                    note_id=attr(note,'id','0')
                    if not note_id.lstrip('-').isdigit()or int(note_id)<=0:continue
                    blocks.append({'type':'paragraph','runs':[{'text':f'{label} [{note_id}]','bold':True}]})
                    blocks.extend(self.paragraph(p)for p in note.findall('w:p',NS))
        if document.find('.//w:del',NS)is not None or document.find('.//w:ins',NS)is not None:self.warnings.add('阅读版显示接受修订后的正文；修订痕迹请在原 Word 查看。')
        pages=[];current=[];chars=0;pixels=0
        def image_pixels(node):
            if isinstance(node,dict):return (node.get('width',0)*node.get('height',0)if'id'in node else 0)+sum(image_pixels(v)for v in node.values())
            return sum(image_pixels(x)for x in node)if isinstance(node,list)else 0
        def flush():
            nonlocal current,chars,pixels
            if not current:return
            encoded=json.dumps({'blocks':current},ensure_ascii=False,separators=(',',':')).encode('utf-8')
            if len(encoded)>1024*1024:raise ValueError('单个 Word 分段过大，请在原应用查看。')
            number=len(pages);name=f'page-{number}.json';(self.out/name).write_bytes(encoded)
            pages.append({'index':number,'bytes':len(encoded)});current=[];chars=0;pixels=0
        for block in blocks:
            size=len(json.dumps(block,ensure_ascii=False));count=image_pixels(block)
            if count>12_000_000:
                remaining=[12_000_000]
                def cap_images(node):
                    if isinstance(node,list):return[cap_images(x)for x in node]
                    if not isinstance(node,dict):return node
                    if'id'in node and'width'in node:
                        pixels=node['width']*node['height']
                        if pixels>remaining[0]:return{'unavailable':'此分段图片较多，部分图片请在原 Word 查看。'}
                        remaining[0]-=pixels
                    return{k:cap_images(v)for k,v in node.items()}
                block=cap_images(block);count=image_pixels(block);self.warnings.add('部分密集图片分段限制同时解码的图像数量。')
            if current and (chars+size>16000 or len(current)>=30 or pixels+count>12_000_000):flush()
            current.append(block);chars+=size;pixels+=count
            if len(pages)>1000:raise ValueError('Word 阅读分段过多。')
        flush()
        if not pages:current=[{'type':'paragraph','runs':[{'text':'此文档没有可读取的正文。'}]}];flush()
        manifest={'schemaVersion':1,'readerVersion':1,'sourceSha256':digest,'pages':pages,'assets':self.assets,'counts':{'paragraphs':self.paragraphs,'tables':self.tables,'images':len(self.assets),'formulas':self.formulas,'characters':self.characters},'warnings':sorted(self.warnings),'elapsedMs':round((time.perf_counter()-started)*1000)}
        (self.out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False),encoding='utf-8');self.archive.close();handle.close()
        return manifest

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--output',required=True);parser.add_argument('--sha256',required=True);args=parser.parse_args()
    try:
        result=Reader(Path(args.source),Path(args.output),args.sha256).run();print(json.dumps({'ok':True,'counts':result['counts'],'elapsedMs':result['elapsedMs']}))
    except Exception as error:
        message=str(error)if isinstance(error,ValueError)else'Word 解析未完成，请使用原应用查看。'
        print(json.dumps({'ok':False,'message':message},ensure_ascii=False));raise SystemExit(1)
