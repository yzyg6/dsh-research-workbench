// Pin upstream runtime and retain all shipped licenses. No Rust toolchain required.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),source=path.resolve(process.argv[2]||path.join(root,'_scratch/tmp/wordcraft-web-release/wordcraft-web-0.17.0')),target=path.join(root,'public/wordcraft'),licenses=path.join(root,'licenses/wordcraft');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex'),wasm=fs.readFileSync(path.join(source,'wordcraft-web-d5f8e062bd3e686e_bg.wasm'));
if(digest(wasm)!=='01cf0e77096540149d51d302546bc805f74ba4fef3e2e00f87799422c771c58d')throw Error('Wordcraft 0.17.0 WASM checksum mismatch');
fs.mkdirSync(target,{recursive:true});fs.mkdirSync(licenses,{recursive:true});
const esbuild=createRequire(path.join(root,'_scratch/tmp/ui-deps/package.json'))('esbuild');
esbuild.buildSync({entryPoints:[path.join(source,'wordcraft-web-d5f8e062bd3e686e.js')],outfile:path.join(target,'wordcraft-0.17.0-bridge.js'),bundle:true,format:'esm',platform:'browser',target:'chrome130',minify:true,logLevel:'error'});
fs.writeFileSync(path.join(target,'wordcraft-0.17.0.wasm.gz'),zlib.gzipSync(wasm,{level:9}));
for(const name of fs.readdirSync(source))if(/LICENSE|OFL/.test(name)||['NOTICE','ATTRIBUTION.md'].includes(name))fs.copyFileSync(path.join(source,name),path.join(licenses,name));
const assets=Object.fromEntries(['wordcraft-0.17.0-bridge.js','wordcraft-0.17.0.wasm.gz'].map(name=>{const bytes=fs.readFileSync(path.join(target,name));return[name,{bytes:bytes.length,sha256:digest(bytes)}]}));
const manifest={name:'Wordcraft',version:'0.17.0',source:'https://github.com/storytold/wordcraft',commit:'5574b32600aa7d782c64f5a6c6bb24696152220d',releaseArchiveSha256:'713f5e4b01427eb262c70e280e55d1354fa530e5a351b9751ebbe37398ea2ed0',wasmSha256:digest(wasm),wasmBytes:wasm.length,modifications:'Unmodified upstream WASM, gzip compressed. Generated JS bundled to resolve its eframe snippet locally; separate DSH host integration.',assets};
fs.writeFileSync(path.join(target,'version.json'),JSON.stringify(manifest,null,2));
fs.writeFileSync(path.join(root,'src/shared/wordcraft-version.mjs'),'export const WORDCRAFT_ASSETS = '+JSON.stringify({script:{name:'wordcraft-0.17.0-bridge.js',...assets['wordcraft-0.17.0-bridge.js']},wasm:{name:'wordcraft-0.17.0.wasm.gz',...assets['wordcraft-0.17.0.wasm.gz']}},null,2)+';\n');
console.log('Pinned Wordcraft assets prepared. Run npm run build.');
