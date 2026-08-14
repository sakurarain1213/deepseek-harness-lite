# `@dsh-lite/plugin-command-allowlist`

Adds a monotonic guard for configured command tool names. Rules match the executable plus exact arguments, or a non-empty explicitly declared argument prefix. The default is deny; audit facts omit argument values.

Official Bash and PowerShell `{ command }` strings are accepted only when every whitespace-delimited token uses a conservative ASCII character set. Quotes, escapes, pipes, redirects, substitutions, variables, command separators, and newlines fail closed. The Lite shell pack supplies a narrow read-only default for `pwd`, `git status`, `git diff`, and `git log`; standalone activation without rules still denies every command.
