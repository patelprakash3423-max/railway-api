import {AsyncLocalStorage} from 'node:async_hooks';
import type {SearchLogger} from './logger.js';

type Phase='scheduler_queue'|'availability_check'|'scheduler_wait'|'provider_invoke'|'redis_read'|'redis_write'|'sqlite_read'|'sqlite_write'|'recovery'|'revisit'|'solver';
const bounds=[1,5,10,25,50,100,150,250,500,1000,2000,5000,10000,15000,30000,60000,90000,Infinity];
type Row={started:number;completed:number;totalMs:number;maxMs:number;buckets:number[];active:Set<{start:number}>};
const scope=new AsyncLocalStorage<Map<Phase,Row>>();
const counters=new AsyncLocalStorage<Record<string,number>>();
export function searchTimingCounter(name:string,amount=1){const current=counters.getStore();if(current)current[name]=(current[name]??0)+amount;}
/** Inclusive wall times, not additive CPU times. Fixed histograms bound memory. */
export function beginSearchTiming(phase:Phase):()=>void {
 const rows=scope.getStore();if(!rows)return ()=>{};
 let row=rows.get(phase);
 if(!row){row={started:0,completed:0,totalMs:0,maxMs:0,buckets:bounds.map(()=>0),active:new Set()};rows.set(phase,row);}
 const token={start:performance.now()};row.started++;row.active.add(token);let ended=false;
 return ()=>{if(ended)return;ended=true;const ms=performance.now()-token.start;row.active.delete(token);row.completed++;row.totalMs+=ms;row.maxMs=Math.max(row.maxMs,ms);row.buckets[bounds.findIndex(b=>ms<=b)]++;};
}
export async function timeSearchAsync<T>(phase:Phase,work:()=>Promise<T>):Promise<T>{
 const end=beginSearchTiming(phase);try{return await work();}finally{end();}
}
export async function withSearchTiming<T>(requestId:string,logger:SearchLogger,work:()=>Promise<T>):Promise<T>{
 const rows=new Map<Phase,Row>();
 const counts:Record<string,number>={};
 return counters.run(counts,()=>scope.run(rows,async()=>{
  try{return await work();}finally{
   try{
    const now=performance.now();
    const phases=Object.fromEntries([...rows].map(([name,row])=>{
     let count=0;const index=row.buckets.findIndex(n=>(count+=n)>=Math.ceil(row.completed*.95));
     return [name,{started:row.started,completed:row.completed,totalMs:Math.round(row.totalMs),averageMs:row.completed?Math.round(row.totalMs/row.completed):null,
      p95UpperBoundMs:row.completed&&Number.isFinite(bounds[index])?bounds[index]:null,maxMs:Math.round(row.maxMs),active:row.active.size,activeElapsedMs:Math.round([...row.active].reduce((n,token)=>n+now-token.start,0))}];
    }));
    logger({event:'journey_v2_timing_summary',requestId,timingMeaning:'INCLUSIVE_WALL_MS_NOT_ADDITIVE',phases,counters:{...counts}});
   }catch{/* Diagnostics must not change the outcome. */}
  }
 }));
}
