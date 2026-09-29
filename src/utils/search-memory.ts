import {AsyncLocalStorage} from 'node:async_hooks';
import type {SearchLogger} from './logger.js';

const context=new AsyncLocalStorage<{requestId:string;logger:SearchLogger;started:number}>();
export function withSearchMemoryDiagnostics<T>(requestId:string,logger:SearchLogger,work:()=>T):T {
 return context.run({requestId,logger,started:performance.now()},work);
}
export function searchDiagnosticContext(){
 const current=context.getStore();
 return current?{requestId:current.requestId,started:current.started}:undefined;
}
export function memorySnapshot(started:number){
 const {rss,heapUsed}=process.memoryUsage();
 return {rss,heapUsed,elapsedMs:Math.round(performance.now()-started)};
}
/** Only synchronous phase boundaries; no polling, retained samples or payloads. */
export function memoryPhase<T>(phase:'network_build'|'planner',work:()=>T):T {
 const current=context.getStore();if(!current)return work();
 const started=performance.now();
 const log=(outcome:string)=>{try{current.logger({event:`journey_v2_${phase}_${outcome}`,requestId:current.requestId,...memorySnapshot(started)});}catch{/* Diagnostics cannot fail work. */}};
 log('started');
 try{const result=work();log('completed');return result;}
 catch(error){log('failed');throw error;}
}
