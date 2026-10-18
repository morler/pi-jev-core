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
| `local` | `JEV_LOCAL_PORT`（端口，无需 API key） | — | `jev-latest` |

Cloudflare 还需要 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_GATEWAY_ID`。可用 `JEV_MODEL` 覆盖模型；TypeSafe 平台另支持 `TYPESAFE_DEFAULT_MODEL`。不要把 API key 写入仓库或发送给模型。
`local` 平台连接本机 Jev API 服务：用 `/jev-platform local <端口>`（在同一配置文件里持久化为 `localPort`）或 `JEV_LOCAL_PORT` 设置端口。它向 `http://127.0.0.1:<端口>/v1/systemone` POST `{model, state, questions}`，期望返回 `{answers, model?, usage?}`；无需 API key。


运行时用 `/jev-platform` 命令切换激活平台：不带参数列出全部平台及其凭据来源，并标记当前通道；`/jev-platform <name>` 切换并把选择持久化（`local` 平台用 `/jev-platform local <端口>` 同时设置端口）到 `~/.pi/agent/pi-jev-core.json`（路径可用 `JEV_CONFIG_FILE` 覆写）。日志开关 `/jev-platform log on|off` 也保存到同一个 JSON 文件。解析顺序：`JEV_PLATFORM` 环境变量 > JSON 持久化选择 > `typesafe`；环境变量优先于持久化配置。

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
      "instructions": "Does `change` break an existing caller?"
    },
    "kind": {
      "type": "choice",
      "instructions": "What best describes `change`?",
      "criteria": {
        "api": "Public API change",
        "bug": "Bug fix",
        "other": "Other"
      }
    },
    "severity": {
      "type": "score",
      "instructions": "Rate the impact of `change`",
      "criteria": ["Critical", "High", "Medium", "Low"]
    }
  }
}
```

`state` 可以是字符串或 JSON 对象。对于对象 state，每个问题都必须用反引号引用所需字段，例如 `` `change` ``；缺失或不安全的路径会被拒绝。为兼容旧调用，字符串 state 会作为 `text` 字段发送。一次请求可包含多个独立问题。`noul` 不需要 `criteria`。对象 state 只有被引用的字段会发送到配置的平台。

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
