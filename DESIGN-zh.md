# codex-lsp 设计与实现分析

## 1. 分析范围与结论

本文分析 同一包内的 `src/codex/` 适配层及 `src/core/` 运行时，记录日期为 2026-10-16。文档最初来自静态审查；后续按诊断正确性、上下文一致性、交付验证三个阶段完成修复，并执行回归测试、真实语言服务器集成与制品验证。实现和当前验证范围分别见第 11、12 节。

**结论：项目面向本机 Codex CLI 0.163.0 的主要能力已实现，本轮已修复诊断截断、超时状态、静默漏报及环境同步等已确认问题。** 本机版本基准来自 `~/.local/bin/codex` 指向的 `0.163.0-x86_64-unknown-linux-musl` 安装目录；跨平台、桌面端与已有 daemon 的验证结论不能从本机 CLI 结果推导。

项目的核心价值是把语言服务器的语义能力接入 Codex 工作流：显式工具负责查询与重命名，编辑前后的 Hook 负责自动反馈，两者复用同一组语言服务器进程。自动反馈提供的是本次检查发现的问题及其变化；它的覆盖范围受文件选择、服务器能力和诊断完成状态约束。

| 能力                             | 当前实现                                 | 主要条件或限制                                    |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| 定义、实现、引用、悬停、符号查询 | 有对应 MCP 工具与 LSP 请求               | 目标服务器必须声明相应能力                        |
| 调用层级                         | prepare、incoming、outgoing 三个工具     | 后续请求携带包含服务器私有数据的 handle           |
| 诊断                             | 文件、目录、多语言、多诊断来源           | 结果区分来源、完整性、时效性和输出截断            |
| 编辑后反馈                       | `apply_patch` 与 `Bash` 的 Pre/Post Hook | Hook 已受信任，且 MCP 连接已建立                  |
| 重命名                           | 准备检查、应用 WorkspaceEdit、同步及诊断 | 写入应串行；部分写入失败不回滚                    |
| 环境绑定                         | launch、shell、command 三类快照          | 任意外部 shell 内部的临时环境不会自动变成会话环境 |
| 桌面端、IDE、已有 daemon         | 可生成固定环境绑定配置                   | 仓库记录明确说明尚未完成这些宿主路径的实测        |

## 2. 设计理念与模块边界

### 2.1 在单包中保留宿主适配与运行时边界

项目采用单仓库、单 pnpm 包：`src/codex/` 处理 Codex 特有的生命周期、调用上下文和环境交接，`src/core/` 处理语言服务器协议、进程、文档、诊断和工作区编辑。两层通过本地 ESM 导入连接，由根入口组合；核心层不导入 Codex 适配层。依赖、锁文件、TypeScript 编译器、测试和插件制品均由根包统一管理。

统一入口 [src/cli.ts](src/cli.ts) 的 `serveMcp()` 创建一个 `LspRuntime`，把标准工具、重命名结果记录器及两个 Hook 端点组合后交给 stdio 服务：

```ts
const baselines = new BaselineStore();
const feedback = new EditFeedback(runtime, baselines);
const tools: RegisteredLspTool[] = [
  ...LSP_TOOLS.map((tool) =>
    tool.name === "rename" ? recordingRename(tool, baselines) : tool,
  ),
  preEditSnapshotTool(feedback),
  postEditDiagnosticsTool(feedback),
];
const handle = serveLspStdio(runtime, {
  tools,
  resolveContext: resolveCodexContext,
});
```

这里的组合点使显式查询、编辑后诊断和重命名共享文档与进程状态。Hook 每次调用进入现有服务，避免为每次编辑重新创建语言服务器。

### 2.2 用明确上下文决定分析对象

工作区、项目根、环境和服务器是不同概念。工作区用于解释相对路径及加载项目配置；项目根由语言服务器的 root markers 决定；环境决定解释器、工具链和子进程变量；服务器决定具体语义能力。同一工作区内可以有多个项目根，同一文件可以有一个语义服务器和多个诊断服务器。

当前 MCP 进程从插件目录启动，因此代码刻意不把进程 `cwd` 当作用户工作区。环境同样通过快照显式交接，未绑定时以 `unbound` 标示使用 MCP 进程环境。

### 2.3 由一个管理器拥有语言服务器进程

[LspManager](src/core/lsp/manager.ts) 负责进程获取、初始化共享、引用计数、环境变化后的客户端淘汰和空闲回收。动态语义请求通过 `LspRuntime.withSemantic()` 进入 `withClient()`；诊断服务也通过同一管理器借用客户端。

管理器还实现了只读请求在连接死亡后的单次重试，写请求不重试。重试过程没有单独进入工具结果。这是当前实现中的自动恢复行为，需要与仓库要求的错误充分暴露原则一并审视。

### 2.4 把代码问题与工具故障分开

类型错误和未使用变量等是成功执行诊断后获得的数据。服务器缺失、超时、崩溃及不支持能力属于工具故障。普通 MCP 工具用 `isError` 和错误代码表达故障；诊断批次可以保留已成功来源的数据，同时报告其余来源未完成。

