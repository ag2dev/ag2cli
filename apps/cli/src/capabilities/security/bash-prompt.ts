/** Model-facing safety instructions for BashTool. */

export const BASH_SECURITY_PROMPT = [
  "# Shell commands",
  "The Bash tool executes its command field with /bin/bash --noprofile --norc -c under the host user's permissions; it is not sandboxed. The runtime decides whether a command is allowed, requires approval, or is denied using the Session permission mode, explicit rules, and prepared command facts.",
  "Do not pass credentials, tokens, .env or .git paths, SSH paths, or cloud credential paths as Bash arguments.",
  "The runtime checks Bash's working directory, but command arguments are not confined by file-tool path policy. Never use Bash to retry a file write denied by a dedicated file tool; use a path admitted by workspace policy or report the denial.",
  "Do not bypass command policy through environment variables, relative paths, Git revision:path syntax, or argument encoding.",
].join("\n")
