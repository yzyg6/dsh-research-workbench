import {wordCommand} from '../shared/word-live.mjs';

/** Operate the same in-memory engine as the author; never rebuild the DOCX. */
export class WordLiveEditor {
  constructor({bridge,save,managed,revision,dirty,loadFonts=async()=>{},active=()=>{}}){Object.assign(this,{bridge,save,managed,revision,dirty,loadFonts,active});this.context=null}
  async run(request){
    this.active();await this.managed();this.active();
    if(request.kind==='context'){
      await this.save();this.active();
      const selection=await this.bridge.execute('document.selection',{}),text=await this.bridge.execute('document.text',{}),document=await this.bridge.execute('document.inspect',{text:false}),fonts=await this.bridge.execute('font.list',{all:true});
      const contextId=crypto.randomUUID();this.context={id:contextId,revision:this.revision(),selection,document:JSON.stringify(document)};
      const outline={pages:document.pages,words:document.words,trackChanges:document.trackChanges,canUndo:document.canUndo,canRedo:document.canRedo,blocks:(document.blocks||[]).slice(0,80).map(({index,type,style,props,rows,cols})=>({index,type,style,props,rows,cols}))};
      return{contextId,revision:this.revision(),selection:{...selection,text:String(selection.text||'').slice(0,8000)},text:String(text.text||'').slice(0,180000),truncated:(text.text?.length||0)>180000,document:outline,availableFonts:fonts.families||[]};
    }
    if(request.kind!=='edit')throw Error('未知 Word 编辑请求。');
    const context=this.context;this.context=null;
    if(!context||context.id!==request.contextId||context.revision!==this.revision()||this.dirty())throw Error('Word 已编辑或保存，请重新读取当前文稿。');
    const document=await this.bridge.execute('document.inspect',{text:false});this.active();
    if(JSON.stringify(document)!==context.document)throw Error('Word 内容或选区已变化，请重新读取。');
    const plan=request.plan,{command,params}=wordCommand(plan);
    const history=['undo','redo'].includes(plan.action);
    if(!history&&plan.scope==='selection'&&(!context.selection.text||JSON.stringify(context.selection.anchor)===JSON.stringify(context.selection.focus)))throw Error('请先在 Word 中选中需要修改的文字。');
    if(plan.action==='font')await this.loadFonts([params.eastAsia,params.name].filter(Boolean));this.active();
    if(!history&&plan.scope==='all')await this.bridge.execute('select.all',{whole:true});
    let result;
    try{this.active();result=await this.bridge.execute(command,params)}catch(error){throw Error(`Word 未完成操作：${error.message}`)}
    try{this.active();await this.save()}catch(error){throw Error(`Word 中已执行操作，但保存未确认；请检查当前文稿及 Git 历史，内容仍在编辑器时按 Ctrl+S 重试保存。${error.message}`)}
    return{saved:true,revision:this.revision(),action:plan.action,scope:plan.scope,result};
  }
}

/** Only small request envelopes are polled. An assigned mutation is run once. */
export function connectWordLive({api,owner,editor,lock,onError,onSaved,onConnectionError,onRecovered}){
  let closed=false,timer,receipt=null,running=false,offline=false,failures=0,retryRequested=false;
  const tick=async()=>{
    if(closed||running)return;running=true;
    try{
      if(receipt){await api.wordControl('ack',{...owner,...receipt});receipt=null}
      const {request}=await api.wordControl('poll',owner);if(closed)return;
      failures=0;if(offline){offline=false;onRecovered?.()}if(!request)return;
      lock(true);
      try{receipt={id:request.id,result:await editor.run(request)};if(request.kind==='edit')onSaved?.()}
      catch(error){receipt={id:request.id,error:error.message};onError?.(error.message)}
      finally{lock(false)}
      if(!closed){await api.wordControl('ack',{...owner,...receipt});receipt=null}
    }catch(error){if(!closed){
      failures++;
      const transport=!error.code||error.code==='SERVICE_UNAVAILABLE'||['TimeoutError','AbortError'].includes(error.name);
      if(transport||error.code==='WORD_EDITOR_OWNED'){offline=true;(onConnectionError||onError)?.(error.code==='WORD_EDITOR_OWNED'?'此文稿已在另一个编辑窗口连接，请关闭重复窗口后重试。':'Word 服务暂时中断，正在自动重新连接。')}
      else onError?.(error.message);
    }}
    finally{running=false;if(!closed){const delay=retryRequested?0:Math.min(5000,650*2**Math.min(Math.max(0,failures-1),3));retryRequested=false;timer=setTimeout(tick,delay)}}
  };
  const disconnect=()=>{closed=true;clearTimeout(timer);void api.wordControl('poll',{...owner,release:true}).catch(()=>{})};
  disconnect.retry=()=>{if(closed)return;clearTimeout(timer);failures=0;if(running)retryRequested=true;else void tick()};
  void tick();return disconnect;
}
