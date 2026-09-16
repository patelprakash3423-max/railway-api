import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat,mkdir,open,rename,rm} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function sha256(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export async function provision(env=process.env,download=globalThis.fetch){
 const target=resolve(env.LOCAL_RAILWAY_DB_PATH||'data/local-railway/railway.sqlite');
 const expected=env.RAILWAY_DB_SHA256?.trim().toLowerCase();
 if(!expected||!(/^[a-f0-9]{64}$/).test(expected))throw Error('RAILWAY_DB_SHA256 must contain the expected SHA-256 checksum');
 const verify=async path=>{if(await sha256(path)!==expected)throw Error('SQLite checksum mismatch');const f=await open(path,'r');try{const h=Buffer.alloc(16);await f.read(h,0,16,0);if(h.toString()!=='SQLite format 3\0')throw Error('Invalid SQLite header');}finally{await f.close();}};
 try{await stat(target);await verify(target);return target;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!env.RAILWAY_DB_ASSET_URL)throw Error('SQLite is missing; configure RAILWAY_DB_ASSET_URL');
 const url=new URL(env.RAILWAY_DB_ASSET_URL);
 if(url.protocol!=='https:'||url.username||url.password)throw Error('Database artifact URL must use HTTPS without embedded credentials');
 await mkdir(dirname(target),{recursive:true});
 const temporary=target+'.download-'+randomUUID();
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
 try{
  const response=await download(url,{signal:controller.signal,redirect:'follow'});
  if(!response.ok||!response.body)throw Error('Database artifact download failed');
  const file=await open(temporary,'wx',0o600);let size=0;
  try{for await(const chunk of response.body){size+=chunk.length;if(size>256*1024*1024)throw Error('Database artifact exceeds 256 MiB');await file.writeFile(chunk);}await file.sync();}finally{await file.close();}
  await verify(temporary);await rename(temporary,target);return target;
 }finally{clearTimeout(timer);await rm(temporary,{force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await provision();console.log('SQLite artifact checksum verified.');}
 catch{console.error('SQLite provisioning failed. Check the configured path, HTTPS asset URL and SHA-256 checksum.');process.exitCode=1;}
}
