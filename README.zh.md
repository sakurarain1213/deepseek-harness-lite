# DeepSeek Harness Lite

> **非官方社区项目。** DeepSeek Harness Lite 由社区独立维护，不代表 DeepSeek，也未获得其背书；本项目不复用 DeepSeek 标志。

[English](README.md) | [架构](docs/architecture.md) | [插件开发](docs/plugin-authoring.md) | [安全策略](SECURITY.md)

DeepSeek Harness Lite 是基于官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 公开包组合而成的开发者预览发行层。它提供精简聊天配置、可选能力包、五个示例插件和可复现的兼容锁。它不是源码分叉，也不会替换上游的 agent loop、session 模型、工具注册表或 LLM 接口。

## 快速开始

前置条件：Node.js `^22.19.0` 或 `>=24` 和 Corepack。首个版本从仓库 checkout 运行，暂不发布到 npm：

```sh
git clone https://github.com/sakurarain1213/deepseek-harness-lite.git
cd deepseek-harness-lite
corepack enable
corepack pnpm@10.15.0 install --frozen-lockfile
corepack pnpm@10.15.0 build
node apps/cli/dist/src/bin.js init --config examples/chat-only/lite.config.json --home .dsh-lite-home
node apps/cli/dist/src/bin.js doctor --home .dsh-lite-home
node apps/cli/dist/src/bin.js inspect --home .dsh-lite-home
```

`doctor` 和 `inspect` 不需要模型凭据。运行一次真实模型请求时，只通过当前进程环境传入凭据：

```sh
DEEPSEEK_BASE_URL='https://api.deepseek.com' \
DEEPSEEK_API_KEY='<your-key>' \
DEEPSEEK_MODEL='deepseek-v4-flash' \
node apps/cli/dist/src/bin.js run '只回复：ready' --home .dsh-lite-home
```

不要把凭据写入 `lite.config.json`、生成配置、测试 fixture 或提交记录。`DEEPSEEK_MODEL` 默认是 `deepseek-v4-flash`；base URL 和 API key 没有默认值。

## 配置与能力包

`chat-only` 是最小文本运行配置。`developer` preset 默认启用 `workspace`。能力包是声明式且可移除的：切换能力包会重新生成精确依赖闭包和 Cordis 配置，而不是仅在运行时禁用已经安装的包。

| 能力包 | 增加的能力 | 默认状态 | 已建模平台 |
| --- | --- | --- | --- |
| `workspace` | 限定在 workspace 内的持久 notes 与 session export | `developer` 启用 | macOS、Linux、Windows |
| `shell` | 本地子进程；macOS/Linux 使用 Bash，Windows 使用 PowerShell，并加载 sandbox policy | 关闭 | macOS、Linux、Windows |
| `research` | 有边界的公开 HTTP(S) fetch | 关闭 | macOS、Linux、Windows |

