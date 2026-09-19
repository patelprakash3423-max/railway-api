import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {request as httpRequest,type IncomingMessage,type ServerResponse} from 'node:http';
import {RailwayDatabase} from '../local-railway/database.js';
import {createHttpHandler,createApiServer,closeApiServer} from '../api/server.js';
import {ProtectedJourneyService} from '../api/services/protected-journey-service.js';
import {hardeningConfig,type ClientIdentityMode} from '../config/hardening.js';
import {resolveClientIdentity} from '../api/client-identity.js';
import {RailKitProvider} from '../providers/railkit/railkit-provider.js';
import {AvailabilityScheduler} from '../providers/railkit/availability-scheduler.js';

const date='25-09-2099',now=()=>Date.UTC(2099,8,25);
const input={from:'AAA',to:'CCC',date,classes:['3A'],mode:'STANDARD'};
const tick=()=>new Promise<void>(r=>setImmediate(r));
function deferred<T>(){
 let resolve!:(v:T)=>void;
 const promise=new Promise<T>(r=>{resolve=r;});
 return {promise,resolve};
}
function harness(t:TestContext,mode:ClientIdentityMode='ANONYMOUS'){
 const db=new RailwayDatabase(':memory:');
 t.after(()=>db.close());
 db.replace({stations:['AAA','CCC'].map(code=>({code,name:code})),
  trains:[{number:'30001',name:'Offline fixture',sourceCode:'AAA',destinationCode:'CCC',runningDaysRaw:'Daily',runningDays:['MON','TUE','WED','THU','FRI','SAT','SUN']}],
  stops:[{trainNumber:'30001',stationCode:'AAA',sequence:1,dayOffset:0,departureTime:'06:00',distanceKm:0},
   {trainNumber:'30001',stationCode:'CCC',sequence:2,dayOffset:0,arrivalTime:'12:00',distanceKm:600}],
  metadata:{source:'RAILPULL_NTES',importedAt:'2099-09-25T00:00:00Z',trainCount:1,stationCount:2,stopCount:2}});
 const previousKey=process.env.RAILKIT_API_KEY,previousFetch=globalThis.fetch;
 process.env.RAILKIT_API_KEY='offline-concurrency-placeholder';
 const sdkCalls:{resolve:(status?:string)=>void}[]=[];
 globalThis.fetch=async()=>{
  const gate=deferred<Response>();
  sdkCalls.push({resolve:(status='AVAILABLE')=>gate.resolve(new Response(JSON.stringify({
   success:true,data:{availability:[{date,status}]}
  })))});
  return gate.promise;
 };
 t.after(()=>{
  for(const call of sdkCalls)call.resolve();
  globalThis.fetch=previousFetch;
  if(previousKey===undefined)delete process.env.RAILKIT_API_KEY;else process.env.RAILKIT_API_KEY=previousKey;
 });
 const config={...hardeningConfig({}),clientIdentityMode:mode,providerTimeoutMs:5000,searchTimeoutMs:10000};
 const scheduler=new AvailabilityScheduler(config);
 const logs:Record<string,unknown>[]=[];
 const startWaiters:{count:number;resolve:()=>void}[]=[];
 const logger=(record:Record<string,unknown>)=>{
  logs.push(record);
  const count=logs.filter(r=>r.event==='journey_v2_search_started').length;
  for(const waiter of startWaiters)if(count>=waiter.count)waiter.resolve();
 };
 const waitForStarts=(count:number)=>logs.filter(r=>r.event==='journey_v2_search_started').length>=count
  ?Promise.resolve():new Promise<void>(resolve=>startWaiters.push({count,resolve}));
 const service=new ProtectedJourneyService(db,new RailKitProvider(scheduler),config,{diagnostics:true,logger},now);
 const retired={search:async():Promise<never>=>{throw Error('Legacy forbidden');}};
 const options={journeyV2:service,logger,clientIdentityMode:mode};
 const handler=createHttpHandler(retired,options);
 const responses:EventEmitter[]=[];
 t.after(()=>{for(const response of responses)response.emit('close');});
 function send(peer:string|undefined,headers:Record<string,string>={},body:unknown=input){
  let status=0,text='';
  const incoming=Object.assign(new EventEmitter(),{method:'POST',url:'/api/journeys/v2/search',
   headers:{'content-type':'application/json',...headers},socket:{remoteAddress:peer},
   iterator:async function*(){yield Buffer.from(JSON.stringify(body));}});
  const outgoing=Object.assign(new EventEmitter(),{writableFinished:false,
   writeHead:(s:number)=>{status=s;},end:(value:string)=>{text=value;outgoing.writableFinished=true;}});
  responses.push(outgoing);
  return handler(incoming as unknown as IncomingMessage,outgoing as unknown as ServerResponse)
   .then(()=>({status,body:JSON.parse(text)}));
 }
 return {send,logs,sdkCalls,scheduler,retired,options,waitForStarts};
}
function assertRejected(h:ReturnType<typeof harness>,category:string,used:number){
 const log=h.logs.filter(r=>r.event==='journey_v2_search_rejected').at(-1)!;
 assert.equal(log.failureCategory,category);
 for(const field of ['attemptedAvailabilityChecks','actualSdkInvocations','budgetUsed','availabilityCalls'])
  assert.equal(log[field],0);
 const snapshot=log.protection as Record<string,number>;
 assert.equal(snapshot.monthlyUsed,used);
 assert.equal(snapshot.burstUsed,used);
 assert.equal(snapshot.reservedProviderCalls,0);
 assert.deepEqual(h.scheduler.quota.snapshot(),{monthlyUsed:used,burstUsed:used,reservedProviderCalls:0});
}
const scenarios:{name:string;peers:(string|undefined)[];classification:string;headers?:Record<string,string>;mode?:ClientIdentityMode}[]=[
 {name:'same IPv4 localhost without forwarded headers',peers:['127.0.0.1','127.0.0.1','127.0.0.1','127.0.0.1'],classification:'ANONYMOUS_LOCAL'},
 {name:'same IPv6 localhost without forwarded headers',peers:['::1','::1','::1','::1'],classification:'ANONYMOUS_LOCAL'},
 {name:'same mapped localhost without forwarded headers',peers:Array(4).fill('::ffff:127.0.0.1') as string[],classification:'ANONYMOUS_LOCAL'},
 {name:'headerless shared ingress',peers:Array(4).fill('10.0.0.2') as string[],classification:'ANONYMOUS_DIRECT'},
 {name:'missing socket peer',peers:[undefined,undefined,undefined,undefined],classification:'UNKNOWN_PEER'},
 {name:'untrusted XFF',peers:Array(4).fill('10.0.0.2') as string[],classification:'UNTRUSTED_PROXY',headers:{'x-forwarded-for':'untrusted-value'}},
 {name:'standard Forwarded header',peers:Array(4).fill('10.0.0.2') as string[],classification:'UNTRUSTED_PROXY',headers:{forwarded:'untrusted-value'}},
 {name:'X-Real-IP',peers:Array(4).fill('10.0.0.2') as string[],classification:'UNTRUSTED_PROXY',headers:{'x-real-ip':'untrusted-value'}},
 {name:'forwarding overrides DIRECT_PEER',peers:Array(4).fill('127.0.0.1') as string[],classification:'UNTRUSTED_PROXY',headers:{'x-forwarded-for':'untrusted-value'},mode:'DIRECT_PEER' as const},
 {name:'controlled independent direct local peers',peers:['127.0.0.2','127.0.0.3','127.0.0.4','127.0.0.5'],classification:'DIRECT_PEER',mode:'DIRECT_PEER' as const},
];
for(const scenario of scenarios)test('HTTP admits 3 and rejects fourth globally: '+scenario.name,async t=>{
 const h=harness(t,scenario.mode);
 const pending=scenario.peers.slice(0,3).map(peer=>h.send(peer,scenario.headers));
 await tick();
 const started=h.logs.filter(r=>r.event==='journey_v2_search_started');
 assert.equal(started.length,3);
 assert.ok(started.every(r=>(r.protection as Record<string,number>).globalActive===3));
 assert.ok(started.every(r=>r.clientIdentityClass===scenario.classification));
 assert.ok(started.every(r=>r.perClientEnforced===(scenario.classification==='DIRECT_PEER')));
 if(scenario.classification!=='DIRECT_PEER')
  assert.ok(started.every(r=>(r.protection as Record<string,number>).clientActive===0));
 assert.equal(h.sdkCalls.length,1); // All three searches share real offline SDK work.
 const fourth=await h.send(scenario.peers[3],scenario.headers);
 assert.equal(fourth.status,429);assertRejected(h,'GLOBAL_CONCURRENCY',1);
 assert.equal((h.logs.at(-1)!.protection as Record<string,number>).globalActive,3);
 h.sdkCalls[0].resolve();
 const replies=await Promise.all(pending);
 assert.ok(replies.every(r=>r.status===200));
 assert.equal(replies.reduce((n,r)=>n+r.body.diagnostics.actualSdkInvocations,0),1);
 assert.ok(replies.every(r=>r.body.diagnostics.budgetLimit===30));
 assert.equal(new Set([...replies,fourth].map(r=>r.body.requestId)).size,4);
 const cached=await h.send(scenario.peers[0],scenario.headers);
 assert.equal(cached.status,200);assert.equal(cached.body.diagnostics.sharedCacheHits,1);
 assert.equal(cached.body.diagnostics.actualSdkInvocations,0);
 const serialized=JSON.stringify(h.logs);
 for(const value of [...scenario.peers,'untrusted-value','offline-concurrency-placeholder'].filter(Boolean))
  assert.ok(!serialized.includes(value!), 'diagnostics must not contain peer addresses or raw forwarding values');
});

