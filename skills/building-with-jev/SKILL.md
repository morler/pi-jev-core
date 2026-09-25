---
name: building-with-jev
description: "编写和改进调用 Jev 的程序：设计 TypeSafe 问题（Choice/Score/Noul）、组织 state、在代码里组合答案、设置置信度阈值、诊断答错或低置信度的问题。针对本项目 pi-jev-core 的 JevClient/jev_evaluate 工具改编（源自 dbreunig/building-with-jev-skill）。触发：要写或调 Jev 判定、jev_evaluate 参数设计、问题答错/置信度低要排查时。"
---

# 编写和改进 Jev 程序（pi-jev-core 版）

Jev 是判断模型：读一份 `state`，对请求里的每个问题独立并行作答，返回你定义好的答案空间上的概率分布。它不逐步推理、不生成文本。控制流、算术、策略都在代码里；Jev 只负责秒断。

好的 Jev 问题是一个知情者看对上下文后一秒能答的题。"这条消息有紧迫感吗"合适；"分析这条消息并决定怎么做"不合适——拆成小问题，在代码里组合。

模型层面指导适用于 `jev-1.13`；文档标记了多处"后续版本可能改进"，换模型时复查 jaggedness 页。

## 本项目接入（与上游 Python SDK 的差异）

本项目是 TypeScript pi 扩展包 pi-jev-core，两条调用路径：

1. **扩展工具**（pi 会话内直接调）：`extensions.jev_evaluate({ state, questions })`。
2. **库调用**（写探针/程序）：

```ts
import { JevClient, noulProbability } from "pi-jev-core";

const client = new JevClient();          // platform 与凭据从 env 解析
if (!client.isConfigured()) throw new Error("需要 TYPESAFE_BASE_URL / TYPESAFE_API_KEY");

const response = await client.evaluate({
  state: { ticket: ticketText },          // string 会被自动包成 { text }
  questions: {
    category: {
      type: "choice",
      instructions: "Which category fits the main request in `ticket`?",
      criteria: {
        bug_report: "Something is broken or producing errors",
        billing: "Charges, invoices, refunds, or subscriptions",
        other: "Anything else",
      },
    },
    // Speculative fan-out：只有 bug_report 分支用得上，也一并问
    severity: {
      type: "score",
      instructions: "How severe is the issue reported in `ticket`?",
      criteria: [                         // 数组 ≥2 级，索引即分数（从 0 起）
        "Cosmetic; no impact to functionality",
        "Broken or degraded feature; a workaround exists",
        "Blocking issue; no workaround exists",
      ],
    },
    refund_requested: {
      type: "noul",
      instructions: "Does `ticket` explicitly ask for a refund or credit?",
    },
  },
});

const a = response.answers;

// value/confidence 都是 optional：缺答案 ≠ 答案是 0。缺答案走退路，别伪造。
if (!a.category || a.category.value === undefined || (a.category.confidence ?? 0) < 0.6) {
  routeToHuman(ticketId);
} else if (a.category.value === "bug_report") {
  const sev = a.severity;
  if (!sev || sev.value === undefined || (sev.confidence ?? 0) < 0.5) addToBacklog(ticketId);
  else if (sev.value / 2 > 0.75) escalate(ticketId);   // / (criteria.length - 1)
  else addToBacklog(ticketId);
} else if (a.category.value === "billing" && a.refund_requested) {
  // noul 要区分"没答"与"答了 0"：读 noulProbability(raw)，返回 number | null
  const p = noulProbability(a.refund_requested.raw);
  if (p !== null && p > 0.7) routeToBilling(ticketId);
}
```

与上游 `typesafe_sdk`（Python）的对应关系：

