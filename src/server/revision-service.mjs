import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StoreError } from './store.mjs';
import { relatedPassages, compareSentences, CHANGE_LABELS } from '../shared/revision-review.mjs';

const FONT_FILES = [
  ['simsun','宋体 / SimSun','simsun.ttc'],['simhei','黑体 / SimHei','simhei.ttf'],
  ['simfang','仿宋 / FangSong','simfang.ttf'],['simkai','楷体 / KaiTi','simkai.ttf'],
  ['times','Times New Roman','times.ttf'],['times-bold','Times New Roman Bold','timesbd.ttf'],
  ['times-italic','Times New Roman Italic','timesi.ttf'],['times-bolditalic','Times New Roman Bold Italic','timesbi.ttf'],
  ['yahei','微软雅黑 / Microsoft YaHei','msyh.ttc'],
  ['calibri','Calibri','calibri.ttf'],['calibri-bold','Calibri Bold','calibrib.ttf'],
  ['calibri-italic','Calibri Italic','calibrii.ttf'],['calibri-bolditalic','Calibri Bold Italic','calibriz.ttf'],
  ['cambria','Cambria / Cambria Math','cambria.ttc'],['cambria-bold','Cambria Bold','cambriab.ttf'],
  ['cambria-italic','Cambria Italic','cambriai.ttf'],['cambria-bolditalic','Cambria Bold Italic','cambriaz.ttf'],
];
const fontRoot=()=>join(process.env.WINDIR||'C:\\Windows','Fonts');
const FONT_FAMILIES={simsun:['SimSun','NSimSun','宋体','新宋体'],simhei:['SimHei','黑体'],simfang:['FangSong','仿宋'],simkai:['KaiTi','楷体'],times:['Times New Roman'],yahei:['Microsoft YaHei','Microsoft YaHei UI','微软雅黑'],calibri:['Calibri'],cambria:['Cambria','Cambria Math']};
export async function systemFonts(){
  if(process.platform!=='win32')return[];
  const fonts=[];for(const [id,label,name] of FONT_FILES){try{const info=await stat(join(fontRoot(),name));if(info.size<=32*1024*1024)fonts.push({id,label,name,bytes:info.size,modified:info.mtimeMs,families:FONT_FAMILIES[id.split('-')[0]]})}catch{}}
  return fonts;
}
export async function systemFont(id){
  const font=(await systemFonts()).find(font=>font.id===id);if(!font)throw new StoreError('FONT_NOT_FOUND','此系统字体未安装。',404);
  return readFile(join(fontRoot(),font.name));
}

export async function reviewReminders(runtime,{projectId,objectId}){
  const object=runtime.store.object(projectId,objectId);
  const article=object.encoding==='binary'?await runtime.wordEditing.context(projectId,objectId):(await runtime.store.bytesFor(object)).toString('utf8');
  const jobs=runtime.store.db.prepare("SELECT id,input,output FROM jobs WHERE project_id=? AND type='writing.sentence' AND json_extract(output,'$.objectId')=? AND json_extract(output,'$.review')='adopted' ORDER BY updated_at DESC LIMIT 20").all(projectId,objectId);
  const key=`reviewReminders:${projectId}:${objectId}`,saved=runtime.store.db.prepare('SELECT value FROM preferences WHERE key=?').get(key),checked= saved?JSON.parse(saved.value):{};
  const reminders=[];
  const changes=jobs.map(row=>({id:row.id,...JSON.parse(row.output)}));
  const history=await runtime.store.documentHistory.list(projectId,objectId,0,1);
  const latest=history.entries[0];
  if(latest?.parents?.length&&!latest.action.startsWith('采用修改')&&!latest.action.startsWith('撤回')){
    const detail=await runtime.store.documentHistory.detail(projectId,objectId,latest.commit);
    for(const [index,row] of compareSentences(detail.before,detail.text).filter(row=>row.kind!=='unchanged').slice(0,12).entries())changes.push({id:`${latest.commit}:${index}`,original:row.before,proposal:{replacement:row.after}});
  }
  for(const output of changes){const row={id:output.id};for(const item of relatedPassages(article,output.original,output.proposal.replacement)){
    const id=createHash('sha256').update(row.id+'\0'+item.paragraph+'\0'+item.text).digest('hex').slice(0,24);
    reminders.push({...item,id,jobId:row.id,original:output.original,replacement:output.proposal.replacement,checked:Boolean(checked[id])});
  }}
  return{revision:object.revision,reminders};
}
export async function revisionAction(runtime,action,data){
  const store=runtime.store,{projectId,objectId}=data;
  switch(action){
    case 'documentHistory':
      return store.write(async()=>{await store.documentHistory.ensure(projectId,objectId);return store.documentHistory.list(projectId,objectId,data.offset)});
    case 'documentHistoryDetail':
      await store.tail;return store.documentHistory.detail(projectId,objectId,data.commit);
    case 'restoreDocumentHistory': {
      const object=store.object(projectId,objectId),bytes=await store.documentHistory.bytes(projectId,objectId,data.commit);
      const options={historyAction:'恢复历史版本 '+data.commit.slice(0,8),restoredFrom:data.commit};
      if(object.encoding==='binary')await runtime.wordEditing.save({...data,bytes},options);else await store.saveObject({...data,text:bytes.toString('utf8')},options);
      return {restored:true};
    }
    case 'reviewReminders':await store.tail;return reviewReminders(runtime,data);
    case 'checkReminder':return store.write(()=>{
      store.object(projectId,objectId);if(!/^[a-f0-9]{24}$/.test(data.id)||typeof data.checked!=='boolean')throw new StoreError('INVALID_INPUT','关联提醒标识无效。');
      const key=`reviewReminders:${projectId}:${objectId}`,value=JSON.parse(store.db.prepare('SELECT value FROM preferences WHERE key=?').get(key)?.value||'{}');
      if(data.checked)value[data.id]=true;else delete value[data.id];
      store.db.prepare('INSERT INTO preferences VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(Object.fromEntries(Object.entries(value).slice(-1000))));return{checked:data.checked};
    });
    case 'classifySentence':return store.write(()=>{
      const row=runtime.writing.row(projectId,data.jobId),output=JSON.parse(row.output||'null');
      if(!output?.proposal||!Object.hasOwn(CHANGE_LABELS,data.kind))throw new StoreError('INVALID_INPUT','修改分类无效。');
      const rows=compareSentences(output.original,output.proposal.replacement,output.proposal.sentenceChanges),item=rows[data.index];
      if(!item||item.before!==data.before||item.after!==data.after)throw new StoreError('VERSION_CONFLICT','建议已更新，请重新核对分类。',409);
      if((item.before===item.after)!==(data.kind==='unchanged'))throw new StoreError('INVALID_INPUT','仅完全相同的句子可标记为未修改。');
      rows[data.index]={...item,kind:data.kind,source:'author',reason:'作者已核对分类'};
      output.proposal.sentenceChanges=rows;
      store.db.prepare('UPDATE jobs SET output=?,updated_at=? WHERE id=?').run(JSON.stringify(output),new Date().toISOString(),row.id);return{saved:true};
    });
  }
}
