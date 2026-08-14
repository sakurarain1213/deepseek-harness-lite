<p align="center">
  <img src="assets/logo.png" alt="DeepSeek Harness Lite" width="720">
</p>

<h1 align="center">DeepSeek Harness Lite</h1>

<p align="center">
  面向官方 DeepSeek Harness 运行时的轻量、本地优先发行层。
</p>

<p align="center">
  <a href="https://github.com/sakurarain1213/deepseek-harness-lite/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/sakurarain1213/deepseek-harness-lite/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green.svg"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="Upstream: DeepSeek Harness 0.1.0-rc.6" src="https://img.shields.io/badge/upstream-0.1.0--rc.6-blue.svg"></a>
</p>

> **非官方社区项目。** 本仓库由社区独立维护，与 DeepSeek 无隶属、赞助或背书关系。项目图片由社区提供，不代表官方认可。

[English](README.md) | [架构](docs/architecture.md) | [插件开发](docs/plugin-authoring.md) | [安全策略](SECURITY.md)

DeepSeek Harness Lite 保留官方 Harness 的 agent loop、session 模型、工具注册表和 LLM 接口，在此基础上提供更小的安装配置、可移除能力包、仓库自有插件和可复现兼容证据。它是独立仓库，不是 GitHub fork，也不是替代运行时。

## Lite 改变了什么

| 范围 | Lite 行为 |
| --- | --- |
| 运行时内核 | 使用 DeepSeek Harness 官方公开包，不复制或修改上游源码 |
| 默认配置 | 安装纯文本 `chat-only` 闭包 |
| 可选能力 | 通过可移除能力包加入精确依赖和 Cordis rows |
| 插件 | 只激活显式选择或由能力包贡献的 Lite 插件 |
| 兼容性 | 固定一套已验证上游包；latest-upstream 仅负责独立观测 |
| 发布 | 构建不可变 profile，全部验证通过后才切换 `current.json` |

## 安装

前置要求：Git、Node.js `^22.19.0` 或 `>=24`、Corepack。Windows 只有启用 `shell` 能力包时才需要 PowerShell 7（`pwsh`）。v0.1.0 从仓库 checkout 运行，暂未发布到 npm。

### Windows PowerShell

```powershell
git clone https://github.com/sakurarain1213/deepseek-harness-lite.git
Set-Location deepseek-harness-lite
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 build
node apps/cli/dist/src/bin.js init --config examples/chat-only/lite.config.json --home .dsh-lite-home
node apps/cli/dist/src/bin.js doctor --home .dsh-lite-home
node apps/cli/dist/src/bin.js inspect --home .dsh-lite-home
```

### macOS

```sh
git clone https://github.com/sakurarain1213/deepseek-harness-lite.git
cd deepseek-harness-lite
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 build
node apps/cli/dist/src/bin.js init --config examples/chat-only/lite.config.json --home .dsh-lite-home
node apps/cli/dist/src/bin.js doctor --home .dsh-lite-home
node apps/cli/dist/src/bin.js inspect --home .dsh-lite-home
```

### Linux

```sh
git clone https://github.com/sakurarain1213/deepseek-harness-lite.git
cd deepseek-harness-lite
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 build
node apps/cli/dist/src/bin.js init --config examples/chat-only/lite.config.json --home .dsh-lite-home
node apps/cli/dist/src/bin.js doctor --home .dsh-lite-home
node apps/cli/dist/src/bin.js inspect --home .dsh-lite-home
```

`doctor` 和 `inspect` 不需要模型凭据。运行真实模型请求时，只通过当前进程环境传入凭据。

Windows PowerShell：

```powershell
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
$env:DEEPSEEK_API_KEY = "<your-key>"
$env:DEEPSEEK_MODEL = "deepseek-v4-flash"
node apps/cli/dist/src/bin.js run "只回复：ready" --home .dsh-lite-home
```

macOS/Linux：

```sh
DEEPSEEK_BASE_URL='https://api.deepseek.com/v1' \
DEEPSEEK_API_KEY='<your-key>' \
DEEPSEEK_MODEL='deepseek-v4-flash' \
node apps/cli/dist/src/bin.js run '只回复：ready' --home .dsh-lite-home
```

不要把凭据写入 `lite.config.json`、生成 profile、fixture、日志或提交记录。`DEEPSEEK_MODEL` 默认为 `deepseek-v4-flash`；base URL 和 API key 没有默认值。

## 配置与能力包

| 选择 | 内容 | 适用场景 |
| --- | --- | --- |
| `chat-only` | 官方文本运行时；不启用可选能力包和插件 | 最小聊天与 API 验证 |
| `developer` | 默认启用 `workspace` | 使用有限 notes 和 session export 的本地开发 |
| `workspace` | `lite_notes` 与脱敏 session export | 不启用通用文件系统/搜索工具的持久项目上下文 |
| `shell` | 本地子进程、sandbox policy、命令 allowlist、Bash 或 PowerShell rows | 显式本地命令执行 |
| `research` | `lite_safe_fetch` | 不启用上游通用 `web_fetch` 的有限公开 HTTP(S) 获取 |

能力包采用声明式定义且可以移除。切换选择会重新生成精确依赖闭包、lock 和 Cordis rows。未启用能力对应的包不会留在生成 profile 中。

v0.1.0 的 `workspace` 有意排除上游通用文件系统和搜索工具；`research` 有意排除上游通用 `web_fetch`。只有这些更宽的接口通过 containment 和 SSRF release gate 后，才会考虑启用。

## 内置插件