Hook 的目标是向 Codex 补充诊断上下文，代码没有返回阻断编辑的决定。后置端点会把检查异常转换为 `additionalContext`，以免仅留下宿主侧 Hook 失败状态。缺少前置记录、监听不完整及未确认诊断均显式报告，修复路径见第 11 节。

## 3. 总体架构

```text
                         Codex host
                 +-----------+------------+
                 |                        |
          Explicit MCP calls       Pre/PostToolUse
                 |                        |
                 |               apply_patch / Bash
                 v                        v
       +----------------------------------------------+
       | codex-lsp: one long-lived MCP process         |
       |                                              |
       | resolveCodexContext    pre_edit_snapshot     |
       | standard tools         post_edit_diagnostics |
       | recordingRename        EditFeedback          |
       |                        BaselineStore         |
       +----------------------+-----------------------+
                              |
                              v
       +----------------------------------------------+
       | src/core/: LspRuntime                         |
       |                                              |
       | ConfigService -> TargetResolver              |
       | EnvironmentService -> toolchain adapters     |
       | DocumentStore       DiagnosticService        |
       | FileChangeJournal   WorkspaceEditCoordinator |
       |                 LspManager                   |
       +----------------------+-----------------------+
                              |
                     JSON-RPC over stdio
                              |
             +----------------+----------------+
             v                v                v
          Pyright           Ruff         tsls / gopls /
                                        clangd / rust-analyzer

 shell / launcher
        |
        v
 environment snapshots -> EnvironmentService
```

| 模块         | 主要职责                               | 源码入口                                                                                                 |
| ------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| CLI 与组合根 | MCP 服务、启动器、环境采集、配置输出   | [src/cli.ts](src/cli.ts)                                                                                 |
| Codex 上下文 | 从 MCP 元数据提取工作区、会话和轮次    | [src/codex/context.ts](src/codex/context.ts)                                                             |
| Hook 适配    | 校验参数，生成 Codex Hook JSON         | [src/codex/hook/tools.ts](src/codex/hook/tools.ts)                                                                   |
| 编辑反馈     | 识别改动、复查、比较基线、组织反馈     | [src/codex/hook/edit-feedback.ts](src/codex/hook/edit-feedback.ts)                                                   |
| 环境交接     | 读取绑定、采集快照、生成 shell 集成    | [src/codex/environment/](src/codex/environment/)                                                                     |
| MCP 服务     | 注册工具、传递取消信号、编码结果       | [src/core/mcp/server.ts](src/core/mcp/server.ts)                                            |
| 路由与配置   | 合并配置，选择语言、项目根和服务器     | [src/core/runtime/router.ts](src/core/runtime/router.ts)                                    |
| LSP 生命周期 | 初始化、能力、请求、进程复用和回收     | [src/core/lsp/](src/core/lsp/)                                                              |
| 诊断聚合     | pull/push 收集、时效性和来源状态       | [src/core/diagnostics/](src/core/diagnostics/)                                              |
| 文档与编辑   | 文本同步、坐标转换、WorkspaceEdit 落盘 | [src/core/documents/](src/core/documents/)、[src/core/edits/](src/core/edits/) |

## 4. 当前 Codex 的接入契约

### 4.1 插件清单与 MCP 启动

