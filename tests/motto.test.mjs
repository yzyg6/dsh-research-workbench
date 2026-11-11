import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {DEFAULT_MOTTOS,MOTTO_SOURCES,defaultMottoPreferences,readMottoPreferences,writeMottoPreferences,parseMottoLines,mottoInterval,mottoDisplayText} from '../src/client/motto-preferences.mjs';

const storage=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),values}};
test('defaults contain sourced excerpts and switch every 30 seconds; custom settings persist across reopening',()=>{
  const local=storage(),initial=readMottoPreferences(local);
  assert.equal(initial.intervalSeconds,30);assert.equal(initial.items.length,6);assert.equal(DEFAULT_MOTTOS.length,MOTTO_SOURCES.length);
  assert(initial.items.every(line=>line.includes('毛泽东《')));assert(MOTTO_SOURCES.every(url=>url.startsWith('https://')));
  const next={enabled:true,paused:true,intervalSeconds:45,items:['做好今天的实验。','把问题想清楚。']};
  assert(writeMottoPreferences(next,local));assert.deepEqual(readMottoPreferences(local),next);
  initial.items.pop();assert.equal(DEFAULT_MOTTOS.length,6);
});
test('custom lines, interval bounds, disabled empty lists and inaccessible storage have explicit safe behaviour',()=>{
  assert.deepEqual(parseMottoLines('  甲。\r\n\n  乙。 '),['甲。','乙。']);
  assert.throws(()=>parseMottoLines('字'.repeat(181)),/180/);assert.throws(()=>parseMottoLines(Array(31).fill('甲').join('\n')),/30/);
  for(const seconds of [0,4,3601,NaN,'',2.5])assert.throws(()=>mottoInterval(seconds));
  assert.equal(mottoInterval('5'),5);assert.equal(mottoInterval(3600),3600);
  assert.equal(mottoDisplayText(DEFAULT_MOTTOS[0]),'世上无难事，只要肯登攀。');assert.equal(mottoDisplayText('努力——因为想做得更好。'),'努力——因为想做得更好。');
  const local=storage(),empty={enabled:false,paused:false,intervalSeconds:30,items:[]};
  assert(writeMottoPreferences(empty,local));assert.deepEqual(readMottoPreferences(local),empty);
  const denied={getItem(){throw Error('denied')},setItem(){throw Error('denied')}};
  assert.deepEqual(readMottoPreferences(denied),defaultMottoPreferences());assert.equal(writeMottoPreferences(empty,denied),false);
  assert.deepEqual(readMottoPreferences({getItem:()=>'{broken'}),defaultMottoPreferences());
});

const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'_scratch/out/motto-tests');await mkdir(out,{recursive:true});
const require=createRequire(join(root,'_scratch/tmp/ui-deps/package.json')),React=require('react'),{create,act}=require('react-test-renderer'),reactPath=require.resolve('react'),file=join(out,'motto.cjs');
require('esbuild').buildSync({entryPoints:[join(root,'src/client/MottoTicker.jsx')],outfile:file,bundle:true,platform:'node',format:'cjs',alias:{react:reactPath},external:[reactPath],nodePaths:[join(root,'_scratch/tmp/ui-deps/node_modules')],logLevel:'silent'});
const {MottoTicker}=require(file);

async function mount(t,preferences){
  const keys=['window','document','localStorage','setInterval','clearInterval','IS_REACT_ACT_ENVIRONMENT'],previous=Object.fromEntries(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const local=storage();if(preferences)writeMottoPreferences(preferences,local);
  const doc=new EventTarget();doc.visibilityState='visible';const media=new EventTarget();media.matches=true;
  const timers=new Map();let timerId=0,renderer,settingsOpen=false;
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,window:{matchMedia:()=>media},document:doc,localStorage:local,setInterval:(callback,ms)=>{timers.set(++timerId,{callback,ms});return timerId},clearInterval:id=>timers.delete(id)});
  const change=value=>{settingsOpen=value;renderer.update(React.createElement(MottoTicker,{settingsOpen,onSettingsChange:change}))};
  await act(async()=>{renderer=create(React.createElement(MottoTicker,{settingsOpen,onSettingsChange:change}),{createNodeMock:element=>element.type==='dialog'?{showModal(){},close(){}}:null})});
  t.after(async()=>{await act(async()=>renderer.unmount());assert.equal(timers.size,0);for(const [key,value] of Object.entries(previous)){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key]}});
  return {renderer,timers,local,doc,media,phrase:()=>renderer.root.findByProps({className:'rw-motto-line'}).children.join(''),open:async()=>act(async()=>renderer.root.findByProps({'aria-label':'励志标语'}).props.onDoubleClick()),check:async(label,checked)=>act(async()=>renderer.root.findByProps({'aria-label':label}).props.onChange({target:{checked}})),button:async text=>act(async()=>renderer.root.findAll(node=>node.type==='button'&&node.children.includes(text))[0].props.onClick()),field:async(label,value)=>act(async()=>renderer.root.findByProps({'aria-label':label}).props.onChange({target:{value}}))};
}

