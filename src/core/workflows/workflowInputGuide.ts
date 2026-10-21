/** Delivery is role-specific; the draft/execution protocols themselves are unchanged. */
const DRAFT_BOUNDARY = `
每块仍限 8KiB，整稿 128KiB / 64 快照；必须是合法 JSON，不把对象编码成字符串。保存不等于校验通过、获授权或已生成。
不并发写同一稿件；使用最新 draftRevision。版本冲突或回执丢失先 inspect_draft，不重置稿件、不盲重发。
已有 Job 用 status/resume input:{}，改冻结计划用本分支 revise 动作；不另造任务键，预算、权限、幂等和未知提交核对不变。
旧稿或需要通用分块协议时另读 input-staging-legacy；不要为了缩小 JSON 删除创作细节。

V4.5 超限按回执 inspect_prompt→revise_prompt 精简到512/512，required不锁措辞；原Job空闲时也可提前精简未执行unit，用最新expectedRevision，改好再resume，不必先撞网页超限。V5不变。
`;

const COMIC_DRAFT_GUIDE = `# 漫画写稿：导演冻结分镜，单图画师写画面

任务、格号和引用由程序管理；新稿字段读 comic-storyboard-schema，旧稿读 comic-draft-schema。
1. begin_storyboard input:{panelCount:格数,content:全书设定,reviewBeforeGenerate?:true}。content 为 title/premise/bible 等 book 字段，不含 panels/workflowKey。
2. save_scene input:{draftRevision:返回版本,content:本格故事/镜头/连续性}。characters 必填，不写 generation/novelAiRequest。自动选择下一空格，成功回执含 savedPanel/nextPanel；失败不保存、不推进版本，只修该格。
3. inspect_draft input:{} 查询；input:{panelNumber:2} 读单格，{section:"book"} 读设定。恢复续 nextPanel，不重新初始化。
4. 定向修改用 save_scene input:{draftRevision,panelNumber,content}；全书用 save_book input:{draftRevision,content}。这些修改使未生成画稿失效，旧快照保留。
5. 全格齐全后 submit_draft input:{draftRevision}：自动逐格调用单图画师，只补 generation，每格校验并保存，全部通过才进入原预算/审核/生成。artPreparedPanels 仅表示画稿。中断续原任务只补缺稿；画师停住交回 Main，不在同轮反复提交。

大于8KiB的格用 stage_panel input:{draftRevision,field:["visualDescription"],value:"内容"} 暂存字段，再 save_scene input:{draftRevision} 完整校验；section:"staged" 查看，discard_panel 丢弃暂存。不能写 generation。
旧 comic-panels-v1 继续 begin_draft/save_panel（包含 generation），不转新格式；其它旧稿读 input-staging-legacy。已有 Job 直接 status/resume，不重新写稿。
`;

function currentDraftGuide(kind: "image" | "comic"): string {
  const root = kind === "image" ? "set" : "job";
  const item = kind === "image" ? "items" : "panels";
  return `# ${kind === "image" ? "普通图片" : "旧式漫画"}：保存当前稿件

可信子任务已绑定作者、会话和设备，不填写 kind、workflowKey、inputRef 或 jobId。计划根为 ${root}，字段按本分支执行契约。
1. 首块 save_draft input:{value:计划对象}；先保存父对象和 ${root}.${item} 数组，再补条目。intent / reviewBeforeGenerate 等计划字段保留在根，不塞进 ${root}。
2. 按 JSON Pointer 补写：save_draft input:{draftRevision:返回的版本,path:"/${root}/${item}/0",value:完整条目}；下一条为 /${root}/${item}/1。未指定字段不变；条目过大时先存骨架，再补子字段，不能跳号。
路径中的 ~ 和 / 用 ~0 / ~1 编码，父层必须先存在；不使用原型属性。
3. inspect_draft input:{} 查当前稿件，input:{path:"/${root}/${item}/0"} 查单项；程序管理底层引用。
4. 全部齐全后 submit_draft input:{draftRevision:最新版本}；代码校验完整计划并绑定原任务进入执行。输入校验失败只补出错字段再提交。
${DRAFT_BOUNDARY}`;
}