能力包元数据包含精确依赖、Cordis rows、平台声明、冲突和 probes。平台元数据本身不等于支持承诺，详见 [Windows 状态](#windows-状态)。

v0.1.0 有意不在 `workspace` 中加载上游通用文件系统或搜索工具，也不在 `research` 中加载上游通用 `web_fetch`。只有在 Lite 的 release gate 能够证明其 workspace containment 与 SSRF 边界后，才会考虑启用这些权限更宽的工具。这是主动收窄权限，不是兼容性缺陷。

## 仓库插件

五个插件分别展示不同的扩展点和安全边界。

| 插件 | 能力 | 安全边界 |
| --- | --- | --- |
| `@dsh-lite/plugin-health` | `lite_health` 诊断工具 | 只返回脱敏运行信息，不遍历环境变量值 |
| `@dsh-lite/plugin-safe-fetch` | 有大小和时间边界的 HTTP(S) fetch | 每次跳转都重新校验，拒绝私网、loopback、link-local、multicast 和 metadata service 地址 |
| `@dsh-lite/plugin-workspace-notes` | 有边界的 workspace note 读写工具与 note-section formatter | 数据固定到 `.dsh-lite/notes.md`，并执行 canonical path 与符号链接检查；并发替换父目录的残余风险见[安全策略](SECURITY.md) |
| `@dsh-lite/plugin-command-allowlist` | shell 执行策略 | 仅接受简单 token、拒绝 shell 语法；shell 能力包只默认允许只读的 `pwd`/`git status`/`git diff`/`git log` |
| `@dsh-lite/plugin-session-export` | Markdown 或 JSON session 投影 | 仅导出显式允许的事件字段 |

五个仓库自有包现均为 `bundled`：安装、构建与激活证据绑定到源码提交 `e97fd4d3070c96cd3f10e2e9c83c9b0468981664`。外部 catalog 条目根据证据分别标为 `verified`、`listed` 或 `blocked`。提交流程见 [插件开发文档](docs/plugin-authoring.md)。

从源码 checkout 安装时，这些体积较小的仓库插件包会一起安装，使 Runtime 可以使用静态且可审查的 import。安装不代表激活：resolved profile 只会挂载被直接选择或由已选能力包贡献的插件。某个重能力包未被选择时，它对应的官方 Harness 依赖会从生成 profile 中真正移除。

## 兼容证据

`stable` channel 固定到 [`compat/upstream-lock.json`](compat/upstream-lock.json) 中一组完整且版本一致的上游包。提交在 [`packages/core/compat/`](packages/core/compat/) 下的 closure 元数据和各平台 lock template 覆盖全部能力包组合；CLI 会在安装生成 profile 前验证完整性。

本项目提供的是 **best-effort verified compatibility（尽力验证的兼容性）**，不保证未来所有 DeepSeek Harness 版本永久兼容。stable 证据用于 release gate；latest-upstream lane 独立发现变化，不得覆盖或放宽 stable lane。详见 [上游维护策略](docs/upstream-maintenance.md)。

## 安装体积测量

运行 `pnpm measure:install`。测量会在相同平台、Node.js 版本、包管理器调用方式、registry、store 和 cache 条件下，创建实际 14-workspace 仓库 checkout、生成的 chat-only 官方包 closure 与官方 aggregate CLI 的干净安装，并把 `node_modules` bytes 与 file count、直接依赖数、实际安装的唯一包数、适用时的 workspace 数和环境元数据写入 `compat/reports/install-size.json`。

仓库内 2026-08-14 的 macOS arm64 实测使用 Node.js `22.22.3`、pnpm `10.15.0` 和同一个隔离 store/cache，结果为：

| 安装口径 | 安装字节数 | 文件数 | 实际安装的唯一包数 | 直接依赖数 | Workspace 数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Lite 仓库 checkout（包含构建/测试依赖） | 139,890,898 | 4,107 | 121 | 64 | 14 |
| 生成的核心 `darwin-chat-only` closure | 2,345,263 | 335 | 20 | 18 | 不适用 |
| 官方 `@deepseek-ai/dsh@0.1.0-rc.6` aggregate 安装 | 253,526,108 | 32,237 | 524 | 1 | 不适用 |

checkout 行对应本版本从源码安装的 quick start，因此包含开发/构建工具；核心行只测量生成的最小 Runtime closure。这是单平台测量，不是对所有平台的永久承诺。[`compat/reports/install-size.json`](compat/reports/install-size.json) 是唯一证据来源；依赖图或测量方法变化后必须重新运行并更新结果。

## 安全模型

- 配置与生成 profile 拒绝类似凭据的字段。
- API 凭据只存在于进程环境中；诊断会对 secret-like key 脱敏。
- 生成 profile 使用精确依赖和已提交 lock integrity hash。
- 能力包必须显式选择，可选能力不会静默启用。
- 插件 catalog 由证据驱动；仅被发现或完成元数据检查不代表获得推荐。
- 网络、文件系统、进程和 session export 插件分别执行自己的窄边界。
- 有效配置不等同于 sandbox。让 Lite 处理不可信任务或仓库前，必须审查启用的能力包和插件。

受支持版本与私密报告流程见 [SECURITY.md](SECURITY.md)，信任边界见 [architecture.md](docs/architecture.md)。

## Windows 状态

项目从第一天就在路径、平台依赖 closure、PowerShell rows、executable probes 和 lock templates 中建模 Windows。原生 Windows 支持目前仍是 **planned/experimental（计划中/实验性）**。只有 stable matrix 在 GitHub-hosted Windows runner 上成功，且维护者通过受审查的变更移除 `continue-on-error` 后，Windows 才能晋级为受支持平台。跨平台单元测试或生成 Windows locks 不能单独作为晋级证据。详见 [Windows 路线图](docs/windows-roadmap.md)。

## 参与贡献

代码、文档、能力包和 catalog 变更见 [CONTRIBUTING.md](CONTRIBUTING.md)。Catalog 提交必须固定 source commit，声明 SPDX license 与兼容范围，公开 risk flags，并提供 install/build/activation 证据，之后才可能被归类为 verified。

## 许可证与归属

DeepSeek Harness Lite 原创代码使用 [MIT License](LICENSE)。DeepSeek Harness 是独立上游项目，保留其版权和 MIT 许可证；依赖项保留各自许可证。归属信息见 [NOTICE.md](NOTICE.md)。

文中 “DeepSeek” 和 “DeepSeek Harness” 仅用于识别上游项目，不表示从属、赞助或背书关系。
