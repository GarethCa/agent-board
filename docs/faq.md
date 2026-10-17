# FAQ

**Does agent-board need my API keys, or spend tokens of its own?**
No. It starts your own `claude` and `codex` through your login shell, with their own logins, settings and models. It never sees an Anthropic or OpenAI key. Its test suite runs on fake CLIs and spends no tokens at all.

**Does it read my terminal to know what an agent is doing?**
No. Each session it starts reports its state through the CLIs' own hooks, to a daemon on your machine ([ADR-0004](adr/0004-agent-telemetry.md)). Nothing leaves your machine except what your CLIs and `gh` already send.

**What happens to my sessions when I close the app?**
They keep running. A background process, `agent-board daemon`, owns them, and the app reconnects when it opens. After a reboot, their tiles keep their last output and offer **Resume**, which picks the conversation up where it stopped (an agent that never got one starts fresh).

**Where does it put my code?**
Each agent works in its own git worktree under `~/.agent-board/worktrees/`, on its own branch, so agents never trip over each other or your checkout.

**Does it approve things for my agents?**
No. It does what the CLIs do and no more: permission prompts wait for you, in the inbox or the terminal. Edge conditions that run a command run only after you approve that exact command ([ADR-0009](adr/0009-edge-condition-approvals.md)).

**Linux or Windows?**
macOS is the supported platform today. The end-to-end tests pass on Linux, but it is not packaged yet; Windows comes later.

**Is it made by Anthropic or OpenAI?**
No. agent-board is an independent project, not affiliated with or endorsed by either.
