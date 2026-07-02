# pi-prompt-intercept

面向 [pi](https://pi.dev) 的本地 provider payload 检查器。它会为当前 pi 进程打开一个浏览器 UI，默认以 pass-through 模式记录 provider request；需要时可以切到 intercept 模式，暂停 request 并进行查看、编辑、放行或丢弃。

这是一个研究和调试工具，用来理解 pi 即将发送给模型的实际 payload。

## 功能

- 监听 pi 的 `before_provider_request` extension event。
- 只有在运行 `/prompt-intercept open` 后，才会打开本地 Web UI：`http://127.0.0.1:47831`。
- 默认使用 pass-through capture：记录 provider request，但不阻塞模型请求。
- 用可读 tab 展示 provider payload：Overview、System、Messages、Tools、Edit JSON、JSON Tree。
- 可以切换到 intercept 模式，对 pending request 进行查看、编辑、放行或丢弃。
- 支持 `on`、`off`、`once` 三种 intercept 模式。
- 固定端口是有意设计。当前版本同一时间只允许一个 pi 进程打开 inspector。
- inspector 打开期间，会把最小审计事件写入 `.pi/prompt-intercept/events.jsonl`。

它不代理任意网络流量，只在 pi extension 生命周期内观察 provider payload。

## 安装

开发时临时加载：

```bash
pi -e ./src/index.ts
```

作为 pi package 从仓库安装：

```bash
pi install git:github.com/ichigyu/pi-prompt-intercept
```

如果希望项目本地自动发现，可以把 extension 复制或软链到 `.pi/extensions/`。

## 使用

1. 启动 pi，并确保 extension 已加载。
2. 为当前 pi 进程打开 inspector：

```text
/prompt-intercept open
```

3. 打开本地 UI：

```text
http://127.0.0.1:47831
```

4. 发送任意会到达模型的 prompt。默认情况下，request 会以 pass-through 记录下来，不会阻塞。
5. 通过 UI 中的 tab 查看 payload：

- **Overview**：model、message/tool 数量、粗略 token 估算、标量 request 参数、system prompt 预览。
- **System**：提取后的 system/developer/instructions 文本。
- **Messages**：规范化后的 conversation messages、tool call 和 tool result。
- **Tools**：tool schemas，包括名称、描述和参数。
- **Edit JSON**：当 request pending 时，可编辑的原始 JSON payload，用于 Forward Edited。
- **JSON Tree**：只读的结构化 payload 树。

如果需要阻塞 request，切换模式：

```text
/prompt-intercept on
/prompt-intercept once
/prompt-intercept off
```

当 request 处于 pending 状态时，可以在 UI 中选择：

- **Forward**：发送原始 provider payload。
- **Forward Edited**：解析编辑器里的 JSON，并发送编辑后的 payload。
- **Drop**：中止 provider request。
- **Pass Through**：停止阻塞后续 request，但继续记录。
- **Intercept Once**：只拦截下一次 provider request，然后自动回到 pass-through capture。

关闭 inspector：

```text
/prompt-intercept close
```

## Pi 命令

这个 extension 注册一个 router command：

```text
/prompt-intercept [open|close|status|on|off|once]
```

子命令：

- `open`：为当前 pi 进程启动本地 UI，并进入 pass-through capture。
- `close`：停止本地 UI，并丢弃 pending request。
- `status`：显示当前模式和本地 UI URL。
- `on`：必要时启动 UI，并拦截每一次 provider request。
- `off`：保持 UI 打开，但 provider request 直接通过并被记录。
- `once`：必要时启动 UI，只拦截下一次 provider request。

不带子命令运行 `/prompt-intercept`，等同于 `/prompt-intercept open`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PI_PROMPT_INTERCEPT_HOST` | `127.0.0.1` | 本地 UI 绑定地址。除非明确知道风险，否则保持本地地址。 |
| `PI_PROMPT_INTERCEPT_PORT` | `47831` | 本地 UI 端口。当前版本不会自动切换备用端口。 |
| `PI_PROMPT_INTERCEPT_TIMEOUT_MS` | `600000` | 超时后自动放行原始 payload。设为 `0` 表示一直等待。 |

示例：

```bash
PI_PROMPT_INTERCEPT_TIMEOUT_MS=0 pi -e ./src/index.ts
```

## 多个 pi 进程

当前版本同一时间只允许一个 pi 进程打开 inspector。如果另一个进程已经占用了 `127.0.0.1:47831`，`/prompt-intercept open` 会失败，并提示可能已有其他 pi 进程启用了 inspector。

这是有意设计：固定 URL 应该始终指向唯一一个活跃 inspector。

## 安全说明

Provider payload 可能包含敏感内容：

- system prompts
- user messages
- project context
- file contents
- tool results
- image metadata

server 默认绑定到 `127.0.0.1`。除非理解风险，否则不要绑定到 `0.0.0.0`。

把审计输出加入 `.gitignore`：

```gitignore
.pi/prompt-intercept/
```

## 开发

```bash
npm install
npm run typecheck
```

## 与 claude-tap 的关系

`claude-tap` 是面向多个 coding agents 的更通用流量检查工具。`pi-prompt-intercept` 更窄：它是一个最小 pi extension，专注于 pi extension 生命周期中的 provider request。
