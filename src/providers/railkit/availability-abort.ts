import {AsyncLocalStorage} from 'node:async_hooks';
const scope=new AsyncLocalStorage<AbortSignal>();
let installed=false;
/** The SDK has no signal parameter. Scope only its fetch calls; concurrent
 * requests get independent signals, and unrelated fetches pass through. */
export function installAvailabilityAbortTransport(){
 if(installed)return;installed=true;
 const original=globalThis.fetch;
 globalThis.fetch=(input,init)=>{
  const signal=scope.getStore();
  if(!signal)return original(input,init);
  signal.throwIfAborted();
  const existing=init?.signal??(input instanceof Request?input.signal:undefined);
  return original(input,{...init,signal:existing?AbortSignal.any([signal,existing]):signal});
 };
}
export function inAvailabilityScope<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T>{return scope.run(signal,work);}
export async function abortable<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T>{
 signal.throwIfAborted();
 let onAbort:()=>void=()=>{};
 const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});});
 try{return await Promise.race([aborted,Promise.resolve().then(()=>{signal.throwIfAborted();return work();})]);}
 finally{signal.removeEventListener('abort',onAbort);}
}
