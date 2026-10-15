<p align="center"><strong>AG2CLI</strong></p>
<h1 align="center">Agent to CLI</h1>
<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

> **开发阶段：** 项目仍处于早期并快速迭代中，功能、配置和使用方式可能随时变化；当前版本不作稳定性和后向兼容承诺。

AG2CLI 是面向软件开发的 Coding Agent CLI Harness，提供交互式 TUI、单次 Headless 运行和长期运行的服务端。由 AG2DEV 构建。

## 从源码构建并安装

使用 Bun 从源码构建独立可执行文件。构建需要 Bun；构建完成后运行 CLI 不需要安装 Bun。发布压缩包包含 `ag2cli` 和配套的 `rg`，安装时请将它们放在同一目录。

需要 Git、Bun 1.3.14 或更高版本，以及运行于 x64 / arm64 的 macOS / Linux / Windows WSL2。

如果尚未安装 Bun，先安装项目指定的版本：

```sh
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

这两条 `export` 让当前终端找到 Bun；若希望新终端也生效，可将它们加入 shell 启动配置。

```sh
git clone https://github.com/ag2dev/ag2cli.git
cd ag2cli
bun install
release_dir="$(mktemp -d)"
# 构建到新目录，再从压缩包中安装两个文件。
bun run build:cli --outdir "$release_dir"
mkdir -p "$HOME/.local/bin"
tar -xzf "$release_dir"/ag2cli-*.tar.gz -C "$release_dir"
install -m 755 "$release_dir/ag2cli" "$release_dir/rg" "$HOME/.local/bin/"
rm -rf "$release_dir"
export PATH="$HOME/.local/bin:$PATH"
ag2cli --version
```

将 `PATH` 配置写入 shell 启动配置后，新终端也能找到命令。

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

```text
workspace: /path/to/your/repository
model: deepseek-flash
type a message, @ to mention, / for commands

❯ 概括这个仓库的用途和主要入口。
```

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
