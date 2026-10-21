/** 固定执行器的可视化映射，不是第二套 DAG 引擎。边表示调用/数据流，不调度代码。 */
export interface WorkflowGraphNode {
  id: string;
  title: string;
  kind: "agent" | "knowledge" | "code" | "model" | "state" | "human";
  phase: "before" | "executor" | "after";
  summary: string;
  detail: string;
  x: number;
  y: number;
  source?: { path: string; symbol?: string };
}
export interface WorkflowGraphEdge {
  from: string;
  to: string;
  label?: string;
  kind?: "knowledge" | "loop" | "blocked";
}
export interface WorkflowGraphSetting {
  key: string;
  node: string;
  label: string;
  description: string;
  default: number;
  min: number;
  max: number;
}
export interface WorkflowGraphDefinition {
  executor: string;
  version: 1;
  title: string;
  description: string;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  settings: WorkflowGraphSetting[];
  widePositions?: Record<string, { x: number; y: number }>;
}

const code = (file: string, symbol?: string) => ({ path: `src/core/workflows/${file}.ts`, symbol });
const comicSource = code("comicGeneration", "createComicGenerationWorkflowExecutor");
const imageSource = code("novelAiImageSet", "createNovelAiImageSetWorkflowExecutor");
const memorySource = code("memoryIngestion", "createMemoryIngestionWorkflowExecutor");
const pricingSource = code("pricingRefresh", "createPricingRefreshWorkflowExecutor");
const node = (id: string, title: string, kind: WorkflowGraphNode["kind"], phase: WorkflowGraphNode["phase"],
  x: number, y: number, summary: string, detail: string, source?: WorkflowGraphNode["source"]): WorkflowGraphNode =>
  ({ id, title, kind, phase, x, y, summary, detail, source });
const skillNode = node("skill", "NovelAI 知识资料", "knowledge", "before", 40, 248,
  "入口 + prompting + 模板索引", "read_skill 读取入口，附带 prompting 基础规则和薄索引；LLM 再按使用场景选读模板正文。读取资料不会启动另一个模型。",
  { path: "workflows/novelai-generation/references/illustration.md" });
const browserNode = node("browser", "Browser Controller", "agent", "executor", 940, 64,
  "操作浏览器 · 一次提交", "Controller 是 LLM Agent，通过受控浏览器工具填写已冻结的表单。它不重新编写角色或剧本；未知提交结果先核对，不能盲目重试。",
  { path: "agents/browser_controller/CLAUDE.md" });
const modelNode = node("image-model", "NovelAI 图像模型", "model", "executor", 1240, 64,
  "实际生成像素 · 消耗 Anlas", "网页图像服务实际生成图片。这是外部图像模型，不是 Workflow 脚本，也不是 comic_generator 本身。",
  code("novelAiBrowserExecution", "runNovelAiBrowserTask"));