test('declared direct peer duplicates reject at globalActive=1; rejected requests never spend SDK quota',async t=>{
 const h=harness(t,'DIRECT_PEER');
 const body={...input,classes:['3A','SL']};
 const first=h.send('127.0.0.2',{},body);
 await tick();assert.equal(h.sdkCalls.length,1);
 let duplicate=await h.send('::ffff:127.0.0.2',{},body);
 assert.equal(duplicate.status,429);assertRejected(h,'CLIENT_CONCURRENCY',1);
 let log=h.logs.at(-1)!;
 assert.equal(log.clientIdentityClass,'DIRECT_PEER');assert.equal(log.perClientEnforced,true);
 assert.equal((log.protection as Record<string,number>).globalActive,1);
 assert.equal((log.protection as Record<string,number>).perClientLimit,1);
 h.sdkCalls[0].resolve('WAITLIST');await tick();
 assert.equal(h.sdkCalls.length,2);
 duplicate=await h.send('127.0.0.2',{},body);
 assert.equal(duplicate.status,429);assertRejected(h,'CLIENT_CONCURRENCY',2);
 log=h.logs.at(-1)!;assert.equal((log.protection as Record<string,number>).globalActive,1);
 h.sdkCalls[1].resolve();assert.equal((await first).status,200);
});

