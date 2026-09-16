import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {provision} from './provision-railway-db.mjs';
const bytes=Buffer.from('SQLite format 3\0offline fixture');
const hash=createHash('sha256').update(bytes).digest('hex');
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'db-provision-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,env:{LOCAL_RAILWAY_DB_PATH:join(dir,'railway.sqlite'),RAILWAY_DB_SHA256:hash}};}
test('existing verified database needs no URL or network',async t=>{const {env}=await fixture(t);await writeFile(env.LOCAL_RAILWAY_DB_PATH,bytes);await provision(env,()=>{throw Error('network');});});
test('existing mismatched database fails without replacing it',async t=>{const {env}=await fixture(t);await writeFile(env.LOCAL_RAILWAY_DB_PATH,'bad');await assert.rejects(provision(env),/checksum/);assert.equal(await readFile(env.LOCAL_RAILWAY_DB_PATH,'utf8'),'bad');});
test('missing artifact fails closed without URL or checksum',async t=>{const {env}=await fixture(t);await assert.rejects(provision(env),/missing/);await assert.rejects(provision({...env,RAILWAY_DB_SHA256:''}),/SHA/);});
test('mock download verifies and atomically installs bytes',async t=>{const {env}=await fixture(t);await provision({...env,RAILWAY_DB_ASSET_URL:'https://fixture.invalid/releases/v1/db'},async()=>new Response(bytes));assert.deepEqual(await readFile(env.LOCAL_RAILWAY_DB_PATH),bytes);});
test('corrupt downloaded artifact never becomes deployment database',async t=>{const {dir,env}=await fixture(t);await assert.rejects(provision({...env,RAILWAY_DB_ASSET_URL:'https://fixture.invalid/v1'},async()=>new Response('bad')),/checksum/);assert.deepEqual(await readdir(dir),[]);});
test('download rejects non-HTTPS and embedded credentials',async t=>{const {env}=await fixture(t);for(const url of ['http://fixture.invalid/v1','https://user:pass@fixture.invalid/v1'])await assert.rejects(provision({...env,RAILWAY_DB_ASSET_URL:url}),/HTTPS/);});
