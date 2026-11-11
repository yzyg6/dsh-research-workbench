// Display-only, word-level differences. Never alter sentence alignment or text.
const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter('zh',{granularity:'word'}):null;
const words=text=>segmenter?Array.from(segmenter.segment(text),item=>item.segment):text.match(/[A-Za-z]+(?:[-’'][A-Za-z]+)*|\d+(?:\.\d+)?|\s+|[^\s]/gu)||[];
const MAX_CELLS=65536;

export function wordDifferences(before,after){
  if(before===after){const same=before?[{text:before,changed:false}]:[];return {before:same,after:same}}
  const left=words(before),right=words(after),result={before:[],after:[]};
  const append=(side,text,changed)=>{if(!text)return;const list=result[side],last=list.at(-1);if(last?.changed===changed)last.text+=text;else list.push({text,changed})};
  let start=0,end=0;
  while(start<Math.min(left.length,right.length)&&left[start]===right[start])start++;
  while(end<Math.min(left.length,right.length)-start&&left[left.length-1-end]===right[right.length-1-end])end++;
  for(const side of ['before','after'])append(side,left.slice(0,start).join(''),false);
  const a=left.slice(start,left.length-end),b=right.slice(start,right.length-end);
  if(!a.length||!b.length||(a.length+1)*(b.length+1)>MAX_CELLS){
    // Bound work for unusually long replacements; preserve the shared edges.
    append('before',a.join(''),true);append('after',b.join(''),true);
  }else{
    const width=b.length+1,dp=new Uint16Array((a.length+1)*width);
    for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)
      dp[i*width+j]=a[i]===b[j]?dp[(i+1)*width+j+1]+1:Math.max(dp[(i+1)*width+j],dp[i*width+j+1]);
    let i=0,j=0;
    while(i<a.length||j<b.length){
      if(i<a.length&&j<b.length&&a[i]===b[j]){append('before',a[i],false);append('after',b[j],false);i++;j++}
      else if(i<a.length&&(j===b.length||dp[(i+1)*width+j]>=dp[i*width+j+1]))append('before',a[i++],true);
      else append('after',b[j++],true);
    }
  }
  if(end)for(const side of ['before','after'])append(side,left.slice(left.length-end).join(''),false);
  return result;
}
