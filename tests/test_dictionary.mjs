import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../app/js/dictionary.js',import.meta.url),'utf8')).replace(/^export /gm,'').replaceAll('import.meta.url','"https://app.test/js/dictionary.js"');
function fixture() {
  const requests=[];
  const ctx=vm.createContext({URL,AbortController,setTimeout,clearTimeout,fetch:async url=>{
    requests.push(new URL(url).pathname);
    return Response.json(JSON.parse(await readFile(new URL('../app'+new URL(url).pathname,import.meta.url),'utf8')));
  }});
  vm.runInContext(source+'\nglobalThis.api={lookup,dictionaryInfo,normalizeQuery,inflections,nearby};',ctx);
  return {api:ctx.api,requests};
}
test('lookup uses the independent full dictionary and fetches only one shard',async()=>{
  const {api,requests}=fixture();
  const bank=JSON.parse(await readFile(new URL('../app/vocabulary/words.json',import.meta.url),'utf8'));
  const word='electroencephalography';
  assert.equal(bank.words.some(row=>row.id===word),false);
  const result=await api.lookup(word);
  assert.equal(result.entries[0].word,word);
  assert.ok(result.entries[0].meaning.length>0);
  assert.deepEqual(requests,['/dictionary/index.json','/dictionary/shards/el.json']);
  await api.lookup('elephant');
  assert.equal(requests.length,2,'repeat prefix is cached');
  assert.ok((await api.dictionaryInfo()).count>700000);
});
test('case, phrases, spelling suggestions and attested forms work without a model',async()=>{
  const {api}=fixture();
  assert.equal(api.normalizeQuery('  ＨＥＬＬＯ  '),'hello');
  assert.ok((await api.lookup('take for granted')).entries.length);
  assert.ok((await api.lookup('recieve')).suggestions.includes('receive'));
  assert.equal(api.nearby('hello','helo'),1);
  assert.deepEqual(JSON.parse(JSON.stringify(api.inflections('p:went/d:gone/invalid:x'))),[{kind:'p',term:'went'},{kind:'d',term:'gone'}]);
});
