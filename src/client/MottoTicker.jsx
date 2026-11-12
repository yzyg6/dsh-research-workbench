import React from 'react';
import {Icon} from './icons.jsx';
import {DEFAULT_MOTTOS,DEFAULT_MOTTO_FONT,MOTTO_FONTS,readMottoPreferences,writeMottoPreferences,parseMottoLines,mottoInterval,mottoDisplayText,mottoFont,mottoFontFamily} from './motto-preferences.mjs';

function MottoEditor({preferences,onSave,onClose}){
  const dialog=React.useRef(null);
  const [text,setText]=React.useState(()=>preferences.items.join('\n')),[enabled,setEnabled]=React.useState(preferences.enabled),[error,setError]=React.useState('');
  const [intervalSeconds,setIntervalSeconds]=React.useState(preferences.intervalSeconds);
  const [paused,setPaused]=React.useState(preferences.paused);
  const [fontFamily,setFontFamily]=React.useState(preferences.fontFamily||DEFAULT_MOTTO_FONT);
  const fontOptions=React.useId();
  React.useEffect(()=>{const node=dialog.current;node.showModal();return()=>node.close()},[]);
  const save=()=>{
    try{
      const items=parseMottoLines(text);if(enabled&&!items.length)throw Error('请至少填写一句标语，或关闭顶部显示。');
      if(!onSave({...preferences,enabled,paused,items,fontFamily:mottoFont(fontFamily),intervalSeconds:mottoInterval(intervalSeconds)}))throw Error('浏览器未能保存标语，请保留内容后重试。');
      onClose();
    }catch(e){setError(e.message)}
  };
  let previewFamily;try{previewFamily=mottoFontFamily(fontFamily)}catch{previewFamily=mottoFontFamily(DEFAULT_MOTTO_FONT)}
  return <dialog ref={dialog} className="rw-modal rw-motto-editor" aria-label="励志标语设置" onCancel={event=>{event.preventDefault();onClose()}} onKeyDown={event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();event.stopPropagation();save()}}}>
    <div className="rw-modal-head"><h2>励志标语</h2><button className="rw-icon-button" aria-label="关闭标语设置" onClick={onClose}><Icon name="close"/></button></div>
    <div className="rw-modal-body">
      <label className="rw-motto-enabled"><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/>在顶部显示标语</label>
      <label className="rw-motto-enabled"><input type="checkbox" aria-label="暂停自动切换" checked={paused} onChange={event=>setPaused(event.target.checked)}/>暂停自动切换</label>
      <label className="rw-motto-interval">切换间隔<span>每 <input aria-label="标语切换间隔（秒）" type="number" min="5" max="3600" step="1" value={intervalSeconds} onChange={event=>{setIntervalSeconds(event.target.value);setError('')}}/> 秒换一句</span></label>
      <label>标语字体<input aria-label="标语字体" list={fontOptions} value={fontFamily} maxLength={100} onChange={event=>{setFontFamily(event.target.value);setError('')}}/><datalist id={fontOptions}>{MOTTO_FONTS.map(font=><option key={font} value={font}/>)}</datalist></label>
      <p className="rw-context-muted">默认毛体；也可直接输入本机已安装字体的完整名称。字体未安装时使用系统字体。</p>
      <div className="rw-motto-font-preview" aria-label="标语字体预览" style={{fontFamily:previewFamily}}>{mottoDisplayText(text.split(/\r?\n/).find(line=>line.trim())||DEFAULT_MOTTOS[0])}</div>
      <label>每行一句<textarea autoFocus aria-label="标语内容，每行一句" value={text} maxLength={6000} onChange={event=>{setText(event.target.value);setError('')}} spellCheck={false}/></label>
      <p className="rw-context-muted">最多 30 句，每句 180 字。鼠标移入时保留当前语句；切换间隔可设为 5 至 3600 秒。</p>
      {error&&<p className="rw-error-text" role="alert">{error}</p>}
    </div>
    <div className="rw-modal-footer"><button className="rw-quiet rw-motto-reset" onClick={()=>{setText(DEFAULT_MOTTOS.join('\n'));setError('')}}>恢复默认语句</button><button className="rw-quiet" onClick={onClose}>取消</button><button className="rw-primary" onClick={save}>保存标语</button></div>
  </dialog>;
}

/** Update only this small component once per interval; never animate a long track. */
export const MottoTicker=React.memo(function MottoTicker({settingsOpen,onSettingsChange}){
  const [preferences,setPreferences]=React.useState(()=>readMottoPreferences());
  const [visible,setVisible]=React.useState(()=>typeof document==='undefined'||document.visibilityState!=='hidden');
  const [wide,setWide]=React.useState(()=>typeof window==='undefined'||window.matchMedia?.('(min-width:1101px)')?.matches!==false);
  const [index,setIndex]=React.useState(0),[hovered,setHovered]=React.useState(false),[focused,setFocused]=React.useState(false);
  const paused=preferences.paused||!visible||!wide||settingsOpen||hovered||focused;
  React.useEffect(()=>{const check=()=>setVisible(document.visibilityState!=='hidden');document.addEventListener('visibilitychange',check);return()=>document.removeEventListener('visibilitychange',check)},[]);
  React.useEffect(()=>{const media=window.matchMedia?.('(min-width:1101px)');if(!media)return;const check=()=>setWide(media.matches);check();media.addEventListener('change',check);return()=>media.removeEventListener('change',check)},[]);
  React.useEffect(()=>setIndex(0),[preferences.items]);
  React.useEffect(()=>{
    if(paused||!preferences.enabled||preferences.items.length<2)return;
    const timer=setInterval(()=>setIndex(value=>(value+1)%preferences.items.length),preferences.intervalSeconds*1000);
    return()=>clearInterval(timer);
  },[paused,preferences.enabled,preferences.intervalSeconds,preferences.items.length]);
  const save=value=>{if(!writeMottoPreferences(value))return false;setPreferences(value);return true};
  const line=preferences.items[index%preferences.items.length]||'';
  return <>
    <div className="rw-motto" role="region" aria-label="励志标语" aria-description="双击或按回车打开设置" aria-haspopup="dialog" tabIndex={0} title={`${line}\n双击设置`} hidden={!preferences.enabled||!preferences.items.length} onDoubleClick={()=>onSettingsChange(true)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();onSettingsChange(true)}}} onPointerEnter={event=>{if(event.pointerType!=='touch')setHovered(true)}} onPointerLeave={()=>setHovered(false)} onFocusCapture={()=>setFocused(true)} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget))setFocused(false)}}>
      <span className="rw-motto-line" key={line} style={{fontFamily:mottoFontFamily(preferences.fontFamily)}}>{mottoDisplayText(line)}</span>
    </div>
    {settingsOpen&&<MottoEditor preferences={preferences} onSave={save} onClose={()=>onSettingsChange(false)}/>}
  </>;
});