| 上游 | 本项目 |
| --- | --- |
| `TypeSafeClient()` + `client.system_one(...)` | `new JevClient()` + `client.evaluate({ state, questions })` |
| `Choice(instructions, criteria={})` | `{ type: "choice", instructions, criteria }`，criteria 为 label→描述的 map |
| `Score(instructions, criteria=[...])` | `{ type: "score", instructions, criteria: string[] }`，至少两级 |
| `Noul(instructions)` | `{ type: "noul", instructions }` |
| `answers["x"].choice / .score / .noul` | 统一读 `answers["x"].value`（choice 为选项名，score/noul 为数字） |
| `.probabilities` | `.distribution`（choice/score） |
| `.confidence` | `.confidence`——choice/score 有；**noul 没有**，其距 0.5 的距离替代它 |

本项目两个硬约束（上游能力，此包装暂未透出）：

- `instructions` 只接受**字符串**。上游的 `question`/`focus`/`inspect`/`compare` 对象形式不可用：把焦点、检查点以短句内联进 instructions（先主问句，再一句 focus）。需要对象形式时扩展 `src/types.ts` 的 `instructions` 类型并在 `src/jev.ts` 透传给 `choice()`/`score()`。
- Noul 的 `true`/`false` 两侧 criteria 不透传（`noul(instructions)` 只传问题）。边界微妙时把两侧描述压缩进 instructions："Answer yes only if X; a request to change or reset it is not yes."

其他本项目事实：

- noul 的 `value` 缺答案时会回落成 0，与"真答了 0"无法区分；要区分时读 `noulProbability(raw)`（`pi-jev-core` 导出），返回 `number | null`。
- 平台由 env 决定（`resolvePlatform()`）：TypeSafe 云端用 `TYPESAFE_BASE_URL`/`TYPESAFE_API_KEY`；本地 llama-server 走 jevk5（`callJevK5`）。`client.platform` 固定于进程生命周期。
- `state` 传 string 会自动包成 `{ text }`；传对象可按路径引用字段（见下文"Build the state"）。
- 验证新端点：写 bun/tsx 探针，从 `src/jev.ts` 导入 `JevClient` 发三类问题、断言 `.value` 归一化；`test/core.test.ts` 有现成调用样例。

## Workflow

1. 列出代码要做的每个决策，写成 branch、threshold 或 ranking。
2. 每个判断一个问题；一个问题称量两个属性就拆开。
3. 选代码能直接行动的 primitive。
4. 构建能回答所有问题的最小 state；代码能算的都在代码里算。
5. 共享同一 state 的问题放进**一个请求**，包括只对部分输入有意义的问题。
6. 在代码里组合答案：branch、weight、confidence gate。
7. 用带标签的样本测试；错了读 `distribution`，一次只改一两个问题。

## Choose the primitive

| Primitive | 用它当 | 返回 | 代码这样用 |
| --- | --- | --- | --- |
| Choice | 答案是已知集合之一、无序 | `value`（选项名）、`distribution`、`confidence` | 每个选项一个分支 |
| Score | 答案是可分步描述的谱上的位置 | `value`、`distribution`、`confidence` | 阈值、排序、权重 |
| Noul | 答案是干净的 yes/no，概率即信号 | `value`（0–1） | 对阈值做 `if` |

- Choice 的列表可能盖不全输入时，加 `other` / `none of the above` 选项。
- Noul 0.5 = Jev 不确定，不是"中等"。量程度用 Score。
- Noul 要干净利落的条件。"这个候选人 Python 强吗"模糊；"简历是否写明候选人在工作中用过 Python"干净。
- 答案没有中间态时用 Choice 或几个 Noul。

## Write the instructions

- 写出精确条件。Jev 按你写的字面作答：范围词、否定、隐含条件都按字面读。
- 每个问题只问一个属性。隐藏的第二个判断拉低准确率和置信度。
- 用反引号路径点名要判断的 state 部分：`` `ticket.messages[0].text` ``。
- 直写。避免双重否定、属性的属性、需要跳几步的问题。
- 把代表级别的数字留在 instructions 外。"从 0 到 2 打分"给不了 Jev 任何可匹配的东西。
- 完整问题写在 `instructions` 里。问题 ID 不会到达模型。
- 决策策略别写进问题。"共享地址不能覆盖姓名冲突"属于代码。
- 答错后你向别人解释"我其实想问的是"——那句解释就是缺的半条 instructions，补进去。

