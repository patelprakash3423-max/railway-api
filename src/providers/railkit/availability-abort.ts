import {AsyncLocalStorage} from 'node:async_hooks';
interface AvailabilityScope {signal:AbortSignal;timeoutMs?:number;onResponse?:(status:number)=>void;onFailure?:(category:'NETWORK_FAILURE'|'INVALID_PROVIDER_RESPONSE'|'PROVIDER_TIMEOUT')=>void}
const scope=new AsyncLocalStorage<AvailabilityScope>();
let installedTransport:typeof globalThis.fetch|undefined;
export function availabilitySignal(){return scope.getStore()?.signal;}
export function availabilityTimeoutMs(){return scope.getStore()?.timeoutMs;}
/** The SDK has no signal parameter. Scope only its fetch calls; concurrent
 * requests get independent signals, and unrelated fetches pass through. */
export function installAvailabilityAbortTransport(){
 if(globalThis.fetch===installedTransport)return;
 const original=globalThis.fetch;
 installedTransport=globalThis.fetch=(input,init)=>{
  const context=scope.getStore(),signal=context?.signal;
  if(!signal)return original(input,init);
  signal.throwIfAborted();
  const existing=init?.signal??(input instanceof Request?input.signal:undefined);
  return original(input,{...init,signal:existing?AbortSignal.any([signal,existing]):signal}).then(response=>{
   context?.onResponse?.(response.status);
   // The SDK catches JSON/network errors and reduces them to message strings.
   // Capture their category before that conversion; do not read/copy the body.
   const json=response.json.bind(response);
   response.json=async()=>{try{return await json();}catch(error){
    context?.onFailure?.(error instanceof SyntaxError?'INVALID_PROVIDER_RESPONSE':signal.aborted?'PROVIDER_TIMEOUT':'NETWORK_FAILURE');throw error;
   }};
   return response;
  },error=>{context?.onFailure?.(signal.aborted||error?.name==='TimeoutError'?'PROVIDER_TIMEOUT':'NETWORK_FAILURE');throw error;});
 };
}
export function inAvailabilityScope<T>(signal:AbortSignal,work:()=>Promise<T>,options:Omit<AvailabilityScope,'signal'>={}):Promise<T>{return scope.run({signal,...options},work);}
export async function abortable<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T>{
 signal.throwIfAborted();
 let onAbort:()=>void=()=>{};
 const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});});
 try{return await Promise.race([aborted,Promise.resolve().then(()=>{signal.throwIfAborted();return work();})]);}
 finally{signal.removeEventListener('abort',onAbort);}
}
