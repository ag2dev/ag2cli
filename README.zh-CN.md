<p align="center"><strong>AG2CLI</strong></p>
<h1 align="center">Agent to CLI</h1>
<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

> **开发阶段：** 项目仍处于早期并快速迭代中，功能、配置和使用方式可能随时变化；当前版本不作稳定性和后向兼容承诺。

AG2CLI 是面向软件开发的 Coding Agent CLI Harness，提供交互式 TUI、单次 Headless 运行和长期运行的服务端。由 AG2DEV 构建。

## 从源码运行

公开仓库当前只包含源码，暂不提供预构建 CLI、发布构建命令或安装流程。正式发布后会在此补充下载和安装说明。

目前可安装 Bun 1.3.14 或更高版本，然后从此 checkout 运行 CLI：

```sh
git clone https://github.com/ag2dev/ag2cli.git
cd ag2cli
bun install
bun run --cwd apps/cli start
```

下方命令示例用于说明 CLI 的行为，运行时需要 `PATH` 中已有 `ag2cli` 可执行文件。

## 配置模型服务

AG2CLI 连接由你选择的模型服务端。请从服务商文档获取 API Key、Base URL 和准确的模型 ID。`AG2CLI_PROTOCOL` 选择 API 格式，而不是服务商名称：

- `openai`：兼容 OpenAI Chat Completions 的接口。
- `anthropic`：兼容 Anthropic Messages 的接口。

协议兼容不代表不同服务商或模型的功能完全相同。工具调用、上下文长度和模型专属选项以服务商文档为准。API Key 只从环境变量读取，不要提交到仓库。`export` 设置只对当前终端生效。

```sh
export AG2CLI_PROTOCOL=openai # 根据接口格式选择 openai 或 anthropic
export AG2CLI_BASE_URL=https://your-provider.example.com
export AG2CLI_API_KEY="your-api-key"
export AG2CLI_MODEL=your-model-id
```

### DeepSeek 示例

选择一种 API 格式，并将示例 Key 替换成你自己的密钥。

OpenAI 兼容格式：

```sh
export AG2CLI_PROTOCOL=openai
export AG2CLI_API_KEY="your-deepseek-api-key"
export AG2CLI_BASE_URL=https://api.deepseek.com
export AG2CLI_MODEL=deepseek-flash
```

或 Anthropic 兼容格式：

```sh
export AG2CLI_PROTOCOL=anthropic
export AG2CLI_API_KEY="your-deepseek-api-key"
export AG2CLI_BASE_URL=https://api.deepseek.com/anthropic
export AG2CLI_MODEL=deepseek-flash
```

## 在仓库中运行

从要处理的仓库目录启动 ag2cli。当前目录会作为工作区。

```sh
cd /path/to/your/repository
ag2cli
```

默认启动 TUI，也可以显式运行 `ag2cli tui`。

首屏会同时绘制工作区标识、输入行与底部状态栏（示意，有节选）：

```text
  >_ AG2CLI
     /path/to/your/repository

› █

deepseek-flash · ⏸ manual · idle
```

在 `›` 输入行直接输入消息；`@` 提及与 `/` 命令在输入时补全。

## Headless 单次运行

在当前仓库中执行一次非交互、只读任务：

```sh
ag2cli run "概括这个仓库的主要模块和入口。" --permission-mode plan --format text
```

## 启动 Serve 并配对 Web 客户端

在要处理的仓库目录中启动本地服务。先在该终端设置 DeepSeek 环境变量，再添加一个私有随机 token，并在配对时复用它。

```sh
export AG2CLI_SERVER_TOKEN="替换为私有随机 token"
export AG2CLI_SERVER_REQUIRE_AUTH=1
ag2cli serve
```

在第二个终端进入 ag2cli 源码目录并启动 Web 客户端：

```sh
cd /path/to/ag2cli
bun run web
```

打开 `http://127.0.0.1:5173`。在第三个终端设置相同的服务端 token，并创建短时配对链接：

```sh
export AG2CLI_SERVER_TOKEN="替换为与服务端相同的私有随机 token"
ag2cli pair ws://127.0.0.1:8787/app-server --client web
```

将生成的链接粘贴到 Web 客户端的连接设置中。链接短时有效且只能使用一次，请像凭据一样保管。

## 贡献

> [!NOTE]
> 暂不接受外部贡献。

## 许可证

本仓库代码采用 **GNU Affero General Public License v3（GNU AGPLv3）** 许可，详见 [`LICENSE`](LICENSE)。