export const WORKFLOW_GRAPHS: Record<string, WorkflowGraphDefinition> = {
  "jizura-video": {
    executor: "jizura-video", version: 1, title: "JIZURA 动态文字视频", description: "Astra 6 做创意，本地原生引擎做视频，真实成片抽帧后交付。",
    nodes: [
      node("main", "Main 交接", "agent", "before", 40, 64, "原始文案与要求", "两 Main 只交需求；不改自己的默认模型，不写渲染脚本。"),
      node("designer", "Astra 6 设计师", "agent", "executor", 330, 64, "固定 Codex · 语义排版", "内部 jizura_designer 固定 gpt-6-astra；不可用时停止，不自动换模型。", { path: "agents/jizura_designer/CLAUDE.md" }),
      node("skill", "JIZURA Skill", "knowledge", "before", 330, 260, "创作方法与原生参数", "渐进读取知识，不维护另一份渲染器。", { path: "skills/jizura/SKILL.md" }),
      node("render", "原生预览与编码", "code", "executor", 640, 64, "J.plan / J.Renderer / J.exportMP4", "固定离线接口；无 Shell、无用户浏览器，幂等目录保存原稿。", { path: "skills/jizura/scripts/workflow.mjs" }),
      node("review", "成片核验", "code", "executor", 950, 64, "完整解码 + Astra 看抽帧", "校验 H264、尺寸、时长、哈希；设计师查看实际解码帧，说明视觉检查范围。", code("jizuraVideo", "createJizuraVideoWorkflowExecutor")),
      node("delivery", "交付与续做", "state", "after", 1250, 64, "MP4 · 项目 · taskRef", "完成只凭固定回执；原任务恢复、旧作品不覆盖。"),
    ],
    edges: [{ from: "main", to: "designer" }, { from: "skill", to: "designer", kind: "knowledge" },
      { from: "designer", to: "render" }, { from: "render", to: "review" }, { from: "review", to: "designer", kind: "loop", label: "具体问题才修订" }, { from: "review", to: "delivery" }], settings: [],
  },
  "comic-generation": {
    executor: "comic-generation", version: 1, title: "漫画生成", description: "导演负责创作，代码负责把每一幕可靠地交付。",
    nodes: [
      node("director", "漫画导演", "agent", "before", 40, 64, "故事 → 分镜 → 英文 generation",
        "comic_generator 在调用 Workflow 之前写故事、视觉圣经、全量分镜，并按 Skill 经验填写每格 generation。Workflow 不会替它翻译剧本或补回遗漏细节。",
        { path: "agents/comic_generator/CLAUDE.md" }),
      skillNode,
      node("compile", "预检与 Prompt 编译", "code", "executor", 340, 64, "角色 / 字段 / 总预算校验",
        "校验完整分镜，调用确定性 Prompt 编译器注入角色锚点、展开结构化字段、去重，得到每格独立冻结表单。没有另一个提示词 LLM。", code("comicGeneration", "compilePanel")),
      node("job", "保存漫画 Job", "state", "executor", 640, 64, "剧本、表单、预算、进度落盘",
        "使用可信来源和 workflowKey 去重。工作稿与 Job 保留全量计划，恢复时读取已冻结决定，不临时重写女主或已完成分镜。", { path: "src/core/comics/comicJobStore.ts", symbol: "async create" }),
      node("batch", "逐格循环", "code", "executor", 640, 248, "每批领取 1–3 格 · 串行执行",
        "batchSize 是领取批次，不是把多格拼成同一张图，也不是需要用户每批说继续。一个 Workflow 调用会继续领取后续批次；每格单独 Generate。", code("comicGeneration", "async function runRemaining")),
      browserNode, modelNode,
      node("verify", "验签与进度落盘", "code", "executor", 1240, 248, "原图尺寸 / SHA-256 / 回执",
        "机械验签、导入原图并记录扣费状态和产物。它不等于人物肖像或材质的语义验收；主观视觉质量仍需实际看图。", code("comicGeneration", "async function runRemaining")),
      node("blocked", "阻塞与断点", "state", "executor", 940, 432, "保留 jobId · 未知副作用先查询",
        "真实 blocked / needs_input 才停下。恢复沿用同一 Job 和已完成格；不因重新打开页面或编辑画布而自动开始生成。", comicSource),
      node("deliver", "逐幕交付", "code", "executor", 940, 248, "N 段标题 + 文字 + 单张原图",
        "每幕标题和文字紧跟本格原图，顺序由代码保留。合成长页仅作为本地归档，不替代逐幕交付。", code("comicGeneration", "async function complete")),
    ],
    edges: [{ from: "skill", to: "director", label: "按需读正文", kind: "knowledge" },
      { from: "director", to: "compile", label: "run_workflow" }, { from: "compile", to: "job" }, { from: "job", to: "batch" },
      { from: "batch", to: "browser" }, { from: "browser", to: "image-model" }, { from: "image-model", to: "verify" },
      { from: "verify", to: "batch", label: "还有待生成格", kind: "loop" }, { from: "verify", to: "deliver", label: "全部完成" },
      { from: "browser", to: "blocked", label: "阻塞 / 结果未知", kind: "blocked" }, { from: "blocked", to: "batch", label: "明确恢复", kind: "loop" }],
    settings: [{ key: "batchSize", node: "batch", label: "新任务默认领取格数", default: 3, min: 1, max: 3,
      description: "仅在新 job 未指定 batchSize 时采用；仍逐格串行执行。已有 Job 和恢复任务沿用冻结值，不增加调用次数或重放已完成格。" }],
  },
  "novelai-image-set": {
    executor: "novelai-image-set", version: 1, title: "独立图片集", description: "同构图变体与独立构图分开执行，不误进漫画流程。",
    nodes: [node("main", "Main 准备画面", "agent", "before", 40, 64, "判断变体或独立插画 · 填结构化字段",
      "Main 按 Skill 识别无剧情连续性的多图，准备 variants 或 independent 输入。连续分镜交给漫画导演，不按图片数量一刀切。", { path: "workflows/novelai-generation/references/image-execution.md" }),
      skillNode, node("compile", "分流与编译", "code", "executor", 340, 64, "同构图分批 / 独立构图逐张",
        "variants 每批最多 4 张共享同一 Prompt；independent 每个 item 独立编译并单张生成。代码同时校验总张数、身份和预算。", code("novelAiImageSet", "async function compileImageSet")),
      node("job", "冻结图片集", "state", "executor", 640, 64, "各 bundle / 总预算 / onceKey",
        "data/novelAiImageSets 保存冻结组、来源与扣费状态。已知结果按记录交付，未知副作用不能从头重跑。", imageSource),
      browserNode, modelNode,
      node("verify", "验签并保存", "code", "executor", 1240, 248, "导入原图 · 持久化结果",
        "检查下载产物、发布统一上传 URL、记录成本；图片是否符合画面要求仍需视觉检查。", code("novelAiImageSet", "async function runRemaining")),
      node("deliver", "逐张交付", "code", "executor", 940, 248, "每张标题、文字和原图",
        "完成时返回按组顺序排列的交付正文，独立图片不会被拼成一页漫画。", imageSource),
      node("blocked", "等待核对 / 恢复", "state", "executor", 640, 248, "保留图片集 ID 和已完成结果",
        "停止、断线或计费未知时保留状态。resume 查询同一任务，不偷偷切换构图或重新扣费。", imageSource)],
    edges: [{ from: "skill", to: "main", kind: "knowledge" }, { from: "main", to: "compile", label: "run_workflow" },
      { from: "compile", to: "job" }, { from: "job", to: "browser" }, { from: "browser", to: "image-model" }, { from: "image-model", to: "verify" },
      { from: "verify", to: "browser", label: "下一组", kind: "loop" }, { from: "verify", to: "deliver", label: "全部完成" },
      { from: "browser", to: "blocked", kind: "blocked" }], settings: [],
  },
  "memory-ingestion": {
    executor: "memory-ingestion", version: 1, title: "记忆摄入", description: "语义判断留给 Agent，去重与审批边界由代码维护。",
    nodes: [node("keeper", "Memory Keeper", "agent", "before", 40, 100, "判断价值、归类与语义冲突",
      "Agent 按记忆索引阅读相关页面，整理候选内容。代码的精确去重不冒充语义冲突判断。", { path: "agents/memory-keeper/CLAUDE.md" }),
      node("validate", "全批预检", "code", "executor", 340, 100, "路径 / 权限 / 大小 / 重复路径",
        "先校验全部候选，再创建任何提案，避免错误参数造成半批提交。", memorySource),
      node("dedupe", "精确去重", "code", "executor", 640, 100, "内容 hash + 原文件版本",
        "已包含的相同内容跳过；等价待审批提案复用；不同待审批内容标记冲突，不直接覆盖。", memorySource),
      node("proposals", "保存 Proposal", "state", "executor", 940, 100, "候选改动落盘 · 不直接写记忆",
        "串行建立提案，保留 beforeHash、修改原因和来源，用于审计与版本冲突检查。", memorySource),
      node("review", "主人审批", "human", "after", 1240, 100, "Governance 查看 / 批准 / 应用",
        "Workflow 停在 awaiting_approval。用户 在 Governance 决定是否应用，Workflow 不会自动批准或修改记忆。", { path: "src/governance/proposalStore.ts", symbol: "export async function applyProposal" })],
    edges: [{ from: "keeper", to: "validate", label: "run_workflow" }, { from: "validate", to: "dedupe" }, { from: "dedupe", to: "proposals" },
      { from: "proposals", to: "review", label: "等待审批" }], settings: [],
  },
  "pricing-refresh": {
    executor: "pricing-refresh", version: 1, title: "模型目录与计价刷新", description: "定时任务与手动刷新共用纯代码流程，全程不调用 LLM。",
    nodes: [node("trigger", "Cron / 手动刷新", "code", "before", 40, 100, "同一执行器 · 合并并发刷新",
      "定时刷新和 Settings 手动刷新进入同一执行器。并发触发共用正在运行的 Promise，不重复覆盖目录。定时时间在 Cron 编辑。", pricingSource),
      node("catalog", "刷新 API 模型目录", "code", "executor", 340, 100, "HTTP 获取 → 保存槽位 → 热更新",
        "从配置的官方 Provider 端点读取目录；失败保留旧目录。密钥不进入图定义或前端。", pricingSource),
      node("oauth", "刷新运行时模型目录", "code", "executor", 640, 100, "包括 Codex OAuth 目录",
        "运行时目录独立刷新，结果不会被错误写回 API 槽文件；失败有结构化警告。", pricingSource),
      node("pricing", "刷新计价表", "code", "executor", 940, 100, "HTTP / 解析 / 合并 · 保留锁定价",
        "更新新用量的报价；手动锁定价不覆盖，历史成本账本不追溯重算。", pricingSource),
      node("report", "保存刷新结果", "state", "executor", 1240, 100, "成功 / 警告 / 沿用旧数据",
        "汇总新增模型、失败目录与计价来源警告。此图只解释流程，打开画布或保存备注不会触发刷新。", pricingSource)],
    edges: [{ from: "trigger", to: "catalog" }, { from: "catalog", to: "oauth" }, { from: "oauth", to: "pricing" }, { from: "pricing", to: "report" }], settings: [],
  },
};

