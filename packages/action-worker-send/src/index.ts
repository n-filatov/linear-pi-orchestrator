import Handlebars from "handlebars";
import { z } from "zod";
import type { ActionContext, ActionPlugin } from "@task-relay/plugin-sdk";
const ref=z.union([z.object({action:z.string().min(1)}).strict(),z.object({workerId:z.string().min(1)}).strict(),z.object({sourceItem:z.literal("current"),runs:z.enum(["latest","active","all"]).default("latest")}).strict()]).default({sourceItem:"current",runs:"latest"});
export const workerSendConfigSchema=z.object({worker:ref,text:z.string().min(1),submit:z.boolean().default(true),child:z.string().min(1).optional()}).strict(); export type WorkerSendActionConfig=z.infer<typeof workerSendConfigSchema>;
const render=(c:ActionContext,v:string)=>c.inputsResolved ? v : Handlebars.compile(v,{noEscape:true})({item:c.item,worker:c.worker,run:c.run,actions:c.outputs,repository:c.repository});
export function createWorkerSendAction():ActionPlugin<WorkerSendActionConfig>{return {kind:"action",use:"worker-send",target:"worker",configSchema:workerSendConfigSchema,presentation:{name:"Run command in terminal",description:"Send a command or text to the current pane of a selected live terminal worker.",category:"Workers",icon:"send",color:"#0891b2"},execute(c,x){return c.workers.send(x.worker,{text:render(c,x.text),submit:x.submit,child:x.child?render(c,x.child):undefined});}};

}
