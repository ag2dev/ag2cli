<p align="center"><strong>AG2CLI</strong></p>
<h1 align="center">Agent to CLI</h1>
<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

> **Development status:** AG2CLI is in an early, fast-moving stage. Features, configuration, and behavior may change; stability and backward compatibility are not guaranteed.

AG2CLI is a coding agent CLI harness: interactive TUI, headless runs, or a long-running server. Built by AG2DEV.

## Build and install

Build a standalone executable from source. Bun is needed to build; the resulting CLI does not require Bun to run. The release archive includes `ag2cli` and its `rg` helper, which should stay side by side.

Requirements: Git, Bun 1.3.14 or newer, and macOS / Linux / Windows WSL2 on x64 / arm64.

If Bun is not installed, install the repository's pinned version:

```sh
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

These exports make Bun available in the current terminal. Add them to your shell startup configuration if you want them in new terminals.

```sh
git clone https://github.com/ag2dev/ag2cli.git
cd ag2cli
bun install
release_dir="$(mktemp -d)"
# Build into a fresh directory, then install both files from the archive.
AG2CLI_RELEASE_OUTDIR="$release_dir" bun run build:cli
mkdir -p "$HOME/.local/bin"
tar -xzf "$release_dir"/ag2cli-*.tar.gz -C "$release_dir"
install -m 755 "$release_dir/ag2cli" "$release_dir/rg" "$HOME/.local/bin/"
rm -rf "$release_dir"
export PATH="$HOME/.local/bin:$PATH"
ag2cli --version
```

Add the `PATH` export to your shell startup configuration to keep it in new terminals. The executable and `rg` helper must remain in the same directory.

## Configure a model provider

AG2CLI connects to a provider endpoint that you choose. Get the API key, base URL, and exact model ID from that provider. `AG2CLI_PROTOCOL` selects the API format, not the vendor:

- `openai` for an OpenAI Chat Completions-compatible endpoint.
- `anthropic` for an Anthropic Messages-compatible endpoint.

Protocol compatibility does not guarantee identical feature support across providers or models. Check the provider's documentation for tool calling, context limits, and model-specific options. API keys are read from environment variables; do not commit them. These exports apply only to the current shell.

```sh
export AG2CLI_PROTOCOL=openai # choose openai or anthropic
export AG2CLI_BASE_URL=https://your-provider.example.com
export AG2CLI_API_KEY="your-api-key"
export AG2CLI_MODEL=your-model-id
```

### DeepSeek example

Choose one API format and replace the example key with your own.

OpenAI-compatible:

```sh
export AG2CLI_PROTOCOL=openai
export AG2CLI_API_KEY="your-deepseek-api-key"
export AG2CLI_BASE_URL=https://api.deepseek.com
export AG2CLI_MODEL=deepseek-flash
```

Or Anthropic-compatible:

```sh
export AG2CLI_PROTOCOL=anthropic
export AG2CLI_API_KEY="your-deepseek-api-key"
export AG2CLI_BASE_URL=https://api.deepseek.com/anthropic
export AG2CLI_MODEL=deepseek-flash
```

## Run in a repository

Start ag2cli from the repository you want to work on. Its current directory becomes the workspace.

```sh
cd /path/to/your/repository
ag2cli
```

The TUI starts by default. You can also run `ag2cli tui` explicitly.

```text
workspace: /path/to/your/repository
model: deepseek-flash
type a message, @ to mention, / for commands

❯ Summarize this repository's purpose and main entry points.
```

## Headless run

Run one non-interactive, read-only task from the current repository:

```sh
ag2cli run "Summarize the main modules and entry points in this repository." --permission-mode plan --format text
```

## Serve and pair a Web client

From the repository you want to work on, start a local server in one terminal. Set the DeepSeek variables in that shell, then add a private random token and reuse that token for pairing.

```sh
export AG2CLI_SERVER_TOKEN="replace-with-a-private-random-token"
export AG2CLI_SERVER_REQUIRE_AUTH=1
ag2cli serve
```

In a second terminal, start the Web client from the ag2cli checkout:

```sh
cd /path/to/ag2cli
bun run web
```

Open `http://127.0.0.1:5173`. In a third terminal, set the same server token and create a short-lived pairing link:

```sh
export AG2CLI_SERVER_TOKEN="replace-with-the-same-private-random-token"
ag2cli pair ws://127.0.0.1:8787/app-server --client web
```

Paste the generated link into the Web client's connection settings. The link is short-lived and single-use; treat it like a credential.

## Contributing

> [!NOTE]
> External contributions are not accepted.

## License

Code in this repository is licensed under the **GNU Affero General Public License, Version 3 (AGPLv3)** — see [`LICENSE`](LICENSE).