项目采用 `.codex-plugin/plugin.json`、`.mcp.json`、`hooks/hooks.json` 和 `skills/` 的兼容布局。当前官方文档仍支持该布局，同时推荐新插件使用根级 portable manifest；仅凭目录格式旧于推荐布局，不能判定本项目不兼容。官方也说明带生命周期 Hook 的插件不适用于公共插件目录提交，需要通过支持的手动安装渠道分发。[官方插件打包文档](https://developers.openai.com/plugins/build/plugins)

当前 [.mcp.json](.mcp.json) 的服务器定义为：

```json
{
  "mcpServers": {
    "lsp": {
      "command": "node",
      "args": ["./dist/cli.js", "mcp"],
      "cwd": ".",
      "env": {
        "CODEX_MCP_PROTOCOL_VERSION": "2026-07-28"
      },
      "env_vars": ["CODEX_LSP_CONTEXT_ID", "CODEX_LSP_ENV_MANIFEST"]
    }
  }
}
```

安装说明要求同时启用 `features.mcp_2026_07_28`。运行时 [serveLspStdio()](src/core/mcp/server.ts) 使用官方 MCP SDK v2，并明确拒绝旧协议：

```ts
return serveStdio(createLspServerFactory(runtime, options), {
  legacy: "reject",
});
```

因此兼容性有明确前提：宿主支持且启用了所需 MCP 版本；Node 和配置的语言服务器可用；安装制品完整。协议开关、`CODEX_MCP_PROTOCOL_VERSION` 及私有元数据的具体组合依据项目的 0.163.0 验证记录，不应扩大为所有 Codex 宿主的稳定公共契约。[安装说明](docs/installation.md)

### 4.2 Hook 匹配器与输出

[hooks/hooks.json](hooks/hooks.json) 在 PreToolUse、PostToolUse 都匹配 `^(apply_patch|Bash)$`，通过 `type: "mcp_tool"` 调用裸服务器名 `lsp`。这里的 `Bash` 是 Codex 的规范化 Hook 工具名：官方文档明确包括 `exec_command`，长命令还可能在后续 `write_stdin` 轮询结束时交付原命令的 PostToolUse。因此不能因为模型工具名显示为 `exec_command` 就认定匹配器漏配。[官方 Hooks 文档](https://learn.chatgpt.com/docs/hooks)

配置把 `${tool_input}`、`${tool_response}` 作为完整占位符传递，保留其 JSON 类型。后置端点将如下形状序列化为 MCP 文本内容，Codex 再将 `additionalContext` 加入上下文：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "LSP diagnostics after apply_patch ..."
  }
}
```

官方确认 MCP Hook 使用已有连接、同步执行，并且不会负责启动或重连服务器；插件安装也不会自动授予 Hook 信任。这些是“工具能调用，但自动反馈不出现”的必要排查条件。[官方 Hooks 文档](https://learn.chatgpt.com/docs/hooks)、[插件 Hook 信任规则](https://developers.openai.com/plugins/build/plugins)

### 4.3 工作区与会话解析

[resolveCodexContext](src/codex/context.ts) 从 `_meta["x-codex-turn-metadata"]` 提取 `session_id`、`turn_id` 和 `workspaces`。只有一个绝对工作区路径时才推导默认工作区：

```ts
function singleWorkspace(
  workspaces: Record<string, unknown> | undefined,
): string | undefined {
  if (workspaces === undefined) return undefined;
  const roots = Object.keys(workspaces).filter((root) => isAbsolute(root));
  // Several workspaces make the default ambiguous; tools then need an absolute path or workspaceRoot.
  return roots.length === 1 ? roots[0] : undefined;
}
```

通用运行时的工作区优先级是工具参数、宿主上下文、运行时默认值。相对路径缺少工作区时返回 `invalid_path`。绝对路径仍可使用，但若没有 `workspaceRoot`，就无法按预期加载工作区级项目配置；多工作区调用应明确提供该参数。[上下文解析](src/core/runtime/context.ts)

Hook 请求直接携带配置插值后的 `cwd`、`sessionId`、`toolUseId`，不依赖普通 MCP 调用的完整 turn metadata。这与根包验证记录中的宿主行为一致。

## 5. 环境绑定与工具链选择

### 5.1 三类环境快照

[captureEnvironment()](src/codex/environment/capture.ts) 与 [snapshot.ts](src/core/environment/snapshot.ts) 共同定义环境身份与磁盘格式。

| 类型      | 身份及更新方式                                        | 使用场景                                          |
| --------- | ----------------------------------------------------- | ------------------------------------------------- |
| `launch`  | 每次启动生成独立 ID，记录父 shell ID                  | 从已激活环境启动 Codex                            |
| `shell`   | 当前交互 shell 保持同一 ID，变量变化时更新 generation | 让绑定此 ID 的宿主跟随环境变化                    |
| `command` | 每次采集生成独立 ID，不修改默认绑定                   | 临时激活环境后，通过工具参数 `environmentId` 使用 |

```text
 shell environment
        |
        +-- launch capture --> env-launch-A, generation 1
        |                           |
        |                           v
        |                  codex --no-daemon
        |                           |
        |                   forwarded binding
        |                           v
        |                     MCP process
        |
        +-- prompt capture --> env-shell-B, generation N
        |                           |
        |                    pinned host reads
        |                    latest manifest
        |
        +-- command capture -> env-command-C
                                    |
                           explicit environmentId
```

[launch()](src/codex/launch.ts) 先采集环境，再启动 `codex --no-daemon`，把 `CODEX_LSP_CONTEXT_ID` 和 `CODEX_LSP_ENV_MANIFEST` 放入子进程环境。独立宿主进程使绑定能够进入新启动的 MCP 服务，避免依赖已有 daemon 启动时保留的环境。launch 快照与父 shell 是不同 ID；父子关系本身不会让 launch 快照自动跟随父快照变化。

### 5.2 快照持久化与应用

快照仅持久化变量白名单及 `environment.extraVariables`，并记录这些变量中哪些已被 unset。写入先生成临时文件，再通过 rename 替换；每个环境保留最近三代。文件与目录创建模式分别是 `0600` 和 `0700`，实际权限语义取决于平台。

```text
 <stateDir>/
   environments/
     <environmentId>/
       manifest.json -------> gen-N.json
       gen-(N-2).json
       gen-(N-1).json
       gen-N.json
