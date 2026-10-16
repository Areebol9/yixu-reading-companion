import {id} from './books.ts';
import type {CommonHabit,HabitKey,State} from './types.ts';

export const habitOptions: Record<HabitKey,{label:string;values:Record<string,string>}> = {
 replyLength:{label:'回复长短',values:{brief:'简短为主',balanced:'按内容决定',expanded:'愿意深入展开'}},
 followupQuestions:{label:'追问频率',values:{sparse:'尽量少追问',welcome:'可以适度追问'}}
};
export const habitDescription=(habit:CommonHabit):string=>habitOptions[habit.key].values[habit.value];
export const validHabit=(key:unknown,value:unknown):key is HabitKey=>typeof key==='string'&&Object.hasOwn(habitOptions,key)&&typeof value==='string'&&Object.hasOwn(habitOptions[key as HabitKey].values,value);
export function currentHabits(state:{ readonly habits?: readonly CommonHabit[]; readonly partnerId: string }):CommonHabit[]{
 return (state.habits??[]).filter(h=>h.partnerId===state.partnerId&&!h.retiredBy&&!h.forgotten&&!h.invalidatedBy);
}
export type HabitPlan={added:CommonHabit[];retired:{id:string;by:string}[];ids:string[]};
export function planHabit(state:State,key:HabitKey,value:string,source?:{bookId:string;chatId:string}):HabitPlan{
 if(!validHabit(key,value))throw new Error('相处习惯选项无效');
 const previous=currentHabits(state).find(h=>h.key===key);
 if(previous?.value===value)return {added:[],retired:[],ids:[previous.id]};
 const habit:CommonHabit={id:id(),partnerId:state.partnerId,key,value,createdAt:Date.now(),forgotten:false,replaces:previous?.id,sourceBookId:source?.bookId,sourceChatId:source?.chatId};
 return {added:[habit],retired:previous?[{id:previous.id,by:habit.id}]:[],ids:[habit.id]};
}

/** Recognize a small set of explicit, standalone reader requests, never book material
 * or model-produced summaries. Unrecognized preferences remain scoped to their book. */
