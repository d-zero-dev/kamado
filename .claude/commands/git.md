---
description: Git manipulation rules
---

# Commit creation

- When asked to "commit":
  1. Check staged files using `git diff --staged` and create a commit message using _only_ the staged files.
     - Once the message is ready, directly propose the commit command to the user.
  2. If no files are staged, check the differences using `git status`, then stage files sequentially based on the following commit granularity before committing:
     - Separate commits by package.
     - Commit dependencies first (if dependency order is unclear, check using `npx lerna list --graph`).
- If the OS, application settings, or context suggest a language other than English is being used, provide a translation and explanation of the commit message in that language immediately before proposing the commit command to the user.
- When the commit message is ready, try to execute it directly as `git commit` (the user will approve as appropriate).

# Commit message format

- You must write in English
- You must use the imperative mood
- You must use conventional commits
  - You must use the following types:
    - `feat`
    - `fix`
    - `docs`
    - `refactor`
    - `test`
    - `chore`
  - You must use the following scopes:
    - Each package name (without namespace)
    - `repo`
    - `deps`
    - `github`
- The message body's lines must not be longer than 100 characters
- The subject must not be sentence-case, start-case, pascal-case, upper-case

# Commit message safety guidelines

- For breaking changes or complex commit messages, ALWAYS use heredoc format (see below)
- For simple, single-line commits, use single quotes (')
- NEVER use multiple -m flags for breaking changes (causes commitlint parse errors)

## Heredoc Format (REQUIRED for Breaking Changes)

Use heredoc with command substitution to pass multi-line commit messages. This ensures:
- Special characters like `!` are preserved correctly
- Multi-line messages are properly formatted
- commitlint can parse the message correctly

**Format:**
```bash
git commit -m "$(cat <<'EOF'
type(scope)!: subject line

BREAKING CHANGE: Rename all compiler-related types and functions

Type renames:
- OldName -> NewName
- Another -> Change

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
EOF
)"
```

**Important notes:**
- Use `<<'EOF'` (with quotes) to prevent variable expansion
- Close with `)` after `EOF` to complete command substitution
- Do NOT use multiple `-m` flags for breaking changes
- The entire message must be wrapped in `"$(cat <<'EOF' ... EOF)"`

## Simple Commits (Non-Breaking)

For simple, single-line commits without breaking changes:
```bash
git commit -m 'type(scope): subject line'
```

For multi-line non-breaking commits, use heredoc format as well to ensure proper formatting