```

[EnvironmentService](src/core/environment/service.ts) 以 MCP 进程环境为底，先删除快照列出的 removed 变量，再覆盖已捕获变量。未列入快照的变量仍可能继承自 MCP 进程；“不保存完整环境”不能理解为子进程只获得白名单变量。

```ts
const variables = { ...base };
for (const name of snapshot.removed) deleteVariable(variables, name);
for (const [name, value] of Object.entries(snapshot.variables)) {
  deleteVariable(variables, name);
  variables[name] = value;
}
return variables;
```

每次提示符调用采集助手，重新读取当前配置与变量，包括 `environment.extraVariables`。快照按工作目录、捕获变量和 removed 集合去重；内容不变时不写盘。采集失败会显式报告，下一个提示符重新检查，不会把失败状态记为成功。代价是每个提示符都有一次 Node 启动。`env list` 只列出元数据，`env remove <id>` 显式删除指定环境；外部固定绑定可能长期使用旧 ID，因此没有按年龄自动删除快照。

### 5.3 工具链适配器

| 工具链            | 当前解析行为                                                                                                   | 实现                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Python            | 探测实际解释器的 executable、prefix、版本；检查 venv/Conda 与 PATH 一致性；向 Pyright 设置 `python.pythonPath` | [python.ts](src/core/environment/toolchains/python.ts) |
| Node / TypeScript | 探测 Node 版本，向上查找项目 `node_modules/typescript` 并记录 SDK 路径及版本                                   | [node.ts](src/core/environment/toolchains/node.ts)     |
| Go                | 用 `GOTOOLCHAIN=local` 执行 `go env`，避免探测阶段下载工具链                                                   | [go.ts](src/core/environment/toolchains/go.ts)         |
| Rust              | 在项目根探测 rustc、cargo、sysroot，设置 `RUSTUP_AUTO_INSTALL=0`                                               | [rust.ts](src/core/environment/toolchains/rust.ts)     |
| Java              | 根据 JAVA_HOME/PATH 探测 Java 版本                                                                             | [java.ts](src/core/environment/toolchains/java.ts)     |
| C/C++             | 探测编译器和项目编译数据库                                                                                     | [cpp.ts](src/core/environment/toolchains/cpp.ts)       |

Node 适配器返回的是事实与 fingerprint，没有像 Python 一样在返回值中指定语言服务器设置；“发现了项目 TypeScript SDK”与“强制 tsserver 使用该 SDK”需要区分，后者还取决于服务器自身解析及配置。Go/Rust 的禁止自动安装设置用于探测子进程，不能扩大为所有后续语言服务器子进程都不会下载或执行项目工具。

## 6. 配置、路由与进程复用

### 6.1 配置合并

[ConfigService](src/core/config/loader.ts) 按内置、用户、项目三层加载配置，使用文件修改时间及大小判断是否重新读取。配置文件位置由组合运行时的入口通过 `ConfigSources`（覆盖变量 `LSP_TOOLS_MCP_USER_CONFIG`/`LSP_TOOLS_MCP_PROJECT_CONFIG` 与 home 目录）一次性给定：CLI 传入自身进程环境，环境采集传入被采集 shell 的环境；核心层不再读取全局 `process.env` 或 `homedir()` 决定配置来源。配置采用 `schemaVersion: 1`，未知字段、重复扩展名归属及未知服务器引用会报错。

同名 `servers` 条目整体替换，`languages` 条目按字段覆盖已有定义；数组随字段替换。工具链推导的 settings 与用户服务器 settings 递归合并，后者优先。替换内置 TypeScript 服务器时必须保留需要的初始化选项，当前内置 `tsserver.useSyntaxServer = "never"` 用于避免项目加载期的单文件语义结果。[内置服务器](src/core/config/builtins.ts)

```text
 tool input + host context
             |
             v
 workspaceRoot -> effective config -> language route
                                      /            \
                                     v              v
                              semanticServer  diagnosticServers[]
                                     \              /
                                      v            v
 environment + project root + toolchain + server definition
                              |
                              v
                         ServerTarget
```

### 6.2 客户端身份

[TargetResolver.server()](src/core/runtime/router.ts) 先查找项目根并解析工具链，再定位语言服务器可执行文件。`slot` 表示同一环境身份、项目和服务器对应的位置；`key` 包含可执行文件、参数、有效环境、服务器配置和工具链指纹：

```ts
const slot = [
  environment.environmentId ?? environment.source,
  projectRoot,
  serverId,
].join("|");
```

```ts
key: stableHash({
	slot,
	executable,
	args,
	env,
	server: server.hash,
	toolchain: toolchain?.fingerprint ?? null,
}),
```

同一 key 复用客户端；同一 slot 出现新 key 时旧客户端进入 retired 状态，待使用者释放后退出。generation 参与工具链探测缓存身份，客户端 key 则由最终环境和工具链等内容决定，并非单纯按 generation 数字重启。

### 6.3 生命周期与取消

`LspManager` 共享初始化 Promise，并用 `refCount`、`pendingWaiters` 避免在调用仍在使用或等待时做空闲回收。默认空闲回收阈值为五分钟。MCP 请求的取消信号进入工具上下文，LSP 请求通过 `CancellationTokenSource` 转为协议取消；进程退出会主动使在途请求失败。[manager.ts](src/core/lsp/manager.ts)、[client.ts](src/core/lsp/client.ts)

```text
 no client --acquire--> initializing --initialize--> ready
                           |                         |
                           | failure                 +-- borrow/release --+
                           v                         |                   |
                         stopped                     +<------------------+
                                                     |
                           new key in same slot -----+--> retired
                                                     |       |
                           idle / shutdown ----------+       +-- release
                                                     |       |
                                                     v       v
                                                       stopped
