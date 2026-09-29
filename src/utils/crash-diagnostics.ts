import {writeSync} from 'node:fs';
import {redact} from './errors.js';
import {memorySnapshot,searchDiagnosticContext} from './search-memory.js';

let installed=false;
/** Monitor only: Node retains its normal fatal exit and default stderr output. */
export function installCrashDiagnostics(){
 if(installed)return;installed=true;
 const started=performance.now();
 process.on('uncaughtExceptionMonitor',(error,origin)=>{
  try{
   const current=searchDiagnosticContext();
   writeSync(2,redact(JSON.stringify({event:'process_uncaught_exception',level:'error',origin,
    pid:process.pid,requestId:current?.requestId??null,...memorySnapshot(current?.started??started),
    stack:redact(error.stack??error.name).slice(0,8192)}))+'\n');
  }catch{/* Best effort; never replace or swallow the original fatal error. */}
 });
}
