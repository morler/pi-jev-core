# pi-jev-core

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

本包是纯 TypeScript 源码，由 pi 的扩展加载器（jiti）加载。它不是给 node 直接 `import` 的库；若要程序化引用，需经 tsx/jiti 等加载器按子路径导入（如 `pi-jev-core/src/jev.ts`）。

## 配置平台

默认使用 TypeSafe。设置 `JEV_PLATFORM` 并提供对应凭据；凭据也可放在 `~/.pi/agent/secrets/` 下表列文件中。

| `JEV_PLATFORM` | 凭据环境变量 | Pi secret 文件 | 默认模型 |
|---|---|---|---|
| `typesafe`（默认） | `TYPESAFE_API_KEY` | `typesafe_api_key` | `jev-latest` |
| `openrouter` | `OPENROUTER_API_KEY` | `openrouter_api_key` | `typesafe/jev-1.13` |
| `cloudflare` | `CLOUDFLARE_API_TOKEN` | `cloudflare_api_token` | `typesafe/jev` |
| `vercel` | `AI_GATEWAY_API_KEY` | `ai_gateway_api_key` | `typesafe-ai/jev` |

Cloudflare 还需要 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_GATEWAY_ID`。可用 `JEV_MODEL` 覆盖模型；TypeSafe 平台另支持 `TYPESAFE_DEFAULT_MODEL`。不要把 API key 写入仓库或发送给模型。

## `jev_evaluate` 工具

工具把 `state` 和多个命名问题发送到当前 Jev 平台，返回答案、模型、用量、耗时和 provider 原始答案。问题说明：

- `noul`：判断是/否，返回是的概率。
- `choice`：从 `criteria` 对象的候选项中选择；键是选项 ID，值是说明。
- `score`：按 `criteria` 数组中的顺序进行评分，数组从最高等级排到最低等级；至少两级（数组索引即分数，从 0 开始）。

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

## 开发检查

```bash
npm install
npm test
npm run typecheck
```

API 客户端与平台适配器从 [`pi-jev`](https://github.com/TheoOliveira/pi-jev) MIT 许可代码中提取并精简；原许可见 `LICENSE`。
