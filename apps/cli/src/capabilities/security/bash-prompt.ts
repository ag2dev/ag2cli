/** Model-facing safety instructions for BashTool. */

export const BASH_SECURITY_PROMPT = [
  "The Bash tool accepts only a command string and always runs it with /bin/bash --noprofile --norc -c. Commands run directly with the host user's permissions and are not sandboxed. Authorization is determined entirely by the Session permission mode (full-access allows commands automatically; other modes require user approval). Canonical events record preparation, approval, and execution facts.",
  "Prefer dedicated file tools (read_file, glob, grep) for simple, clear, read-only queries. Use Bash only when shell syntax needs to be combined.",
  "Prefer dedicated file tools to read and modify files. Do not pass credentials, tokens, .env or .git paths, SSH paths, or cloud credential paths as Bash arguments.",
  "Any command may wait for user approval. Approval does not bypass workspace path boundaries.",
  "Do not bypass command policy through environment variables, relative paths, Git revision:path syntax, or argument encoding.",
].join("\n")
