import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReceivableCollectorHints } from './receivable-collector-plan.mjs';
const a='60000000-0000-4000-8000-000000000001',b='60000000-0000-4000-8000-000000000002';
const collectors=[{id:a,display_name:'Cobradora Exemplo A',enabled:true},{id:b,display_name:'Cobradora Exemplo B',enabled:true}];
const group=(key,other={})=>({customer_key:`name:${key}`,collector_id:null,requires_selection:true,locked:false,...other});
const hint=(line,key,name='Cobradora Exemplo A')=>({line,customer_key:`name:${key}`,collector_name:name});
test('exact normalized active names assign each customer once without altering financial rows',()=>{
 const r=resolveReceivableCollectorHints({hints:[hint(2,'UM','COBRADORA  EXEMPLO Á'),hint(3,'UM'),hint(4,'DOIS','Cobradora Exemplo B')],assignments:[group('UM'),group('DOIS')],collectors});
 assert.deepEqual(r.mappings,{'name:UM':a,'name:DOIS':b});assert.deepEqual(r.problems,[]);
 assert.deepEqual(r.summary,{file_title_count:3,file_customer_count:2,assigned_customer_count:2,preserved_customer_count:0,manual_customer_count:0});
});
test('existing and locked wallets always preserve their official owner even if the file differs',()=>{
 const r=resolveReceivableCollectorHints({hints:[hint(2,'UM')],assignments:[group('UM',{collector_id:b,requires_selection:false,locked:true})],collectors,mappings:{'name:UM':a}});
 assert.deepEqual(r.mappings,{});assert.equal(r.summary.preserved_customer_count,1);assert.deepEqual(r.problems,[]);
});
test('unknown and ambiguous active names require a manual choice and are never guessed',()=>{
 for(const names of [collectors,[...collectors,{id:'60000000-0000-4000-8000-000000000003',display_name:'COBRADORA EXEMPLO A',enabled:true}]]){
  const r=resolveReceivableCollectorHints({hints:[hint(2,'UM',names===collectors?'Inexistente':'Cobradora Exemplo A')],assignments:[group('UM')],collectors:names});
  assert.deepEqual(r.mappings,{});assert.equal(r.problems.length,1);assert.equal(r.problems[0].line,2);assert.equal(r.problems[0].column,'COBRADORA');
 }
});
test('an explicit manual choice resolves an unknown file name and an explicit blank suppresses autofill',()=>{
 const base={hints:[hint(2,'UM','Não cadastrado')],assignments:[group('UM')],collectors};
 const r=resolveReceivableCollectorHints({...base,mappings:{'name:UM':b}});assert.deepEqual(r.mappings,{'name:UM':b});assert.deepEqual(r.problems,[]);assert.equal(r.summary.manual_customer_count,1);
 const blank=resolveReceivableCollectorHints({...base,mappings:{'name:UM':''}});assert.deepEqual(blank.mappings,{});assert.deepEqual(blank.problems,[]);
});
test('a report without hints retains the Central manual assignment workflow and never copies stale other-customer choices',()=>{
 const r=resolveReceivableCollectorHints({hints:[],assignments:[group('UM')],collectors,mappings:{'name:UM':a,'name:ANTIGO':b}});
 assert.deepEqual(r.mappings,{'name:UM':a});assert.equal(r.summary.file_customer_count,0);
});
test('conflicting names for the same customer cannot be overridden by an automatic or manual guess',()=>{
 const r=resolveReceivableCollectorHints({hints:[hint(2,'UM'),hint(3,'UM','Cobradora Exemplo B')],assignments:[group('UM')],collectors,mappings:{'name:UM':a}});
 assert.deepEqual(r.mappings,{});assert.equal(r.problems.length,1);
});
test('invalid hints and inactive manual identifiers cannot reach the server assignment map',()=>{
 const base={hints:[hint(2,'UM')],assignments:[group('UM')],collectors};
 assert.throws(()=>resolveReceivableCollectorHints({...base,mappings:{'name:UM':'inactive'}}),/ativa/);
 for(const hints of [[hint(1,'UM')],[hint(2,'OUTRO')],[hint(2,'UM'),hint(2,'UM')],[hint(2,'UM','A\nB')]])assert.throws(()=>resolveReceivableCollectorHints({...base,hints}));
});