```

## 7. LSP 文档、能力与语义工具

[LspClient](src/core/lsp/client.ts) 通过 `vscode-jsonrpc` 管理 stdio JSON-RPC，完成 initialize/initialized、配置请求、动态能力注册、诊断发布和进度状态处理。客户端声明 UTF-16 位置编码，支持文档及资源编辑，但明确拒绝语言服务器主动发起的 `workspace/applyEdit`；文件修改由本项目的重命名工具集中发起。

[DocumentStore](src/core/documents/store.ts) 保存每个客户端的文档内容、版本及同步序号。首次访问发送 didOpen，内容变化发送完整文本 didChange，并按服务器声明发送 didSave；服务器不接收 change 时使用关闭再打开的路径。外部文件修改通过已有客户端广播，删除则关闭对应文档。

[PositionMapper](src/core/documents/positions.ts) 负责公开坐标与 LSP 坐标转换：工具使用从 1 开始的行号、从 0 开始且按 Unicode code point 计数的列；LSP 使用从 0 开始的行号及 UTF-16 code unit 列。该转换让包含补充平面字符的文件仍能正确定位。当前实现读取不到目标文本时直接沿用列数，属于现存的精度降级路径。

[LSP_TOOLS](src/core/tools/index.ts) 注册十二个标准工具，Codex 适配层另外增加两个 Hook 端点：

| 工具组     | 工具                                                                            | 实现要点                                              |
| ---------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 状态与诊断 | `status`、`diagnostics`                                                         | status 不启动语言服务器；带文件参数时可执行工具链探测 |
| 语义查询   | `goto_definition`、`goto_implementation`、`find_references`、`hover`、`symbols` | 通过 `withSemantic()` 检查能力、同步文档后发送请求    |
| 调用层级   | `prepare_call_hierarchy`、`incoming_calls`、`outgoing_calls`                    | 保留 LSP item 的私有 data 与原工作区、环境 ID         |
| 重命名     | `prepare_rename`、`rename`                                                      | 分离只读准备检查和实际写入                            |

调用层级 handle 是 Base64URL 编码并使用 HMAC-SHA256 签名的 JSON，包含服务器实例、目标配置 key、环境代次身份、工作区、原始 item 及该 item 文件的内容哈希。[call-hierarchy.ts](src/core/tools/call-hierarchy.ts) 在发送后续请求前校验完整性和上下文；服务器重启、环境/配置变化或文件编辑后要求重新 prepare。签名密钥只在当前运行时内存中保存，服务器私有 data 不会被改写。

## 8. 多来源诊断与结果语义

### 8.1 诊断收集

所有诊断入口都通过 [LspRuntime.diagnose()](src/core/diagnostics/request.ts) 发出一次请求：显式工具选择单个文件或遍历目录，Hook 和 rename 给出已改动文件；请求只解析一次配置和环境，生成目标、统计覆盖并构造完整批次。各入口的差异作为请求参数显式表达：单个文件的语言未配置是工具错误，文件集合中的同类文件计入覆盖；显式工具未指定且未配置时报告到 hint，Hook 与 rename 报告到 warning；目录扫描检查后关闭自己打开的文档，编辑检查保持打开；只有显式工具设置展示上限。

[checkFiles()](src/core/diagnostics/batch.ts) 先按语言分组，再并行运行每种语言配置的诊断来源。每个来源内部继续按 `ServerTarget.key` 分组，通过管理器获取客户端，每个客户端最多并发检查八个文档。

```text
 files
   |
   v
 group by language
   |
   +--> provider A --> group by ServerTarget --> collect documents
   |
   +--> provider B --> group by ServerTarget --> collect documents
   |
   v
 provider outcomes + freshness + diagnostics
   |
   v
 buildBatch -> counts / coverage / incompleteReasons / truncated