| 包 | 能力 | 安全边界 |
| --- | --- | --- |
| `@dsh-lite/plugin-health` | 脱敏 `lite_health` 诊断 | 不枚举环境变量值 |
| `@dsh-lite/plugin-safe-fetch` | 有边界的公开 HTTP(S) fetch | 每次跳转重新验证；阻止私网和特殊地址；限制字节数和耗时 |
| `@dsh-lite/plugin-workspace-notes` | 固定路径的持久 notes | 只允许 `.dsh-lite/notes.md`；检查 canonical path 和链接；限制 UTF-8 字节数 |
| `@dsh-lite/plugin-command-allowlist` | 默认拒绝的 shell policy | 按 token 解析并拒绝 shell 语法；默认规则只读 |
| `@dsh-lite/plugin-session-export` | Markdown 或 JSON session 投影 | 只导出明确允许的事件和字段 |

仓库插件会随源码 checkout 安装，以便静态、可审查地 import；安装不等于激活。resolved profile 只挂载直接选择的插件和已选能力包贡献的插件。

## 插件目录

Catalog 状态来自证据，不由仓库 topic、流行度或单纯元数据决定。

| 状态 | 含义 |
| --- | --- |
| `bundled` | 在本仓库维护并进入 release gate |
| `verified` | 外部固定提交通过已公开的安装、构建、激活、许可和风险检查 |
| `listed` | 元数据可审查，但可执行验证仍不完整 |
| `blocked` | 许可、secret、安装、构建、激活或安全证据不允许推荐 |

外部提交必须固定完整 source commit，声明 SPDX license 与 Harness 兼容范围，提供 install/build/activation 证据并披露 risk flags。详见[插件开发](docs/plugin-authoring.md)和生成的[插件目录](catalog/generated/README.md)。

## 架构

```text
lite.config.json
       |
       v
CLI -> resolver -> 精确闭包 + Cordis rows -> 不可变 profile 发布
                    ^                       |
                    |                       v
                  能力包             官方 Harness 运行时
                                            |
                                            v
                                 官方工具注册表 + Lite 插件
```

Lite 负责配置、闭包生成、发布、插件和证据；官方包负责 agent loop、session、模型集成和工具注册表。信任边界与发布协议见[架构文档](docs/architecture.md)。

## 上游兼容策略

Stable channel 在 [`compat/upstream-lock.json`](compat/upstream-lock.json) 中固定上游 `0.1.0-rc.6` 的完整包清单。生成的 closure 与 lock 覆盖 Windows、macOS、Linux 上的全部能力包组合。

兼容性是**经过 release gate 的尽力验证**，不是永久保证：

- stable 使用已通过记录门禁的精确上游版本；
- latest-upstream workflow 只发现新的 registry 元数据；
- 升级上游必须重新生成 closure/lock 并通过完整 release gates；
- Lite config 和能力包 schema 在可行范围内保持稳定；
- 不兼容上游变更通过迁移说明和版本化发布处理。

详见[上游维护策略](docs/upstream-maintenance.md)。

## Windows 支持

Windows 是 v0.1.0 的受支持平台。原生路径使用 PowerShell rows、Windows 包闭包、兼容 PATHEXT 的 probe，并直接在最终路径构建 profile，使 pnpm 绝对 junction 保持有效；只有候选 profile 全部通过验证后才切换 `current.json`。

Release gate 包含名为 `keeps a native Windows absolute junction valid after publication` 的原生回归测试。Windows 与 Ubuntu、macOS 位于同一个 release-blocking CI matrix 中，不再配置 `continue-on-error`。本地验证还覆盖 `init`、`doctor`、`inspect`、一次真实 OpenAI-compatible API 请求、profile 清理、secret scan 和五个插件。

平台要求和完整门禁见 [Windows 支持文档](docs/windows-roadmap.md)。

## 安装体积证据

仓库内的 clean measurement 来自 macOS arm64、Node.js `22.22.3` 和 pnpm `10.15.0`。这是单平台证据，不是通用体积承诺。

| 安装对象 | 字节数 | 文件数 | 已安装包数 | 直接依赖 | Workspaces |
| --- | ---: | ---: | ---: | ---: | ---: |
| Lite checkout（含构建/测试依赖） | 139,890,898 | 4,107 | 121 | 64 | 14 |
| 生成的 `darwin-chat-only` closure | 2,345,263 | 335 | 20 | 18 | 不适用 |
| 官方 `@deepseek-ai/dsh@0.1.0-rc.6` aggregate | 253,526,108 | 32,237 | 524 | 1 | 不适用 |

[`compat/reports/install-size.json`](compat/reports/install-size.json) 是唯一数据来源。依赖图或测量方法变化后，重新运行 `corepack pnpm@10.15.0 measure:install`。

## 安全与维护

- 凭据只通过进程环境传入；诊断会脱敏 secret-like 字段。
- 生成 profile 使用精确依赖、已提交 lock hash 和 profile-local 解析检查。
- 可选能力包会扩大权限，必须显式选择。
- 网络、文件系统、进程和 session 插件分别执行自己的窄边界。
- 有效 Lite 配置不等于 sandbox。运行不可信任务前应审查启用的能力包和插件。

漏洞请按 [SECURITY.md](SECURITY.md) 使用 GitHub private vulnerability reporting，不要提交真实密钥或私有日志。

## 贡献与许可

代码、能力包、文档和 catalog 贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。Lite 原创代码使用 [MIT License](LICENSE)。上游和第三方包保留各自版权与许可，详见 [NOTICE.md](NOTICE.md)。

“DeepSeek”和“DeepSeek Harness”仅用于识别上游项目，不代表隶属、赞助或背书。
