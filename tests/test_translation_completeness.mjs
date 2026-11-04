import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
test('translation can require a full completion without changing existing short answers',async()=>{
 const source=(await readFile(new URL('../app/js/ai.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
 const context=vm.createContext({window:{claude:{use:async()=>async()=>({text:'partial translation',truncated:true})}}});
 vm.runInContext(source+'\nglobalThis.call=ask;',context);
 await assert.rejects(()=>context.call('translate',{requireComplete:true}),e=>e.code==='truncated');
 assert.equal(await context.call('short answer'),'partial translation');
});