```

[DiagnosticService](src/core/diagnostics/service.ts) 同时处理 pull 和 push。支持 pull 时使用 `textDocument/diagnostic`，保留 resultId 以处理 unchanged 返回。支持进度的服务器在每次收集前重新等待后台工作结束，超时结果保留 unconfirmed 状态，并合并同步后的 push 数据，使 rust-analyzer 的后台 cargo check 结果有机会进入同一批次。

push 路径用文档同步序号、工作区变化序号及可选的文档版本判断结果是否新鲜。遇到不重复发布相同诊断的服务器，先短暂等待，再重新打开文档请求分析。重新打开前的 barrier 请求用于隔开关闭文档产生的空诊断。此机制依赖具体服务器行为，当前代码还存在 barrier 超时后停止尝试的分支。

### 8.2 完整性与截断相互独立

`buildBatch()` 按来源保留诊断，先做严重性过滤与排序，再按 `limit` 截断输出。不同来源报告的同一个位置不会被合并为一个来源。

| 字段                                  | 含义                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `providers`                           | 每个来源的状态、模式、已检查文件数及故障信息                                               |
| `files[].freshness`                   | pull 响应或带版本 push 被标为 confirmed，无版本 push 为 observed，无法确认时为 unconfirmed |
| `coverage`                            | 扫描、检查、不支持的文件及排除目录数量                                                     |
| `complete` / `incompleteReasons`      | 收集过程中是否出现来源失败、覆盖不足或无法确认的新鲜度                                     |
| `counts`                              | 严重性过滤后、输出截断前的诊断数量                                                         |
| `diagnostics` / `shown` / `truncated` | 实际返回的诊断子集及是否截断                                                               |

`complete: true` 不意味着诊断数组未截断，也不意味着完成了全项目构建。普通 `diagnostics` 默认只返回 200 条，可以用 `limit` 调整。调用者必须同时理解覆盖、完整性、时效性和截断状态。

## 9. 编辑后的自动反馈

### 9.1 从编辑事件到诊断批次

[EditFeedback](src/codex/hook/edit-feedback.ts) 将 Codex 事件转换成文件改动和诊断比较。`apply_patch` 从补丁头提取 Add、Update、Delete、Move；前置 Hook 对内容哈希已变化的已有文件建立基线。shell 命令则通过文件监听日志标记时间窗口，并保存窗口开始时的文件集合，以区分创建与原子替换；不解析命令文本。

```text
 PreToolUse
    |
    +-- apply_patch --> parse headers --> baseline existing files
    |
    +-- Bash --------> journal.mark() + known files
    |
    v
 Codex performs tool operation
    |
    v
 PostToolUse
    |
    +-- apply_patch --> check response --> parse file changes
    |
    +-- Bash --------> journal.collect(mark)
    |
    v
 notify active LSP clients
    |
    v
 update move/delete baselines
    |
    v
 diagnose edited files + selected open files
    |
    v
 compare baseline --> additionalContext JSON
```

[FileChangeJournal](src/core/workspace/journal.ts) 从工作区根递归建立逐目录 watcher，排除依赖和构建目录，并在新目录出现时继续建立监听。collect 等待 100 ms 接收排队事件，然后按窗口内事件与当前磁盘状态分类。它观察的是时间窗口中的文件系统变化，无法证明每项变化一定由对应 shell 命令造成；并行命令或其他进程写入可能进入同一窗口。

### 9.2 基线比较

[BaselineStore](src/codex/hook/baseline.ts) 按会话和文件保存环境身份、内容哈希、成功取得结果的 provider 和诊断。比较使用多重集合差分，指纹由 provider、严重性、代码和消息组成：

```ts
function fingerprint(diagnostic: BatchDiagnostic): string {
  return JSON.stringify([
    diagnostic.providerId,
    diagnostic.severity,
    diagnostic.code ?? null,
    diagnostic.message,
  ]);
}
```

忽略位置使“仅因插入几行而移动的问题”不会重新上报；代价是无法区分同一文件内两个位置互换、但指纹相同且数量不变的问题。比较只针对前后共同出现的 provider。首次检查、环境变化或新出现的来源会尽量标为已有或无法归因的问题，避免直接归咎于本次编辑。

当前实现的内部范围如下。比较使用完整诊断；文件诊断未确认时保留旧基线，只报告未完成状态及观察到的问题，不宣称问题已经解决。

| 项目              | 当前值                               | 影响                       |
| ----------------- | ------------------------------------ | -------------------------- |
| Hook 诊断批次输出 | 不截断 | 所有收集到的诊断参与基线比较 |
| Hook 文本展示     | 20 条                                | 其余在已收集子集中计数提示 |
| 关联打开文档 | 当前工作区内全部已打开文件 | 不再静默省略第十个之后的文件 |
| 基线缓存          | 32 个会话，每会话 4,096 个文件       | 淘汰后重新进入首次检查语义 |
| shell 待配对事件  | 256 个                               | 超出后移除较早的前置记录   |
| 文件监听          | 每工作区 4,096 个目录、20,000 个事件 | 日志层记录不完整原因       |
| 活跃文件日志      | 4 个工作区                           | 超出后关闭较早使用的日志   |

来源：[edit-feedback.ts](src/codex/hook/edit-feedback.ts)、[baseline.ts](src/codex/hook/baseline.ts)、[constants.ts](src/core/lsp/constants.ts)。

## 10. 重命名与文件写入

[renameTool](src/core/tools/rename.ts) 在同步目标文档后请求 `textDocument/rename`，将 WorkspaceEdit 交给 [WorkspaceEditCoordinator](src/core/edits/coordinator.ts)。协调器将编辑转换为 text/create/rename/delete 操作，并在内存视图中提前验证文件存在性、已打开文档版本与内容、文本编辑重叠等条件。

```text
 textDocument/rename
          |
          v
 WorkspaceEdit -> ordered operations
          |
          v
 validate using in-memory file contents
          |
          v
 sequential disk writes
          |
          +-- failure --> completed / failed / skipped
          |
          v
 sync active clients -> diagnose changed files -> record baseline
