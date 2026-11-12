import {spawn} from 'node:child_process';

/** One bounded, serial JSON-lines worker. Failed writes are never replayed. */
export class PythonWorker {
  constructor(script){this.script=script;this.child=null;this.tail=Promise.resolve();this.sequence=0;this.closed=false;this.current=null;this.buffer=''}
  start(){
    if(this.child)return;
    const child=spawn('python',['-I','-u','-X','utf8',this.script,'--worker'],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;this.buffer='';
    const failed=()=>{if(this.child!==child)return;this.child=null;this.current?.reject(Error('Word 处理进程已退出；本次操作未重试，请检查保存状态。'));this.current=null};
    child.on('error',failed);child.on('close',failed);child.stderr.resume();child.stdin.on('error',()=>{});child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      this.buffer+=chunk;if(this.buffer.length>2*1024*1024){this.child=null;this.current?.reject(Error('Word 检查结果超过上限。'));this.current=null;child.kill();return}
      let newline;while((newline=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);const pending=this.current;if(!pending)continue;let value;try{value=JSON.parse(line)}catch{this.child=null;pending.reject(Error('Word 处理结果格式无效。'));this.current=null;child.kill();return}if(value.id!==pending.id)continue;this.current=null;value.error?pending.reject(Error(value.error)):pending.resolve(value.result)}
    });
  }
  call(args){
    const operation=this.tail.then(()=>new Promise((resolve,reject)=>{
      if(this.closed){reject(Error('Word 处理服务已关闭。'));return}
      clearTimeout(this.idle);this.start();const child=this.child,id=++this.sequence;
      const finish=(fn,value)=>{clearTimeout(timer);this.idle=setTimeout(()=>{if(this.child===child&&!this.current){this.child=null;child.kill()}},60000);this.idle.unref?.();fn(value)};
      const timer=setTimeout(()=>{this.current=null;if(this.child===child)this.child=null;child.kill();finish(reject,Error('Word 检查超时，本次操作未重试。'))},30000);
      this.current={id,resolve:value=>finish(resolve,value),reject:error=>finish(reject,error)};
      child.stdin.write(JSON.stringify({id,args})+'\n',error=>{if(error&&this.current?.id===id){this.current.reject(error);this.current=null}});
    }));this.tail=operation.catch(()=>{});return operation;
  }
  async close(){this.closed=true;await this.tail;clearTimeout(this.idle);this.child?.kill();this.child=null}
}