/** Compatibility remains available on demand, and is the default for other workflows. */
function legacyInputGuide(kind?: "image" | "comic"): string {
  const root = kind === "image" ? "set" : "job";
  const item = kind === "image" ? "items" : "panels";
  return `# 通用分块协议：不可变输入引用

这是 run_workflow 的参数传输协议，不改变具体 Workflow 的输入字段。长计划先分块准备，再执行最后的引用。
下方 ${root}/${item} 只示意传输方式，完整计划字段仍以目标 Workflow 契约为准。

1. 首块：run_workflow({name,action:"prepare_input",input:{value:{${root}:{title:"示例",${item}:[]}}}})
2. 收到 inputRef 后，每块使用上次返回的引用：
   run_workflow({name,action:"prepare_input",input:{baseRef:inputRef,path:"/${root}/${item}/0",value:一个完整条目对象}})
   下一个条目用 /${root}/${item}/1；其它字段同样按 JSON Pointer 设置。
3. 全部字段准备好后：run_workflow({name,action:"start",inputRef:最后返回的引用})。
   不同时传 input。其它执行动作也可使用 inputRef。novelai-generation 内部创作节点提交用 execute，根对象保留 kind，不用 start 再次启动创作。

prepare_input 只保存数据，不创建业务任务、不操作网页、不扣费；input_prepared 不代表已执行或通过业务校验。
每块 input 最多 8KB UTF-8 JSON，完整输入最多 128KB；每个作用域最多 64 个快照。
若单个条目仍太大，先放骨架，再按子字段补齐。父对象/数组须先存在；数组只可替换现有索引或追加紧邻下一项，不可跳号。
每块都必须是正常 JSON；不要输出代码围栏、伪 JSON 或把对象再次编码成字符串。
空 path 代表根对象。路径里的 ~ 和 / 分别编码为 ~0 和 ~1；禁止原型属性。
引用是不可变快照：改一块得到新引用，不改变旧稿；程序不会自动合并并发分支。
仅失败在参数解析/校验且未执行时修正该块，沿用最后成功的 baseRef。不要重发整本计划或重启付费流程。
引用绑定当前 Agent、Workflow、设备和派发范围；checkpoint 内已保存的准备步骤可重建，不能跨会话借用。
可信会话的固定子任务另有 taskRef：prepare_input 返回 durable:true 才表示已同步落盘，等待预算/结束本轮不删除。
Main 按任务薄索引标注的入口续接（Workflow 内部节点用 run_workflow resume + resumeRef；普通子任务用 spawn_subagent resumeRef），子 Agent 可跨新派发取回同一任务的 inputRef；不能使用其它会话或任务的引用。
恢复先 run_workflow({name,action:"list_inputs",input:{}}) 读取已保存引用和执行状态；
再 run_workflow({name,action:"inspect_input",input:{inputRef,path:"/${root}"}}) 按 JSON Pointer 检查内容，超过8KB只给结构索引，继续读子字段。
未得到 durable 回执时不得声称完整稿件已保存/冻结；纯文字最终回复不是结构化计划。保存草稿不增加预算或执行授权。
输入准备完成后，原 executor 仍执行完整字段、预算、权限与幂等检查，不会因使用引用而跳过。
已有 jobId 时按具体契约 status/resume/局部修订，不因参数错误重新 start 已执行任务。
`;
}

export function workflowInputGuide(workflow: string, agent: string, bound: boolean, legacy = false): string {
  if (workflow !== "novelai-generation") return legacyInputGuide(workflow === "novelai-image-set" ? "image" : undefined);
  if (agent.startsWith("main-")) return "Main 只用 start 交原始要求、resume 续原 taskRef/Job；内部作者负责写稿。无需准备 inputRef 或读取创作字段。";
  const kind = agent === "comic_generator" ? "comic" : "image";
  if (!["novelai_artist", "comic_generator"].includes(agent)) return legacyInputGuide();
  if (!bound) return legacyInputGuide(kind);
  if (legacy) return `已有当前稿指针用 save_draft；只有旧 inputRef 的稿件使用后半部 prepare_input。先查询现有稿件，不混用两种引用或重置已保存计划。\n\n${currentDraftGuide(kind)}\n${legacyInputGuide(kind)}`;
  return kind === "comic" ? `${COMIC_DRAFT_GUIDE}\n${DRAFT_BOUNDARY}` : currentDraftGuide(kind);
}
