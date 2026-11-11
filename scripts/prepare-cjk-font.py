"""Prepare the pinned full Chinese display fallback; development dependency: fontTools[woff]."""
import hashlib
import json
from pathlib import Path
from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parent.parent
source = root / '_scratch/tmp/noto-cjk/NotoSansCJKsc-Regular.otf'
expected = '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b'
if hashlib.sha256(source.read_bytes()).hexdigest() != expected:
    raise ValueError('Noto Sans CJK SC source checksum mismatch')
font = TTFont(source, recalcTimestamp=False)
target = root / 'public/wordcraft/NotoSansCJKsc-Regular.woff2'
font.flavor = 'woff2'
font.save(target)
info = {'family': font['name'].getBestFamilyName(), 'name': target.name,
        'bytes': target.stat().st_size, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
        'sourceSha256': expected,
        'source': 'https://github.com/notofonts/noto-cjk/blob/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf',
        'conversion': 'Lossless WOFF2 container, full cmap preserved'}
manifest_file = root / 'public/wordcraft/version.json'
manifest = json.loads(manifest_file.read_text(encoding='utf8'))
manifest['chineseFont'] = info
manifest['assets'][target.name] = {key: info[key] for key in ('bytes', 'sha256')}
manifest_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf8')
shared_file = root / 'src/shared/wordcraft-version.mjs'
shared = shared_file.read_text(encoding='utf8')
assets = json.loads(shared[shared.index('{'):shared.rindex('}')+1])
assets['font'] = {key: info[key] for key in ('name', 'family', 'bytes', 'sha256')}
shared_file.write_text('export const WORDCRAFT_ASSETS = ' + json.dumps(assets, ensure_ascii=False, indent=2) + ';\n', encoding='utf8')
license_file = root / 'licenses/wordcraft/noto-cjk-source.json'
license_file.write_text(json.dumps({**info, 'copyright': font['name'].getDebugName(0),
                                  'license': 'SIL Open Font License 1.1, OFL-noto-cjk-runtime.txt'},
                                 ensure_ascii=False, indent=2), encoding='utf8')
print(json.dumps(info, ensure_ascii=False))
