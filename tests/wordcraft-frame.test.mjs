import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {wordcraftFrame} from '../src/client/wordcraft-frame.mjs';
import {installChineseFont} from '../src/client/wordcraft-font.mjs';

test('the production iframe script composes with its self-contained font installer',()=>{
 const options=JSON.stringify({hostOrigin:'https://local',moduleUrl:'blob:https://local/runtime'});
 assert.doesNotThrow(()=>new vm.Script(`(${wordcraftFrame.toString()})({...${options},installFont:${installChineseFont.toString()}});`));
});

test('the serialized iframe bootstrap compiles, scopes opens to its parent and normalizes accessibility input events',()=>{
 const canvasEvents=new Map(),windowEvents=new Map(),documentEvents=new Map(),posted=[],dispatched=[];
 class Input{constructor(){this.value='合成输入'}}class Textarea extends Input{}
 class Event{constructor(type,init){this.type=type;Object.assign(this,init)}}
 const parent={postMessage:(data,origin)=>posted.push({data,origin})},canvas={addEventListener:(type,handler)=>canvasEvents.set(type,handler),dispatchEvent:event=>dispatched.push(event)};
 const context={parent,window:{addEventListener:(type,handler)=>windowEvents.set(type,handler)},document:{documentElement:{dataset:{}},getElementById:()=>canvas,addEventListener:(type,handler)=>documentEvents.set(type,handler)},HTMLInputElement:Input,HTMLTextAreaElement:Textarea,InputEvent:Event,CustomEvent:Event};
 const code=`(${wordcraftFrame.toString()})(${JSON.stringify({hostOrigin:'https://local',moduleUrl:'blob:https://local/runtime'})});`;
 new vm.Script(code).runInNewContext(context);assert.equal(context.document.documentElement.dataset.wordcraftBoot,'1');assert.equal(posted[0].data.type,'rw-wordcraft-frame');
 windowEvents.get('message')({source:{},origin:'https://local',data:{type:'wordcraft:open'}});windowEvents.get('message')({source:parent,origin:'https://foreign',data:{type:'wordcraft:open'}});assert.equal(dispatched.length,0);
 const bytes=new Uint8Array([1,2]);windowEvents.get('message')({source:parent,origin:'https://local',data:{type:'wordcraft:open',name:'synthetic.docx',bytes}});assert.equal(dispatched.length,1);assert.equal(dispatched[0].detail.bytes,bytes);
 canvasEvents.get('wordcraft:dirty')({detail:{dirty:true}});assert.equal(posted.at(-1).data.type,'wordcraft:dirty');assert.equal(posted.at(-1).data.dirty,true);
 const target=new Input();let stopped=false,converted;target.dispatchEvent=event=>converted=event;documentEvents.get('input')({target,stopImmediatePropagation:()=>{stopped=true}});assert(stopped);assert.equal(converted.inputType,'insertText');assert.equal(converted.data,'合成输入');
 stopped=false;documentEvents.get('input')({target,inputType:'insertCompositionText',stopImmediatePropagation:()=>{stopped=true}});assert.equal(stopped,false);
});

test('the host receives ready only after Chinese fonts finish loading',async()=>{
 const events=new Map(),posted=[];let finish;
 const context={parent:{postMessage:data=>posted.push(data)},window:{addEventListener:()=>{},wordcraft:{}},document:{documentElement:{dataset:{}},addEventListener:()=>{},getElementById:()=>({addEventListener:(type,fn)=>events.set(type,fn)})}};
 // The production serializer passes the installer as a function value.
 context.options={hostOrigin:'https://local',moduleUrl:'blob:https://local/runtime',installFont:()=>new Promise(resolve=>{finish=resolve})};
 new vm.Script(`(${wordcraftFrame.toString()})(options)`).runInNewContext(context);
 const pending=events.get('wordcraft:ready')({detail:{version:'1'}});assert(!posted.some(item=>item.type==='wordcraft:ready'));
 finish({family:'Noto Sans CJK SC'});await pending;assert.equal(posted.at(-1).type,'wordcraft:ready');assert.equal(posted.at(-1).chineseFont,'Noto Sans CJK SC');
});
