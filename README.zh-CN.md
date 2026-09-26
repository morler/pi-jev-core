# pi-jev-core

[English](./README.md) | 简体中文

精简的独立 Pi 扩展：连接 Jev API，并注册 `jev_evaluate` 工具，支持 `noul`、`choice`、`score` 三种结构化判断。不包含工具路由、自动模式、技能发现或上下文压缩。

## 安装

在仓库目录安装本地包：

```bash
pi install /path/to/pi-jev-core
```

发布到 npm 后可用：

```bash
pi install npm:pi-jev-core
```

本包是纯 TypeScript 源码，由 pi 的扩展加载器（jiti）加载。程序化引用（经 tsx/jiti 等加载器）直接导入入口：`import { JevClient } from "pi-jev-core"`；深路径导入（如 `pi-jev-core/src/jev.ts`）同样保留，便于只取单层。

## 配置平台

默认使用 TypeSafe。设置 `JEV_PLATFORM` 并提供对应凭据；凭据也可放在 `~/.pi/agent/secrets/` 下表列文件中。

| `JEV_PLATFORM` | 凭据环境变量 | Pi secret 文件 | 默认模型 |
|---|---|---|---|
| `typesafe`（默认） | `TYPESAFE_API_KEY` | `typesafe_api_key` | `jev-latest` |
| `openrouter` | `OPENROUTER_API_KEY` | `openrouter_api_key` | `typesafe/jev-1.13` |
| `cloudflare` | `CLOUDFLARE_API_TOKEN` | `cloudflare_api_token` | `typesafe/jev` |
| `vercel` | `AI_GATEWAY_API_KEY` | `ai_gateway_api_key` | `typesafe-ai/jev` |

Cloudflare 还需要 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_GATEWAY_ID`。可用 `JEV_MODEL` 覆盖模型；TypeSafe 平台另支持 `TYPESAFE_DEFAULT_MODEL`。不要把 API key 写入仓库或发送给模型。

运行时用 `/jev-platform` 命令切换激活平台：不带参数列出全部平台及其凭据来源，并标记当前通道；`/jev-platform <name>` 切换并把选择持久化到 `~/.pi/agent/jev-platform`（路径可用 `JEV_PLATFORM_FILE` 覆写）。解析顺序：`JEV_PLATFORM` 环境变量 > 持久化选择 > `typesafe`。

## 本地 JevK5 平台（llama-server）

`JEV_PLATFORM=jevk5` 将判断请求路由到本地 llama-server 所服务的 JevK5 GGUF 模型——无需 API key，无外网流量。

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `JEV_PLATFORM` | `typesafe` | 设为 `jevk5` 即使用本地模型。 |
| `JEVK5_BASE_URL` | `http://127.0.0.1:8008` | llama-server 基础地址。 |
| `JEVK5_TEMP` | `1.532` | 校准温度（1.532 对应 4B，1.42 对应 2B）。 |
| `JEV_MODEL` | `jevk5-4b-v0.2` | 随答案返回的模型标签。 |

每个问题只跑一次前向推理：prompt 由服务端分词，答案字母的 logprob 经 `n_probs` 返回，再按 `JEVK5_TEMP` 做 softmax——即 JevK5 官方配方。用模型仓库的 `start_JevK5_4B.sh` 启动服务。

## 本地 Decider 平台（llama-server）

`JEV_PLATFORM=decider` 将判断请求路由到本地 llama-server 所服务的 decider GGUF（decider-4b v2.1）。按 decider-ai 的 plain 布局渲染请求，用 `decider_config.json` 的分类型校准温度做 softmax（choice 1.110、noul 1.560、score 1.287）；`DECIDER_TEMPERATURE` 可用单一温度覆盖整张表。score 问题遵循 decider 的孤立等级：每个等级单独一行是/否判断，归一化成等级分布后取期望作为分数。

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `JEV_PLATFORM` | `typesafe` | 设为 `decider` 即使用本地模型。 |
| `DECIDER_BASE_URL` | `http://127.0.0.1:8008` | llama-server 基础地址。 |
| `DECIDER_TEMPERATURE` | 分类型温度表 | 为所有类型指定同一温度，关闭分类型映射。 |
| `JEV_MODEL` | `decider-4b-v2.1` | 随答案返回的模型标签。 |