```

内部队列使协调器自己的写入不交错：

```ts
apply(edit: WorkspaceEdit, origin: LspClient): Promise<WorkspaceEditReport> {
	const run = this.queue.then(() => this.applyNow(edit, origin));
	this.queue = run.catch(() => undefined);
	return run;
}
```

该队列不锁住外部 shell 或其他 MCP 服务的文件写入，因此工具描述仍要求在调用端串行执行 rename。写入过程中失败会停止后续操作并报告已完成部分，没有回滚。成功后同步语言服务器并执行诊断；适配层的 `recordingRename()` 将诊断结果纳入会话基线。文件写入成功与后置诊断完整是两个需要分别检查的状态。

## 11. 分阶段修复与实现取舍

### 11.1 诊断正确性与可见性

删除了 `neverIdle` 永久状态。每次 pull 检查重新判断工作区是否空闲；等待超时则继续标为 unconfirmed，后续加载结束可以恢复正常结果。Hook 与 rename 发出的诊断请求不设输出条数限制，显式 `diagnostics` 工具的展示限制仍由参数控制，因此 Hook 和 rename 的基线不会受 1,000/200 条截断影响。

[编辑反馈](src/codex/hook/edit-feedback.ts) 复查当前工作区全部已打开相关文件，移除了十文件上限。监听不完整、日志已关闭或缺少 PreToolUse 记录时，即使零个文件变化也返回 `additionalContext`；不再提前去重并丢弃告警。未确认结果不更新基线，不产生 resolved 结论。

```ts
if (batch.files.some((file) => file.path === path && file.freshness === "unconfirmed")) {
	return [{ path, status: "unconfirmed", added: [], resolved: [], existing: now.diagnostics }];
}
```

回归测试覆盖连续超时仍不完整、加载完成后恢复、超过 1,000 条诊断、rename 超过 200 条、超过十个相关文件、零变化监听缺口，以及未确认空结果不能清除旧问题。[运行时诊断测试](test/core/diagnostics.test.ts)、[Hook 测试](test/codex/post-edit-hook.test.ts)、[反馈边界测试](test/codex/edit-feedback.test.ts)

### 11.2 文件归因与上下文一致性

[JournalMark](src/core/workspace/journal.ts) 同时保存事件序号和编辑前文件集合。collect 根据旧集合及当前文件状态区分 changed、created、deleted，不再把所有 rename 事件当成创建。前后 Hook 保持对同一日志实例的引用，实例关闭时显式报告覆盖不完整。

```ts
mark(): JournalMark {
	return { seq: this.seq, files: new Set(this.files) };
}
```

shell 集成将采集和去重集中到 Node 助手及快照存储层，每个提示符重新读取配置，覆盖自定义变量变化及配置修复；无变化时不写磁盘。配置读取异常直接失败，不吞掉 extraVariables。目录变化更新快照元数据。

调用层级使用版本 2 签名句柄，拒绝被修改的数据以及失效的服务器/环境/文件上下文。现有旧格式无需兼容，调用方在失效后重新调用 prepare 即可。[导航测试](test/core/navigation.test.ts) 覆盖嵌套调用、签名修改、服务器重启和文件编辑；[shell 测试](test/codex/shell-integration.test.ts) 覆盖额外变量和失败后配置修复。

### 11.3 进度、状态管理与验收入口

[MCP 服务](src/core/mcp/server.ts) 仅在调用者提供 progressToken 时发送真实工具开始和完成事件，不估算百分比，不伪造后台检查进度。宿主是否显示通知取决于它的 MCP 调用与 UI。取消仍沿原请求信号传递。

新增 [环境管理模块](src/codex/environment/manage.ts) 及 `env list`、`env remove <id>`。删除必须由明确命令触发，不根据年龄推断外部固定环境是否失效，也不在后台删除用户快照。测试只操作临时状态目录。

[CI](.github/workflows/ci.yml) 增加真实语言服务器集成 job，并提供手动开启的 Codex 0.163.0 契约 job；后者需要测试账号认证 secret，缺少时明确失败。原有多系统、Node 版本矩阵继续承担跨平台检查。实际执行证据与尚未验证的宿主范围见下一节。

## 12. 测试证据、打包与交付边界

### 12.1 测试分层

| 层次 | 当前测试覆盖 | 验证范围 |
| --- | --- | --- |
| 单元与 Codex 适配 | 配置、坐标、环境、进程、诊断、编辑、Hook 和单包布局 | 合并后 137 项通过；默认跳过真实 Codex 2 项及缺少 pwsh 的 1 项 |
| 真实语言服务器集成 | Pyright、Ruff、TypeScript 6/7、gopls、clangd、rust-analyzer | 合并后 29 项通过，含 TypeScript 7 原生 LSP/编译器的 4 项测试 |
| 制品检查 | 生产依赖安装、移出源树、连接 MCP 并列出工具 | 单包制品成功发现 14 个工具，不包含独立运行时包和开发 SDK |
| 真实 Codex 契约 | 安装插件后验证 apply_patch、shell 和 venv 启动 | 整合后在隔离 CODEX_HOME 中验证最终制品，2/2 通过 |
| 静态检查 | TypeScript 7、Biome、补丁空白、CI YAML 和文档引用 | 本机执行；远端工作流尚未触发 |

[真实宿主测试](test/codex/codex-contract.test.ts) 使用临时 CODEX_HOME，安装 staged plugin，读取会话记录检查诊断反馈。它只有两个场景，且通过 `--dangerously-bypass-hook-trust` 绕过本次运行的 Hook 信任检查，因此并未覆盖交互式信任授权流程。主仓库通过手动 workflow_dispatch 输入 codex_contract 启用宿主契约测试，并通过 integration job 执行 TypeScript 6/7 等真实服务器测试。[CI](.github/workflows/ci.yml)

验证平台为 Linux、Node 24 和 Codex CLI 0.163.0。macOS、Windows、PowerShell、桌面宿主、部分工具链切换及大型项目性能仍需对应环境验证；CI 配置与本机执行结果分开记录。

### 12.2 单包构建与制品布局

根 `package.json` 直接声明 MCP SDK、JSON-RPC、LSP 协议和 Zod 依赖，不再引用工作区包或外部运行时版本。`pnpm install --frozen-lockfile` 使用唯一的根锁文件。`scripts/build.mjs` 清理旧 `dist/`，再明确调用 TypeScript 7 编译器，避免迁移前路径残留或 TypeScript 6 测试 SDK 的同名命令影响构建。

[package-plugin.mjs](scripts/package-plugin.mjs) 复制包清单指定的分发文件及根锁文件，在制品目录执行 pnpm 生产依赖安装，使用 hoisted 布局、禁用安装脚本，并移除 `.bin` 符号链接。随后检查制品无符号链接且不含开发工具，复制到源码目录外验证 MCP 发现。使用文档与设计文档随包分发。

```text
 one package.json + pnpm-lock.yaml
                  |
             pnpm run build
                  |
                  v
 dist/cli.js + dist/codex/ + dist/core/
                  |
       stage declared package files
                  |
       pnpm install --prod --frozen-lockfile
                  |
                  v
 artifacts/codex-lsp-plugin/
   .codex-plugin/plugin.json
   .mcp.json
   hooks/  skills/  shell/  docs/
   dist/
   node_modules/
                  |
       relocate outside source tree
                  |
           MCP tools/list check