test('arbitrary client IDs and browser/request hints cannot split a declared direct peer bucket',async t=>{
 const h=harness(t,'DIRECT_PEER');
 const first=h.send('127.0.0.2',{'x-client-id':'client-a','x-request-id':'request-a',cookie:'session=a'});
 await tick();
 const duplicate=await h.send('127.0.0.2',{'x-client-id':'client-b','x-request-id':'request-b',cookie:'session=b','user-agent':'different-agent'},
  {...input,clientId:'client-b',clientIdentityClass:'ANONYMOUS_LOCAL'});
 assert.equal(duplicate.status,429);assertRejected(h,'CLIENT_CONCURRENCY',1);
 h.sdkCalls[0].resolve();assert.equal((await first).status,200);
});

test('identity mode is explicit, validated, and defaults to anonymous',()=>{
 assert.equal(hardeningConfig({}).clientIdentityMode,'ANONYMOUS');
 assert.equal(hardeningConfig({SEARCH_CLIENT_IDENTITY_MODE:'DIRECT_PEER'}).clientIdentityMode,'DIRECT_PEER');
 assert.throws(()=>hardeningConfig({SEARCH_CLIENT_IDENTITY_MODE:'TRUST_XFF'}),/SEARCH_CLIENT_IDENTITY_MODE/);
 assert.equal(resolveClientIdentity('127.0.0.1',undefined).classification,'ANONYMOUS_LOCAL');
 assert.equal(resolveClientIdentity('::ffff:127.0.0.2',undefined,'DIRECT_PEER').key,'127.0.0.2');
});

test('real loopback HTTP connections admit three independent API clients with the default policy',{timeout:5000},async t=>{
 const h=harness(t),server=createApiServer(h.retired,h.options);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>closeApiServer(server));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const send=()=>new Promise<{status:number;body:any}>((resolve,reject)=>{
  const req=httpRequest({host:'127.0.0.1',port:address.port,path:'/api/journeys/v2/search',method:'POST',agent:false,
   headers:{'content-type':'application/json'}},response=>{
   let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;});
   response.on('end',()=>resolve({status:response.statusCode!,body:JSON.parse(text)}));
  });
  req.on('error',reject);req.end(JSON.stringify(input));
 });
 const pending=[send(),send(),send()];
 await h.waitForStarts(3);
 await tick();
 assert.equal(h.logs.filter(r=>r.event==='journey_v2_search_started').length,3);
 const fourth=await send();assert.equal(fourth.status,429);assertRejected(h,'GLOBAL_CONCURRENCY',1);
 h.sdkCalls[0].resolve();assert.ok((await Promise.all(pending)).every(r=>r.status===200));
});