每个评分行只跑一次前向推理：该行由服务端分词，答案字母的 logprob 经 `n_probs` 返回，再按该行类型的温度做 softmax——即 decider-ai 官方配方。用 llama-server 加载模型仓库的 `decider-4b-q6_k.gguf` 即可。

## `jev_evaluate` 工具

工具把 `state` 和多个命名问题发送到当前 Jev 平台，返回答案、模型、用量、耗时和 provider 原始答案。问题说明：

- `noul`：判断是/否，返回是的概率。
- `choice`：从 `criteria` 对象的候选项中选择；键是选项 ID，值是说明。
- `score`：按 `criteria` 数组中的顺序进行评分，等级从低到高排列；至少两级（数组索引即分数，从 0 开始，响应的 `legend` 字段即此映射）。

一次请求示例：

```json
{
  "state": {
    "change": "Added a required field to the public request type"
  },
  "questions": {
    "breaking": {
      "type": "noul",
      "instructions": "Does this change break an existing caller?"
    },
    "kind": {
      "type": "choice",
      "instructions": "What best describes the change?",
      "criteria": {
        "api": "Public API change",
        "bug": "Bug fix",
        "other": "Other"
      }
    },
    "severity": {
      "type": "score",
      "instructions": "Rate the impact of this change",
      "criteria": ["Critical", "High", "Medium", "Low"]
    }
  }
}
```

`state` 可以是字符串或 JSON 对象；一次请求可包含多个独立问题。`noul` 不需要 `criteria`。传入 `state` 的内容会发送到配置的平台，仅提交完成判断所需的信息。

## 技能：building-with-jev

仓库附带 `building-with-jev` agent 技能（[`skills/building-with-jev/SKILL.md`](./skills/building-with-jev/SKILL.md)），改编自 [`dbreunig/building-with-jev-skill`](https://github.com/dbreunig/building-with-jev-skill)（上游面向 Python `typesafe_sdk`），对齐本包 API。内容覆盖 `noul`/`choice`/`score` 的问题设计、最小 state 构建、置信度门控组合模式，以及"症状 → 原因 → 修法"诊断表。

相对上游的改编：

- 示例全部改用 `JevClient.evaluate` / `jev_evaluate`；答案统一读 `.value`（choice 为选项名，score/noul 为数字），完整概率分布读 `.distribution`。
- `instructions` 仅接受字符串——上游的对象/数组形态（`question`/`focus`/`inspect` 键）改为短句内联；扩展 `src/types.ts` 与 `src/jev.ts` 透传是文档写明的升级路径。
- Noul 的 `true`/`false` 两侧 criteria 不透传（`noul(instructions)` 只收问题）；边界微妙时把两侧描述写进 instructions。
- 可选字段防护模式：provider 没给答案时 `value`/`confidence` 为 `undefined`——缺答案走退路，不要硬转成 `0`；用导出的 `noulProbability(raw)` 区分"没答"与"答了 0"。

三处改编均经真实响应核验（模型 `jev-1.13.0`）：choice/score 带 `confidence` 而 noul 不带；score 值是级别索引的概率加权均值。

为你的 agent 安装该技能：

```bash
cp -r skills/building-with-jev ~/.pi/agent/skills/
```

## 开发检查

```bash
npm install
npm test
npm run typecheck
```

API 客户端与平台适配器从 [`pi-jev`](https://github.com/TheoOliveira/pi-jev) MIT 许可代码中提取并精简；原许可见 `LICENSE`。