// One public Workflow: both authors and all knowledge are internal nodes.
WORKFLOW_GRAPHS["novelai-generation"] = {
  executor: "novelai-generation", version: 1, title: "NovelAI · 创作与生成",
  description: "普通插画与漫画各自创作，共用一份资料和一条生成链；Main 只转交原始要求。",
  nodes: [
    node("request", "Main 交入原始要求", "agent", "before", 340, 40, "原话 / 预算 / 附件 · 不写 Prompt",
      "选择 image 或 comic 分支，不增加分类模型。工作流内完成模板读取、画面构思和分镜。", code("novelAiGeneration")),
    node("artist", "普通插画创作", "agent", "executor", 40, 226, "原 novelai-art 逻辑 · LLM",
      "归一化单图、变体或独立多图，按共享索引读取模板、处理角色和参考图，写画面字段。不额外编剧或调用漫画导演。", { path: "agents/novelai_artist/CLAUDE.md" }),
    node("director", "漫画导演创作", "agent", "executor", 640, 226, "原 comic_generator · LLM",
      "写故事、视觉圣经、全量分镜和每格画面字段；该节点在 Workflow 内部，不由 Main 提前编剧。", { path: "agents/comic_generator/CLAUDE.md" }),
    node("skill", "共用创作资料", "knowledge", "executor", 340, 226, "index / prompting / 模板 / 角色库",
      "原 Skill 资料整体迁入本 Workflow。两个创作分支共用同一索引与模板；按需读取，无第二份词库。", { path: "workflows/novelai-generation/references/index.json" }),
    node("compile", "当前稿件 → 编译冻结", "code", "executor", 340, 412, "分块落盘 / 版本校验 → 唯一编译器",
      "作者 save_draft/submit_draft；代码绑定任务、稿件版本和 Job，不让模型复制 ID。角色锚点、材质展开、冲突校验和去重沿用原编译器。只要 Prompt 到此返回，不生成。", code("novelAiGenerationUnit", "compileNovelAiGeneration")),
    node("job", "保存计划与进度", "state", "executor", 640, 412, "图片组 / 全量漫画 · 预算 / onceKey",
      "普通图保存图片组，漫画保存剧本与全量分镜；旧 Job 仍沿用原目录与冻结内容，恢复不重新创作。", code("novelAiGeneration")),
    node("budget", "自动估价与额度", "code", "executor", 940, 412, "按张授权 · 网页实价双重限额",
      "未指定预算时按画布的单张额度授权，总额为单张额度×张数；未知估价也可在此额度内核对网页实价。显式预算优先，单次上限与总账本分别限制；旧 Job 不追溯扩额。", code("novelAiBudget", "planNovelAiBudget")),
    node("review", "可选方案确认", "human", "executor", 940, 598, "仅主动要求审核或额度异常时暂停",
      "先保存完整方案，再返回 Job、预览和确认参数。approve + expectedRevision 只确认看过的版本；继续从原 Job 进入循环，不重新启动导演。", code("novelAiBudget", "approveWaiting")),
    node("batch", "按计划循环", "code", "executor", 640, 598, "变体批量 · 独立图 / 漫画逐张",
      "漫画每格一次 Generate，变体每批最多 4 张，独立构图逐张；只执行写好的计划，不在这里新建创作 Agent。", code("comicGeneration", "async function runRemaining")),
    { ...browserNode, x: 340, y: 598, title: "浏览器执行", summary: "代码填表 / 单次提交 / 原图回收；BC 处理页面判断",
      detail: "prepare_novelai_form 直接读取冻结表单，宽高明确并回读确认；可选参考图由 BC 上传。execute_novelai 串联价格/尺寸复核、Generate 和 collect。已提交重入只回收，不重新生成。" },
    { ...modelNode, x: 40, y: 598 },
    node("verify", "持久回执 → 导入", "code", "executor", 40, 784, "同一生成链 · 先保存原图回执",
      "图片与漫画共用 runNovelAiGenerationUnit。原图已回收、导入失败只重试导入；提交结果未知则停住核对，不能再次扣费。机械验签不冒充视觉验收。", code("novelAiGenerationUnit", "runNovelAiGenerationUnit")),
    node("deliver", "逐图交付", "code", "executor", 340, 784, "N 个标题＋文字＋N 张图片",
      "保留每张独立原图及其正文，按顺序交付；漫画长页仅归档，不替代单格。", code("novelAiGeneration")),
    node("blocked", "阻塞 / 断点恢复", "state", "executor", 640, 784, "jobId / taskRef · 不重写已冻结方案",
      "有 Job 直接恢复；创作中断续原内部节点与稿件。准备状态/只要 Prompt 不会偷偷生成图片。", code("novelAiGeneration")),
  ],
  edges: [
    { from: "request", to: "artist", label: "image" }, { from: "request", to: "director", label: "comic" },
    { from: "skill", to: "artist", kind: "knowledge" }, { from: "skill", to: "director", kind: "knowledge" },
    { from: "artist", to: "compile" }, { from: "director", to: "compile" },
    { from: "compile", to: "deliver", label: "只要 Prompt" }, { from: "compile", to: "budget", label: "生成" },
    { from: "budget", to: "job" }, { from: "job", to: "review", label: "需确认", kind: "blocked" },
    { from: "review", to: "batch", label: "确认同版本", kind: "loop" },
    { from: "job", to: "batch", label: "正常自动放行" }, { from: "batch", to: "browser" }, { from: "browser", to: "image-model" },
    { from: "image-model", to: "verify" }, { from: "verify", to: "batch", label: "下一张/组", kind: "loop" },
    { from: "verify", to: "deliver", label: "完成" }, { from: "browser", to: "blocked", kind: "blocked" },
    { from: "verify", to: "blocked", label: "只恢复导入", kind: "blocked" },
    { from: "blocked", to: "batch", label: "查明状态后续跑", kind: "loop" },
  ],
  settings: [...WORKFLOW_GRAPHS["comic-generation"]!.settings,
    { key: "maxAnlasPerImage", node: "budget", label: "默认单张上限 (Anlas)", default: 50, min: 0, max: 10000,
      description: "未指定预算的新任务在单张额度内直接生成，总额按实际计划张数计算；0 仅允许免费。不是报价，不扩大已保存 Job 的授权。" },
    { key: "anlasTolerancePercent", node: "budget", label: "自动预算容差 (%)", default: 20, min: 0, max: 100,
      description: "显式指定总预算时，用于已知估价的单次价格容差；不叠加到默认单张额度。已保存 Job 不随设置改变，不是官方报价。" }],
};

