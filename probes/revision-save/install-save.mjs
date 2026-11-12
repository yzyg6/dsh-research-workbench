import {revisionAction} from '../../src/server/revision-service.mjs';
import {StoreError} from '../../src/server/store.mjs';

/** Narrow, reversible repair for a Host whose client was updated first.
 * Keep the live store, Word instance, native sessions and all other routes. */
export function installSentenceSave(runtime, ErrorClass=StoreError) {
  if(runtime.sentenceSaveRepair)return runtime.sentenceSaveRepair;
  const previous=runtime.mutate;
  const patched=async function(action,data){
    if(action!=='editSentenceSuggestion')return previous.call(this,action,data);
    try {
      const actionResult=await revisionAction(this,action,data);
      for(const listener of this.listeners){try{listener()}catch{/* Committed saves survive optional listeners. */}}
      return {...await this.viewState(),actionResult};
    } catch(error) {
      // The pre-update HTTP handler checks its own StoreError constructor.
      if(error instanceof StoreError&&!(error instanceof ErrorClass))throw new ErrorClass(error.code,error.message,error.status);
      throw error;
    }
  };
  runtime.mutate=patched;
  const repair={version:1,restore(){if(runtime.mutate===patched)runtime.mutate=previous;delete runtime.sentenceSaveRepair}};
  runtime.sentenceSaveRepair=repair;
  return repair;
}