test('only one phrase is displayed, changing at the selected interval with a persistent pause control',async t=>{
  const view=await mount(t);assert.equal(view.timers.size,1);assert.equal([...view.timers.values()][0].ms,30000);assert.equal(view.phrase(),mottoDisplayText(DEFAULT_MOTTOS[0]));
  assert.equal(view.renderer.root.findByProps({'aria-label':'励志标语'}).findAllByType('button').length,0);
  await act(async()=>[...view.timers.values()][0].callback());assert.equal(view.phrase(),mottoDisplayText(DEFAULT_MOTTOS[1]));
  await view.open();await view.check('暂停自动切换',true);await view.button('保存标语');assert.equal(view.timers.size,0);assert.equal(readMottoPreferences(view.local).paused,true);
  await view.open();await view.check('暂停自动切换',false);await view.button('保存标语');assert.equal(view.timers.size,1);
});
test('hidden windows, narrow layouts, hover and keyboard focus pause timers without resetting the phrase',async t=>{
  const view=await mount(t),region=()=>view.renderer.root.findByProps({'aria-label':'励志标语'});
  await act(async()=>region().props.onPointerEnter({pointerType:'mouse'}));assert.equal(view.timers.size,0);
  await act(async()=>region().props.onPointerLeave());assert.equal(view.timers.size,1);
  await act(async()=>region().props.onFocusCapture());assert.equal(view.timers.size,0);
  await act(async()=>region().props.onBlurCapture({currentTarget:{contains:()=>false},relatedTarget:null}));assert.equal(view.timers.size,1);
  await act(async()=>{view.doc.visibilityState='hidden';view.doc.dispatchEvent(new Event('visibilitychange'))});assert.equal(view.timers.size,0);
  await act(async()=>{view.doc.visibilityState='visible';view.doc.dispatchEvent(new Event('visibilitychange'))});assert.equal(view.timers.size,1);
  await act(async()=>{view.media.matches=false;view.media.dispatchEvent(new Event('change'))});assert.equal(view.timers.size,0);assert.equal(view.phrase(),mottoDisplayText(DEFAULT_MOTTOS[0]));
});
test('custom content and interval apply together; editing pauses the timer and cancellation leaves settings intact',async t=>{
  const view=await mount(t);await view.open();assert.equal(view.timers.size,0);
  await view.field('标语内容，每行一句','新的第一句。\n新的第二句。');await view.field('标语切换间隔（秒）','12');await view.button('保存标语');
  assert.equal(view.phrase(),'新的第一句。');assert.equal([...view.timers.values()][0].ms,12000);assert.equal(readMottoPreferences(view.local).intervalSeconds,12);
  await act(async()=>view.renderer.root.findByProps({'aria-label':'励志标语'}).props.onKeyDown({key:'Enter',preventDefault(){},stopPropagation(){}}));await view.field('标语内容，每行一句','不保存这句。');await view.button('取消');assert.equal(view.phrase(),'新的第一句。');
  await view.open();await view.field('标语切换间隔（秒）','0');await view.button('保存标语');assert(view.renderer.root.findByProps({role:'alert'}).children.join('').includes('5 至 3600'));assert.equal(readMottoPreferences(view.local).intervalSeconds,12);
});
test('a single custom phrase and a disabled display do not create recurring timers',async t=>{
  const view=await mount(t,{enabled:false,paused:false,intervalSeconds:30,items:['唯一一句。']});
  assert.equal(view.timers.size,0);assert.equal(view.renderer.root.findByProps({'aria-label':'励志标语'}).props.hidden,true);
});
