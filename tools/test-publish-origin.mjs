import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishBridgeOrigin} from '../lib/publish-origin.js';
test('publishes current host origin atomically and never removes successor',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-origin-test-'));const file=join(dir,'origin.json');
 try{
 const ctx=origin=>({get:()=>({getOrigin:()=>origin}),logger:{info(){},warn(){}}});
 const a=publishBridgeOrigin(ctx('http://127.0.0.1:12345'),{file});await a.ready;
 let value=JSON.parse(await readFile(file));assert.equal(value.origin,'http://127.0.0.1:12345');assert.equal(value.version,1);assert.ok(value.instanceId);
 const b=publishBridgeOrigin(ctx('http://127.0.0.1:12346'),{file});await b.ready;await a.dispose();
 value=JSON.parse(await readFile(file));assert.equal(value.origin,'http://127.0.0.1:12346');
 await b.dispose();
 }finally{await rm(dir,{recursive:true,force:true})}
});
