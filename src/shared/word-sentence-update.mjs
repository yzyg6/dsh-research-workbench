/** Wordcraft positions use UTF-8 byte offsets, including for Chinese and emoji. */
export function selectionWithText(selection,text){
  const {anchor,focus}=selection||{};
  if(!anchor||!focus||anchor.story!==focus.story||JSON.stringify(anchor.path)!==JSON.stringify(focus.path))throw Error('句子必须位于同一段落。');
  const start=anchor.off<=focus.off?anchor:focus;
  return{anchor:{...start},focus:{...start,off:start.off+new TextEncoder().encode(text).length},text};
}
