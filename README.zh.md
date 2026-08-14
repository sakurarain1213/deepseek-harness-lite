<p align="center">
  <img src="assets/logo.png" alt="DeepSeek Harness Lite" width="720">
</p>

<h1 align="center">DeepSeek Harness Lite</h1>

<p align="center">
  <strong>保留官方 Harness 内核，让安装、裁剪、改造与插件扩展更轻。</strong>
</p>

<p align="center">
  <a href="https://github.com/sakurarain1213/deepseek-harness-lite/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/sakurarain1213/deepseek-harness-lite/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green.svg"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="Upstream: DeepSeek Harness 0.1.0-rc.6" src="https://img.shields.io/badge/upstream-0.1.0--rc.6-blue.svg"></a>
</p>

> **非官方社区项目。** 本仓库由社区独立维护，与 DeepSeek 无隶属、赞助或背书关系。项目图片由社区提供，不代表官方认可。

[English](README.md) | [架构](docs/architecture.md) | [插件开发](docs/plugin-authoring.md) | [安全策略](SECURITY.md)

**仓库定位：** DeepSeek Harness Lite 不是对官方运行时的重写，而是基于官方 Harness 内核的非官方轻量发行与扩展层。它保留官方 agent loop、session 模型、工具注册表和 LLM 接口，通过更小的已验证配置、可移除能力包和聚焦的插件接入路径，降低下载安装、能力裁剪、二次改造和插件扩展成本。

插件兼容采用尽力而为、版本门禁策略：使用公开 Harness/Cordis 接口，并符合 Lite 宿主服务与安全边界的插件可以接入；但不承诺所有官方或第三方插件无需适配即可运行。

## 你实际运行的是什么

| 问题 | 答案 |
| --- | --- |
| 界面 | 命令行界面（CLI） |
| 交互方式 | 每次 `run` 执行一个任务；答案输出到终端后进程退出 |
| GUI 或桌面应用 | 没有 |
| 交互式聊天/REPL | 没有 |
| 支持系统 | Windows、macOS、Linux |
| 当前发行方式 | 原生 CLI 包：Windows `.zip`/`.exe`、macOS `.tar.gz`/`.dmg`、Linux `.tar.gz` |

Lite 适合希望在终端或脚本中使用小型、可检查 Harness 运行时的用户。它目前不是图形聊天客户端。

## Quick Start