（上游 instructions 支持对象/数组形态；本项目仅字符串，见"本项目接入"。）

## Write the criteria

Criteria 是 instructions 的延伸。两者必须问同一件事、指向同一方向。Noul 的 `true` 侧描述成"no"表现会更差（本项目：写进 instructions 同理）。

**Choice。** 每个选项配描述；选项贴近时描述要有对比性：

```json
"billing": {
  "what": "Charges, invoices, refunds, or subscriptions",
  "not_for": "Order tracking or account access",
  "examples": ["I was charged twice", "Where is my refund?"]
}
```

**Score。** 级别从低到高列，2–10 级，只列能区分描述的级别。

- 描述情境。"功能坏了，但有变通"可以；"中等严重"不行。
- 每级自足。Jev 独立评每一级，看不到它的编号和邻居；"比上一级更糟"对它无意义。
- 一个 Score 一个维度。"守时又聪明又有经验"在量三件事。
- 代码要区别对待的罕见极端，给它单独立一级。
- 级别可以是对象（上游）；本项目 criteria 是字符串数组，把 signals 压进同一句描述。

**Noul。** 本项目 criteria 不可用，边界微妙时把两侧描述写进 instructions："Answer yes only if X; Y is not yes."

**Examples。** 写短而具体的实例："I was charged twice"。不要写实例的描述："一条关于账单问题的消息"。

## Build the state

- 只发问题需要的字段。无关细节拉低准确率，大 state 还会掩盖是哪个输入导致答错。
- 先在代码里检索、过滤。代码滤不动时，每段问一个相关性 Noul，留下过关的。
- state 保持结构化，问题才能按路径指向它。
- 数字编码先转成词再发。发颜色名替代 hex；发算好的数或命名的桶替代原始数字。
- 日期顺序、时长、窗口、计数、求和在代码里算好，只发结果。
- 预算：state 和全部问题共享 64k tokens；state 加最长单个问题必须塞进 32k tokens。
- state 里的文本可能带偏答案。Jev 不把 state 当敌意内容。在 criteria 里写明什么算数，上线前测注入和自描述内容。

## Compose the answers in code

**Speculative fan-out.** 代码可能需要的每个问题都在一个请求里问掉，包括只在某些分支有用的。问题并行跑，多问几乎不加延迟和 token，代码忽略用不上的答案。

**Second requests.** 只有当代码不拿到第一个答案就构建不出第二个请求时才发第二次（比如答案决定取什么数据）。同一请求里的问题互相看不见。

**Confidence-gated routing.** 答案说"做什么"，置信度说"能不能动手"。设一道底线，低于它什么都不做；再按动作的代价逐个抬阈值。文档用 0.5–0.6 的底线、0.85–0.9 的高风险阈值。从保守值起步，用自己的数据调。三条标准出路：动手、确认/标记、转人工。

**Composite scoring.** 把复杂判断拆成每维度一个 Score。每个分数除以 `criteria.length - 1` 归一化，再在代码里加权合成。优先级变了就改权重，别改问题。

**Intent routing.** 用 Choice 分类，旁边加一个复杂度 Score。每个 intent 路由到确定性代码、专用 LLM 或人工。低置信度分类转人工。

**Taxonomy walk.** 树的每一层问一个 Choice，代码里走树。把子树作为选项的 criteria 值，让 Jev 看到分支下有什么。大子树裁成直接子节点加叶子样本。概率接近时多走几支。

**Counting.** Jev 不会数。一个条目一个 Noul、一个请求问完，把过阈值的答案求和。

**Dates.** 每个日期部位用 Choice 在枚举选项上抽取（含 "not stated"）。日期的组装和比较在代码里做。

**Extraction.** 用正则或生成式模型出候选，Jev 用 Choice 挑，或用 Noul 核实单个候选。

## Read the answers

