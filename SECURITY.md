# Security policy

## Supported versions

agent-board is alpha. Only the latest release gets security fixes.

## Reporting a vulnerability

Please don't report vulnerabilities in public issues, pull requests or discussions.

Report them privately through GitHub's [private vulnerability reporting](https://github.com/GarethCa/agent-board/security/advisories/new) (the repo's **Security** tab, then **Report a vulnerability**). If that isn't available to you, contact the maintainer, [@GarethCa](https://github.com/GarethCa), privately using the contact details on their GitHub profile.

Please include:

- what an attacker can do, and what they need first (local access, a malicious repo, a crafted hook payload…)
- steps to reproduce, or a proof of concept
- the commit you tested, and your OS

You'll get an acknowledgement within a week. Once a fix is merged we'll publish an advisory and credit you, unless you'd rather not be named.

## What's in scope

agent-board runs coding agents with your local credentials, so we're particularly interested in:

- anything that lets another local user or process reach the daemon's socket or its localhost hook endpoint, or forge a session's hook token
- a repo, branch name, issue or hook payload that can make agent-board run commands, write outside its worktree, or answer a permission prompt you didn't approve
- secrets (tokens, tracker credentials) leaking into logs, the database or exported board config

Vulnerabilities in Claude Code or Codex themselves should go to Anthropic or OpenAI.