```

生产制品不包含语言服务器或 TypeScript 开发 SDK。TypeScript 7 是编译器及原生 LSP 测试依赖，`typescript6` 别名只为 TypeScript 6 的真实测试提供明确 SDK；二者不会进入生产依赖。项目不向 npm registry 发布；交付物是上述完整插件制品，仓库根目录的 [.agents/plugins/marketplace.json](.agents/plugins/marketplace.json) 把它登记为本地 marketplace `codex-lsp-local`，安装和分发步骤见 [安装指南](docs/installation.md)。

### 12.3 TypeScript 7 真实验证

[test/integration/typescript7.test.ts](test/integration/typescript7.test.ts) 直接使用已固定的 TypeScript 7.0.2 `bin/tsc --lsp --stdio` 启动原生服务，并断言启动参数及服务器报告的 7.x 版本。四个真实场景覆盖：类型错误出现与编辑后消失、跨文件定义/引用/悬停/重命名、调用层级往返、编译器错误退出与修复后的成功退出。TypeScript 6 仍通过 typescript-language-server 配合单独样例 SDK 验证，不作为 TypeScript 7 失败时的替代路径。

## 13. 阅读与维护索引

| 关注点               | 首先阅读                                                                                                  | 随后阅读                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Codex 接入           | [插件清单](.codex-plugin/plugin.json)、[Hook 配置](hooks/hooks.json)                                      | [CLI](src/cli.ts)、[上下文适配](src/codex/context.ts)、[Hook 工具](src/codex/hook/tools.ts)                                    |
| 环境错误             | [绑定](src/codex/environment/binding.ts)、[采集](src/codex/environment/capture.ts)                                    | [快照](src/core/environment/snapshot.ts)、[工具链](src/core/environment/toolchains/) |
| 服务器选错或重复启动 | [配置](src/core/config/loader.ts)、[路由](src/core/runtime/router.ts) | [管理器](src/core/lsp/manager.ts)                                                                      |
| 漏报或陈旧诊断       | [诊断服务](src/core/diagnostics/service.ts)                                             | [文档同步](src/core/documents/store.ts)、[批次聚合](src/core/diagnostics/batch.ts)   |
| 自动反馈归因错误     | [编辑反馈](src/codex/hook/edit-feedback.ts)、[基线](src/codex/hook/baseline.ts)                                       | [补丁解析](src/codex/hook/apply-patch.ts)、[文件日志](src/core/workspace/journal.ts)                         |
| 重命名落盘           | [rename 工具](src/core/tools/rename.ts)                                                 | [编辑协调器](src/core/edits/coordinator.ts)                                                            |
| 用户配置和能力说明   | [使用文档目录](docs/README.md)                                                                            | [工具](docs/tools.md)、[环境](docs/environments.md)、[故障排查](docs/troubleshooting.md)                                 |
