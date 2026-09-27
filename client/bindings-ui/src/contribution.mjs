import {z} from 'zod';
// Public Typert client requires strict input codecs. Host validates independently.
const id=z.string().min(1).max(512).regex(/^[^\u0000-\u001f]+$/);
const revision=z.string().regex(/^[a-f0-9]{64}$/);
const schemas={
  chats:z.object({offset:z.number().int().min(0).max(100000).optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),
  bind:z.object({chatGuid:id,sessionId:id,relay:z.boolean(),expectedRevision:revision}).strict(),
  unbind:z.object({chatGuid:id,expectedRevision:revision}).strict(),
  updateRelay:z.object({chatGuid:id,relay:z.boolean(),expectedRevision:revision}).strict(),
};
export const contribution={
  package:'dsh-bluebubbles',
  descriptors:['list','chats','sessions','bind','unbind','updateRelay'].map(method=>({
    id:`dsh-bluebubbles#bluebubblesBindings/${method}`,
    service:'bluebubblesBindings',namespace:'bluebubblesBindings',method,
    invocation:{kind:'direct'},
    parameters:['list','sessions'].includes(method)?[]:[{name:'args',wire:'args',source:'json',codec:{mode:'strict',typeSymbol:`dsh-bluebubbles#${method}Request`,create:()=>schemas[method]}}],
    result:{mode:'src-json',typeSymbol:'dsh-bluebubbles#BindingsResult'},
  })),
};