export function inputHabitValue(text:string):{key:HabitKey;value:string}|undefined{
 if(text.length>100||/[“”"'「」『』《》?？\n]/u.test(text)||/这本|本书|这次|本次|现在|今天|暂时|作者|角色|他说|她说|不要记|别记|不用记/u.test(text))return;
 let value=text.trim().replace(/[。！!]+$/u,'').replace(/^(?:请)?记住[：:，,]?\s*/u,'').replace(/[，,\s]/gu,'');
 if(/^(?:(?:以后|今后|平时|默认)(?:都)?|我(?:更)?(?:喜欢|希望)(?:你)?|请你)(?:回复|回答|解释)(?:都)?(?:简短|简洁|短)(?:一些|一点|些|点|为主)?$/u.test(value))return{key:'replyLength',value:'brief'};
 if(/^(?:(?:以后|今后|平时|默认)(?:都)?|我(?:更)?(?:喜欢|希望)(?:你)?|请你)(?:回复|回答|解释)(?:都)?(?:详细|深入)(?:一些|一点|些|点)?$/u.test(value))return{key:'replyLength',value:'expanded'};
 if(/^(?:以后|今后|平时|默认)(?:都)?(?:尽量)?(?:少追问|不要一直追问|不要总追问)(?:我)?$/u.test(value))return{key:'followupQuestions',value:'sparse'};
 if(/^(?:以后|今后|平时|默认)(?:你)?(?:可以|允许你)(?:适度|适当)?追问(?:我)?$/u.test(value))return{key:'followupQuestions',value:'welcome'};
}
export function planInputHabit(state:State,text:string,source:{bookId:string;chatId:string}):HabitPlan{
 const found=inputHabitValue(text);
 return found?planHabit(state,found.key,found.value,source):{added:[],retired:[],ids:[]};
}

export function stagedHabits(state:State,plan:HabitPlan):State{
 const retired=new Map(plan.retired.map(r=>[r.id,r.by]));
 const next:State={...state,habits:[...(state.habits??[]).map(h=>({...h,retiredBy:retired.get(h.id)??h.retiredBy})),...plan.added.map(h=>({...h}))],
  memories:state.memories.map(m=>({...m})),chats:state.chats.map(c=>({...c})),forgotten:[...state.forgotten]};
 reconcileHabits(next);return next;
}

/** Only fixed values cross books. Original text, book IDs and source chats stay local. */
export function habitContext(state:State){
 return currentHabits(state).map(h=>({id:h.id,setting:habitOptions[h.key].label,value:habitDescription(h)}));
}

export function reconcileHabits(state:State):void{
 const habits=state.habits??[],chats=new Map(state.chats.map(c=>[c.id,c]));
 for(const habit of habits){
  const chat=habit.sourceChatId?chats.get(habit.sourceChatId):undefined;
  const revision=(state.transcriptRevisions??[]).find(r=>r.originalId===habit.sourceChatId);
  // Deleting a chat alone leaves its independently saved habit intact.
  if(chat?.excluded)habit.forgotten=true;
  if(chat?.outdatedBy||revision)habit.invalidatedBy??=chat?.outdatedBy??revision!.id;
 }
 const retired=new Map(habits.filter(h=>h.retiredBy||h.forgotten||h.invalidatedBy).map(h=>[h.id,{id:h.id,forgotten:h.forgotten}]));
 const memoryReasons=new Map<string,{id:string;forgotten:boolean}>(),chatReasons=new Map<string,{id:string;forgotten:boolean}>();
 // A changed preference does not make the earlier statement unspoken. Forgetting
 // still removes the source and every possible exposure, as explicitly requested.
 for(const habit of habits){const reason=retired.get(habit.id);if(reason?.forgotten&&habit.sourceChatId)chatReasons.set(habit.sourceChatId,reason);}
 for(const item of [...state.memories,...state.chats]){
  const reason=item.habitIds?.map(id=>retired.get(id)).find(r=>r?.forgotten)??(item.basis?.habitIds??item.habitIds)?.map(id=>retired.get(id)).find(Boolean);
  if(reason)('parents' in item?memoryReasons:chatReasons).set(item.id,reason);
 }
 // Carry a changed/forgotten habit through the full exposure graph, across books.
 let changed=true;
 while(changed){changed=false;
  for(const m of state.memories){
   const full=[...m.parents.map(id=>memoryReasons.get(id)),...m.chatIds.map(id=>chatReasons.get(id))];
   const reasons=[...full.filter(r=>r?.forgotten),...(m.basis?.memoryIds??m.parents).map(id=>memoryReasons.get(id)),...(m.basis?.chatIds??m.chatIds).map(id=>chatReasons.get(id))].filter(Boolean);
   const reason=reasons.find(r=>r!.forgotten)??reasons[0],previous=memoryReasons.get(m.id);
   if(reason&&(!previous||reason.forgotten&&!previous.forgotten)){memoryReasons.set(m.id,reason);changed=true;}
  }
  for(const c of state.chats){
   const full=[...(c.memoryIds??[]).map(id=>memoryReasons.get(id)),...[...(c.contextChatIds??[]),...(c.replyTo?[c.replyTo]:[])].map(id=>chatReasons.get(id))];
   const reasons=[...full.filter(r=>r?.forgotten),...(c.basis?.memoryIds??c.memoryIds??[]).map(id=>memoryReasons.get(id)),...(c.basis?.chatIds??[...(c.contextChatIds??[]),...(c.replyTo?[c.replyTo]:[])]).map(id=>chatReasons.get(id))].filter(Boolean);
   const reason=reasons.find(r=>r!.forgotten)??reasons[0],previous=chatReasons.get(c.id);
   if(reason&&(!previous||reason.forgotten&&!previous.forgotten)){chatReasons.set(c.id,reason);changed=true;}
  }
 }
 for(const m of state.memories){const reason=memoryReasons.get(m.id);if(reason){m.invalidatedBy??=reason.id;m.forgotten ||= reason.forgotten;}}
 for(const c of state.chats){const reason=chatReasons.get(c.id);if(reason){c.outdatedBy??=reason.id;c.excluded ||= reason.forgotten;}}
}

export function forgetHabit(state:State,habitId:string):void{
 const habit=(state.habits??[]).find(h=>h.id===habitId&&h.partnerId===state.partnerId);
 if(!habit)throw new Error('未找到这条相处习惯');
 // Retired earlier values do not become defaults again after forgetting a newer value.
 for(const h of state.habits??[])if(h.partnerId===habit.partnerId&&h.key===habit.key)h.forgotten=true;
 reconcileHabits(state);
}
