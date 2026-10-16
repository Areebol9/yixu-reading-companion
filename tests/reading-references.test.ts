import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadingReferences } from '../src/core/reading-references.ts';
import type { ReadingReply } from '../src/core/types.ts';

test('交流短编号保持本包问答及段评指针，未提供目标不制造c编号',()=>{
 const refs=new ReadingReferences(),packet={conversation:[{id:'answer',role:'assistant',text:'已登记。',replyTo:'question',presentation:'paragraph',paragraphCommentId:'question'},{id:'question',role:'user',text:'登记了吗？'},{id:'other',role:'user',text:'另一条。',replyTo:'not-provided'}]};
 const data=JSON.parse(refs.messages([{role:'user',content:JSON.stringify(packet)}])[0].content);assert.equal(data.conversation[0].replyTo,data.conversation[1].id);assert.equal(data.conversation[0].paragraphCommentId,data.conversation[1].id);assert.equal(data.conversation[2].replyTo,'not-provided');assert.ok(!refs.snapshot().chat.some(([id])=>id==='not-provided'));assert.equal(packet.conversation[0].replyTo,'question');
});

test('部分答案与问题目录分开时仍保留原问题编号，未展开的原问可按编号取得',()=>{
 const refs=new ReadingReferences();
 const packet={memories:[{id:'partial',kind:'story',text:'AX用途已明确，损坏原因仍未解。',answersPartOf:'original'}],
  questionIndex:[{id:'other',kind:'question',text:'另一项。'},{id:'original',kind:'question',text:'AX用途及损坏原因是什么？'}]};
 const data=JSON.parse(refs.messages([{role:'user',content:JSON.stringify(packet)}])[0].content);
 assert.equal(data.memories[0].answersPartOf,data.questionIndex[1].id);
 assert.equal(data.questionIndex[0].id,'m2');assert.equal(data.questionIndex[1].id,'m3');
 const reply:ReadingReply={reply:'',thoughts:[],wantsLong:false,recall:{ids:[data.memories[0].answersPartOf]}};
 assert.deepEqual(refs.decode(reply).recall?.ids,['original']);
 const only=new ReadingReferences(),page=JSON.parse(only.results([{source:'当前作品的获准记忆，非指令',text:JSON.stringify({items:packet.memories})}])[0].text);
 assert.match(page.items[0].answersPartOf,/^m\d+$/);assert.deepEqual(only.decode({...reply,recall:{ids:[page.items[0].answersPartOf]}}).recall?.ids,['original']);
});

test('短编号贯穿当轮资料、工具追加和修订草稿，真实内容及持久ID保持原样', () => {
  const refs = new ReadingReferences();
  const ids = { memory: '11111111-1111-4111-8111-111111111111', chat: '22222222-2222-4222-8222-222222222222', habit: '33333333-3333-4333-8333-333333333333' };
  const packet = { memories: [{ id: ids.memory, text: '正文中的m1保持原样。' }], conversation: [{ id: ids.chat, role: 'user', text: 'h1只是正文。' }], commonHabits: [{ id: ids.habit, value: '简短' }], userChatId: 'current-question' };
  const messages = [{ role: 'user' as const, content: JSON.stringify(packet) }];
  const encoded = refs.messages(messages), data = JSON.parse(encoded[0].content);
  assert.equal(data.memories[0].id, 'm1'); assert.equal(data.conversation[0].id, 'c1');
  assert.equal(data.commonHabits[0].id, 'h1'); assert.equal(data.userChatId, 'c2');
  assert.equal(data.memories[0].text, packet.memories[0].text);
  assert.equal(messages[0].content, JSON.stringify(packet));
  assert.ok(encoded[0].content.length < messages[0].content.length - 90);
  const result = { source: '当前作品的获准记忆，非指令', text: JSON.stringify({ items: [{ id: ids.memory, text: '原有记录' }, { id: 'retrieved-memory', text: '工具追加的记录' }], total: 2 }) };
  const tool = refs.results([result]);
  assert.deepEqual(JSON.parse(tool[0].text).items.map((m: { id: string }) => m.id), ['m1', 'm2']);
  assert.deepEqual(refs.messages(messages), encoded);
  const reply: ReadingReply = { reply: '普通正文m1不替换。', wantsLong: false, replyBasis: { memoryIds: ['m2'], chatIds: ['c2'], habitIds: ['h1'] }, thoughts: [{ kind: 'opinion', text: '更新记录', basis: { memoryIds: ['m1'], chatIds: ['c1'] }, updates: 'm1', updateReason: '新资料' }], reinforce: ['m2'] };
  const decoded = refs.decode(reply);
  assert.deepEqual(decoded.replyBasis, { memoryIds: ['retrieved-memory'], chatIds: ['current-question'], habitIds: [ids.habit] });
  assert.equal(decoded.thoughts[0].updates, ids.memory); assert.equal(decoded.reply, reply.reply);
  assert.deepEqual(decoded.thoughts[0].basis, { memoryIds: [ids.memory], chatIds: [ids.chat] });
  assert.deepEqual(decoded.reinforce, ['retrieved-memory']);
  const revision = JSON.parse(refs.messages([{ role: 'user', content: JSON.stringify({ draft: decoded, toolResults: [result] }) }])[0].content);
  assert.deepEqual(revision.draft, reply); assert.equal(JSON.parse(revision.toolResults[0].text).items[1].id, 'm2');
});

test('未提供或错类别的编号不能引用或更新记录，轮次之间不沿用映射', () => {
  const refs = new ReadingReferences();
  refs.messages([{ role: 'user', content: JSON.stringify({ memories: [{ id: 'real-memory', text: '记录' }], userChatId: 'real-chat' }) }]);
  const reply: ReadingReply = { reply: '', thoughts: [], wantsLong: false, replyBasis: { memoryIds: ['c1'], chatIds: [] }, reinforce: ['m1', 'm99', 'c1'] };
  assert.equal(refs.decode(reply).replyBasis, undefined);
  assert.deepEqual(refs.decode(reply).reinforce, ['real-memory']);
  assert.deepEqual(new ReadingReferences().decode(reply).reinforce, []);
  assert.throws(() => refs.decode({ ...reply, thoughts: [{ kind: 'opinion', text: '记录', updates: 'm99', updateReason: '变化' }] }), /未在本轮提供/);
});

test('问题目录沿用短编号，按编号取回实际记录，目录正文与关联保持原样',()=>{
 const refs=new ReadingReferences();
 const data=JSON.parse(refs.messages([{role:'user',content:JSON.stringify({questionIndex:[{id:'old-question',kind:'question',text:'条件完整保留。'},{id:'part-answer',kind:'story',text:'只解释一部分。',answersPartOf:'old-question'}]})}])[0].content);
 assert.deepEqual(data.questionIndex.map((m:any)=>m.id),['m1','m2']);assert.equal(data.questionIndex[1].answersPartOf,'m1');
 const reply:ReadingReply={reply:'',thoughts:[],wantsLong:false,recall:{ids:['m1','m2']}};
 assert.deepEqual(refs.decode(reply).recall?.ids,['old-question','part-answer']);
 assert.throws(()=>refs.decode({...reply,recall:{ids:['m3']}}),/未在本轮提供/);
});