从 [GitHub 最新 Release](https://github.com/sakurarain1213/deepseek-harness-lite/releases/latest) 下载对应系统的包。发布包已内置 Node.js 和 Corepack，不需要安装 Git、Node.js 或 pnpm。第一次 `init` 会下载并验证当前平台精确的 Harness 闭包，因此需要联网，可能花几分钟。Windows 只有启用 `shell` 能力包时才需要 PowerShell 7（`pwsh`）。

### Windows x64

运行 `.exe` 安装器，然后从开始菜单打开 **DeepSeek Harness Lite Terminal**：

```powershell
dsh-lite init --config "$env:LOCALAPPDATA\Programs\DeepSeek Harness Lite\examples\chat-only\lite.config.json" --home "$HOME\.dsh-lite-home"
dsh-lite doctor --home "$HOME\.dsh-lite-home"
```

如果使用便携 ZIP，解压后在该目录打开 PowerShell，并把 `dsh-lite` 换成 `./dsh-lite.cmd`：

```powershell
.\dsh-lite.cmd init --config .\examples\chat-only\lite.config.json --home "$HOME\.dsh-lite-home"
.\dsh-lite.cmd doctor --home "$HOME\.dsh-lite-home"
```

### macOS 或 Linux

下载 CPU 对应的压缩包（Intel/AMD 选 `x64`，Apple Silicon 选 `arm64`），解压并进入目录：

```sh
tar -xzf deepseek-harness-lite-v0.1.1-<platform>-<arch>.tar.gz
cd deepseek-harness-lite-v0.1.1-<platform>-<arch>
./dsh-lite init --config examples/chat-only/lite.config.json --home "$HOME/.dsh-lite-home"
./dsh-lite doctor --home "$HOME/.dsh-lite-home"
```

macOS `.dmg` 和 `.tar.gz` 中是同一套 CLI；先把 DMG 内容复制到可写目录，再运行 `./dsh-lite`。当前社区包没有签名，因此 Windows SmartScreen 或 macOS Gatekeeper 可能提示风险。请先用 `SHA256SUMS.txt` 校验文件；确切的签名状态见[安装包形式](#安装包形式)。

`init` 应输出 `initialized ...`。`doctor` 应返回 JSON，其中 `"status": "ok"`，并且每个检查都是 `pass`。这两个命令都不需要模型密钥。

下文用 `dsh-lite` 表示 Windows 安装版命令。Windows 便携 ZIP 请使用 `.\dsh-lite.cmd`；macOS/Linux 请使用 `./dsh-lite`；源码 checkout 使用 `node apps/cli/dist/src/bin.js`。

<p align="center">
  <img src="assets/quick-start.png" alt="DeepSeek Harness Lite Quick Start 终端示例" width="900">
</p>

<p align="center"><em>已验证流程的终端示例；路径经过缩短，不显示任何真实凭据。</em></p>

### 执行第一个模型任务

凭据只设置在当前终端进程中。下面使用官方 API 地址和常用聊天模型；如果使用其他 OpenAI-compatible endpoint，请换成该 endpoint 实际支持的模型名。

Windows PowerShell：

```powershell
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
$env:DEEPSEEK_API_KEY = "<your-key>"
$env:DEEPSEEK_MODEL = "deepseek-chat"
dsh-lite run "只回复：ready" --home "$HOME\.dsh-lite-home"
```

macOS/Linux：

```sh
export DEEPSEEK_BASE_URL='https://api.deepseek.com/v1'
export DEEPSEEK_API_KEY='<your-key>'
export DEEPSEEK_MODEL='deepseek-chat'
./dsh-lite run '只回复：ready' --home "$HOME/.dsh-lite-home"
```

stdout 应直接显示模型回答，例如 `ready`。`DEEPSEEK_BASE_URL` 可以是以 `/v1` 结尾的 API root，也可以是完整 `/chat/completions` URL。代码中的 `DEEPSEEK_MODEL` 默认值是 `deepseek-v4-flash`；如果 endpoint 使用其他模型名，请显式设置该变量。不要把凭据写入 `lite.config.json`、生成 profile、fixture、日志或提交记录。

## 一步一步使用

1. 针对选定配置和 Lite home 执行一次 `init`。它会解析、安装、激活并验证完整 profile，成功后才发布。
2. 安装或更新后执行 `doctor`。只有全部检查通过再继续。
3. 需要确认实际上游版本、包、Cordis rows、能力包和插件时执行 `inspect`。
4. 在当前终端导出 endpoint 凭据。
5. 执行一个用引号包住的任务。CLI 打印最终文本后退出；下一个任务再调用一次。

### 命令表

| 命令 | 用途 | 需要 API 凭据 |
| --- | --- | --- |
| `init --config <file> --home <dir>` | 根据 JSON 配置构建并原子发布 profile | 否 |
| `doctor --home <dir>` | 验证 Node、home、已安装闭包、运行时激活和凭据卫生 | 否 |
| `inspect --home <dir>` | 输出 resolved identity、依赖清单、Cordis rows、能力包和插件 | 否 |
| `run "<task>" --home <dir>` | 通过当前 Harness 运行时执行一个任务并打印最终回答 | 是 |

路径都相对于当前工作目录解析。`--home` 用于保存生成的运行时状态，不要手动修改其中的文件。需要切换能力时，修改或选择配置，再对同一个 home 重新执行 `init`；只有替代 profile 全部验证成功后才会切换。

### 使用 developer profile

仓库内置的 developer profile 会启用有边界的 workspace notes、脱敏 session export 和 health 插件：

```sh
dsh-lite init --config examples/developer/lite.config.json --home .dsh-lite-home
dsh-lite doctor --home .dsh-lite-home
dsh-lite inspect --home .dsh-lite-home
```

需要自定义时，可以创建下面的配置，再把文件路径传给 `init`：

```json
{
  "schemaVersion": 1,
  "upstream": { "channel": "stable", "version": "0.1.0-rc.6" },
  "profile": "custom",
  "packs": ["workspace", "research"],
  "plugins": ["health"]
}
```

能力包贡献的插件会自动加入。不要在 `plugins` 中重复列出同一个插件，否则会拒绝重复激活。启用 `shell` 或网络访问前，请先阅读下方能力表。

### 在另一个项目目录中使用

当前目录会成为 workspace-aware Lite 插件看到的工作区。CLI 和生成 home 保留在克隆的 Lite 仓库中，然后从你的项目目录用绝对路径调用：

Windows PowerShell：

```powershell
$LiteRepo = "C:\src\deepseek-harness-lite"
Set-Location "C:\src\my-project"
node "$LiteRepo\apps\cli\dist\src\bin.js" run "用三点总结这个项目" --home "$LiteRepo\.dsh-lite-home"
```

macOS/Linux：

```sh
LITE_REPO="$HOME/src/deepseek-harness-lite"
cd "$HOME/src/my-project"
node "$LITE_REPO/apps/cli/dist/src/bin.js" run '用三点总结这个项目' --home "$LITE_REPO/.dsh-lite-home"
```

### 常见问题

| 提示或现象 | 处理方法 |
| --- | --- |
| `Node ^22.19.0 or >=24 is required` | 安装受支持的 Node.js，再重新执行 `init` |
| `unable to read generated Lite state` | 检查 `--home`，然后为该 home 执行 `init` |
| `generated profile is not ready` | 不要手动修生成目录；重新执行 `init` |
| endpoint 或凭据未配置 | 在运行 CLI 的同一个终端导出 `DEEPSEEK_BASE_URL` 和 `DEEPSEEK_API_KEY` |
| 模型返回 HTTP 400/404 | 把 `DEEPSEEK_MODEL` 改成该 endpoint 支持的模型 |
| Windows `shell` profile 的 probe 失败 | 安装 PowerShell 7，并确认 `pwsh` 位于 `PATH` |

## 安装包形式

从 v0.1.1 开始，Release 附件会在对应原生平台构建并完成冒烟测试：

| 系统 | 附件 | 内置运行时 |
| --- | --- | --- |
| Windows x64 | 便携 `.zip`、Inno Setup `.exe` | Node.js 22.19.0 + Corepack |
| macOS Intel | 便携 `.tar.gz`、`.dmg` | Node.js 22.19.0 + Corepack |
| macOS Apple Silicon | 便携 `.tar.gz`、`.dmg` | Node.js 22.19.0 + Corepack |
| Linux x64 | 便携 `.tar.gz` | Node.js 22.19.0 + Corepack |

CI 会拒绝绝对链接、指回 checkout 的链接、越界链接和断链，把部署目录移动到 checkout 之外，再通过发布包启动器依次运行 `init`、`doctor` 和 `inspect`，全部通过才发布。附件包含中英文 README、示例、项目图片、MIT 许可证、NOTICE 和 SHA-256 校验文件。它们是 CLI 发行包，不是 GUI 应用，也不是单文件二进制程序。

当前社区构建**没有代码签名**。Windows 安装器可能触发 SmartScreen；macOS 镜像没有 notarization，可能需要在“隐私与安全性”中手动允许。处理警告前，请先核对 SHA-256，并确认文件来自本仓库 Release 页面。

### 从源码构建

贡献者和暂未提供附件的架构仍可从源码安装。该方式需要 Git、Node.js `^22.19.0` 或 `>=24`、Corepack：

```sh
git clone https://github.com/sakurarain1213/deepseek-harness-lite.git
cd deepseek-harness-lite
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 build
node apps/cli/dist/src/bin.js init --config examples/chat-only/lite.config.json --home .dsh-lite-home
node apps/cli/dist/src/bin.js doctor --home .dsh-lite-home
```

## Lite 改变了什么

| 范围 | Lite 行为 |
| --- | --- |
| 运行时内核 | 使用 DeepSeek Harness 官方公开包，不复制或修改上游源码 |
| 默认配置 | 安装纯文本 `chat-only` 闭包 |
| 可选能力 | 通过可移除能力包加入精确依赖和 Cordis rows |
| 插件 | 只激活显式选择或由能力包贡献的 Lite 插件 |
| 兼容性 | 固定一套已验证上游包；latest-upstream 仅负责独立观测 |
| 发布 | 构建不可变 profile，全部验证通过后才切换 `current.json` |

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

插件路线优先选择具有明确用户工作流、使用上游公开接口、权限边界窄、测试确定且能在 Windows/macOS/Linux 原生验证的能力。项目会持续增加有用插件，但只有 install、build、activation、license、secret 和安全边界检查全部通过，插件才会被 bundled 或推荐。外部插件可以先进入证据化 catalog，再评估是否适合内置。

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

v0.1.0 release evidence 和五个 bundled plugin 记录统一绑定到 Lite source commit `573e77a16e58d9832f6dca282cac00f1dbde2cea`。之后的证据提交只记录生成结果，不改变这份已验证源码。

兼容性是**经过 release gate 的尽力验证**，不是永久保证：

- stable 使用已通过记录门禁的精确上游版本；
- latest-upstream workflow 只发现新的 registry 元数据；
- 升级上游必须重新生成 closure/lock 并通过完整 release gates；
- Lite config 和能力包 schema 在可行范围内保持稳定；
- 不兼容上游变更通过迁移说明和版本化发布处理。

维护目标是及时评估每个依赖集合一致的官方 Harness 新版本；重新生成 closure 后，只有插件、运行时行为和完整原生 CI matrix 全部通过，才发布对应 Lite patch 或 minor 版本。如果某个上游版本失败，Lite 会保留最后一套已验证 stable 版本并公开阻塞原因，不会声称未经测试的兼容性。这是主动的尽力同步策略，不承诺与上游同日兼容。

详见[上游维护策略](docs/upstream-maintenance.md)。

## Windows 支持

Windows 是 v0.1.0 的受支持平台。原生路径使用 PowerShell rows、Windows 包闭包、兼容 PATHEXT 的 probe，并直接在最终路径构建 profile，使 pnpm 绝对 junction 保持有效；只有候选 profile 全部通过验证后才切换 `current.json`。

Release gate 包含名为 `keeps a native Windows absolute junction valid after publication` 的原生回归测试。Windows 与 Ubuntu、macOS 位于同一个 release-blocking CI matrix 中，不再配置 `continue-on-error`。本地验证还覆盖 `init`、`doctor`、`inspect`、一次真实 OpenAI-compatible API 请求、profile 清理、secret scan 和五个插件。

平台要求和完整门禁见 [Windows 支持文档](docs/windows-roadmap.md)。

## 安装体积证据

仓库内的 clean measurement 来自 Windows x64、Node.js `24.12.0` 和 pnpm `10.15.0`。这是单平台证据，不是通用体积承诺。

| 安装对象 | 字节数 | 文件数 | 已安装包数 | 直接依赖 | Workspaces |
| --- | ---: | ---: | ---: | ---: | ---: |
| Lite checkout（含构建/测试依赖） | 144,713,749 | 4,234 | 121 | 64 | 14 |
| 生成的 `win32-chat-only` closure | 2,443,233 | 372 | 20 | 18 | 不适用 |
| 官方 `@deepseek-ai/dsh@0.1.0-rc.6` aggregate | 257,006,438 | 32,696 | 523 | 1 | 不适用 |

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