// 三列折返布局让常见桌面窗口能看清文字；节点顺序/连线仍由上面的映射定义。
const layouts: Record<string, Record<string, [number, number]>> = {
  "comic-generation": { director: [40, 56], skill: [40, 242], compile: [340, 56], job: [640, 56],
    batch: [640, 242], browser: [340, 242], "image-model": [40, 428], verify: [340, 428], deliver: [640, 428], blocked: [640, 614] },
  "novelai-image-set": { main: [40, 56], skill: [40, 242], compile: [340, 56], job: [640, 56],
    browser: [640, 242], "image-model": [340, 242], verify: [340, 428], deliver: [40, 428], blocked: [640, 428] },
  "memory-ingestion": { keeper: [40, 80], validate: [340, 80], dedupe: [640, 80], proposals: [640, 300], review: [340, 300] },
  "pricing-refresh": { trigger: [40, 80], catalog: [340, 80], oauth: [640, 80], pricing: [640, 300], report: [340, 300] },
};

for (const [name, positions] of Object.entries(layouts)) {
  WORKFLOW_GRAPHS[name]!.nodes = WORKFLOW_GRAPHS[name]!.nodes.map(item => ({ ...item,
    x: positions[item.id]![0], y: positions[item.id]![1] }));
}
const wideLayouts: Record<string, Record<string, [number, number]>> = {
  "novelai-generation": { request: [40, 56], artist: [340, 56], director: [340, 242], skill: [40, 242],
    compile: [640, 56], budget: [940, 56], job: [1240, 56], review: [1240, 242], batch: [940, 242], browser: [640, 242], "image-model": [640, 428],
    verify: [940, 428], deliver: [1240, 428], blocked: [940, 614] },
  "comic-generation": { director: [40, 56], compile: [340, 56], job: [640, 56], batch: [940, 56], browser: [1240, 56],
    skill: [40, 256], blocked: [340, 256], deliver: [640, 256], verify: [940, 256], "image-model": [1240, 256] },
  "novelai-image-set": { main: [40, 56], compile: [340, 56], job: [640, 56], browser: [940, 56], "image-model": [1240, 56],
    skill: [40, 256], blocked: [640, 256], deliver: [940, 256], verify: [1240, 256] },
};

for (const [name, positions] of Object.entries(wideLayouts)) {
  WORKFLOW_GRAPHS[name]!.widePositions = Object.fromEntries(Object.entries(positions).map(([id, [x, y]]) => [id, { x, y }]));
}
