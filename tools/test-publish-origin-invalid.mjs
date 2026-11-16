import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishBridgeOrigin} from '../lib/publish-origin.js';
test('invalid host origins do not publish files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-origin-invalid-'));
 try{
 for(const origin of ['https://127.0.0.1:20','http://example.com:20','http://user@127.0.0.1:20','http://127.0.0.1:20/api','http://127.0.0.1:20/?x=1']){
 let warnings=0;
 const publisher=publishBridgeOrigin({get:()=>({getOrigin:()=>origin}),logger:{warn(){warnings++}}},{file:join(dir,'origin.json')});
 await publisher.ready;assert.equal(warnings,1);assert.deepEqual(await readdir(dir),[]);
 }
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('dispose registered by effect prevents pending publication and cleans temporary file',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-origin-dispose-'));
 try{
 let cleanup;
 const publisher=publishBridgeOrigin({get:()=>({getOrigin:()=> 'http://127.0.0.1:12345'}),effect(fn){cleanup=fn()},logger:{info(){},warn(){}}},{file:join(dir,'origin.json')});
 assert.equal(typeof cleanup,'function');await cleanup();await publisher.ready;
 assert.deepEqual(await readdir(dir),[]);
 }finally{await rm(dir,{recursive:true,force:true})}
});
