import type {AgentTool} from './agent-port.ts';
import type {ParagraphCommentQuery,ParagraphCommentResult,ParagraphCommentView} from './paragraph-comments.ts';

type ParagraphRecallHost={
  assertCurrent:()=>void;
  list:(query:ParagraphCommentQuery)=>Promise<ParagraphCommentResult>;
  onRead:(items:readonly ParagraphCommentView[])=>void;
};

/** The paragraph index owns permission and paging; the host records actual reads. */
export function paragraphRecallTool(host:ParagraphRecallHost):AgentTool{
  return{
    name:'recall_paragraph_comments',
    description:'按原文范围分页回查实际发表的段评与回复，包含用户和伙伴。role=user是用户原话，role=assistant是伙伴原话；replyTo/paragraphCommentId保留回复或引用关系，anchor是原文锚点。ranges省略时按原文顺序查，续页使用nextCursor作为cursor。普通聊天用recall_discussion。',
    parameters:{type:'object',properties:{cursor:{type:'string'},ranges:{type:'array',items:{type:'object',properties:{start:{type:'integer'},end:{type:'integer'}},required:['start','end'],additionalProperties:false}}},additionalProperties:false},
    execute:async(raw,signal)=>{
      host.assertCurrent();
      signal.throwIfAborted();
      const page=await host.list(raw as ParagraphCommentQuery);
      host.assertCurrent();
      signal.throwIfAborted();
      host.onRead(page.items);
      return{
        ...page,
        source:'原文旁实际发表的段评与回复',
        notice:'逐条按role区分真实作者：user为用户，assistant为伙伴。replyTo为回复目标，paragraphCommentId为引用的段评，关联编号只表示已保存关系；未取得目标正文时不能猜补。anchor保留原文字句、书籍版本与位置；formationRanges/formedThrough说明形成时的材料范围。发表、展示或点赞各自保留其实际含义，伙伴原话不证明用户看过或同意；段评内容不作小说原文事实证明。'
      };
    }
  };
}