- `score`（本项目 `.value`）是级别号的概率加权均值。1.0 可能是笃定第 1 级，也可能是 0 和 2 级对半。一起读 `distribution`。
- 对 score 做阈值、排序、取整到最近级别。别用它插值出数量——级别作为数字只是弱校准。
- `confidence` 量分布有多尖，描述的是模型的回答，不保证正确。要别的统计量用完整 `distribution`。
- Noul 没有 `confidence`，它离 0.5 的距离替代之（本项目里 raw 丢失时靠 `noulProbability` 区分空答）。
- 每个答案都在你给的选项内，代码永远不用解析散文。

## Improve a program

先找到出错的问题，再动手。收集带标签样本，跑一遍，把每个问题的答案和分布对着标签比。

| 症状 | 可能原因 | 修法 |
| --- | --- | --- |
| 高置信度地答错 | Jev 按字面读了 instructions | 写出精确条件，边界情形放进 criteria |
| Choice 置信度低 | 选项重叠，或没有选项贴合 | 加 what/not_for/examples，加 `other` |
| Score 置信度低 | 级别重叠、问题量了两件事、state 说得太少 | 级别改成互异情境；拆问题；补 state 字段 |
| Score 挤在中间 | 级别是程度或数字 | 每级描述具体情境，去掉数字 |
| 顶端案例长得都像 | 极端案例没有级别 | 给极端立一级 |
| Noul 在 0.5 附近晃 | 条件模糊 | 定义条件；两侧描述加例子（本项目写进 instructions） |
| 输入变大准确率掉 | state 带了无关细节 | 代码里过滤，只发需要的字段 |
| 计数、求和、日期、数值接近度出错 | Jev 在做算术 | 算术移进代码，Jev 只做抽取和逐项判断 |
| 嵌套或否定问题出错 | 间接层太多 | 问直接问题、点名 state 路径、拆成两个直白问题代码里合 |
| 答案跟着 state 里的文本走 | 内容带偏模型 | 收紧 criteria；测对抗样本；动作门控置信度 |
| 改一个问题，旧错变新错 | 一个问题称量了多个属性 | 拆成原子问题，代码里组合 |
| 每个答案都对、最终决定错 | 策略错了 | 改代码里的权重或阈值，别动问题 |
| 程序慢或贵 | 问题拆在多个串行请求里 | 并进一个请求；确有依赖才留第二次 |

修改规则：

- 一轮只改一两个问题。Jev 的概率漂移难以预测，区分度好的问题别碰。
- 用带标签的数据评判修改。置信度变高不等于问题变好，同一量尺的两种写法在你的数据上可能表现完全不同。
- 代码依赖的答案空间保持稳定。增删级别或选项会改变此前所有答案的含义。
- 通用规则写进 instructions/criteria；具体名字和值只放 examples。

## Checklist

- [ ] 每个问题只问一个属性，知情者一秒能答。
- [ ] Primitive 与代码用答案的方式匹配。
- [ ] instructions 写出精确条件，反引号点名 state 路径。
- [ ] criteria 与 instructions 同向、同题。
- [ ] Score 级别描述情境、各自自足、不带数字。
- [ ] 可能盖不全的 Choice 有 `other` 选项。
- [ ] 计数、算术、日期比较全在代码里。
- [ ] state 只装问题需要的字段，塞得进 token 预算。
- [ ] 同一 state 的问题都走一个请求。
- [ ] 每个动作都有匹配风险的置信度阈值，低置信度有退路。
- [ ] 缺答案（value/confidence 为 undefined）走退路，从不硬转成 0 或空。
- [ ] 权重和阈值在代码里。
- [ ] 每次修改都有带标签样本背书。

## Sources

- https://docs.typesafe.ai/model-jaggedness/jev-1.13
- https://docs.typesafe.ai/primitives/advanced
- https://docs.typesafe.ai/patterns（含 `/fan-out`、`/confidence-routing`、`/composite-scoring`、`/intent-routing`）
- https://docs.typesafe.ai/primitives 、`/score`、https://docs.typesafe.ai/confidence
- 上游技能：https://github.com/dbreunig/building-with-jev-skill
