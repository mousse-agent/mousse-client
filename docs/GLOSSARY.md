# Glossary

Use these terms in issues, PRs, comments, and docs. If you need a term that is not here, explain it the first time it appears or use plain words instead. Add a term only when people will keep using it.

- **Daemon (MMS):** the background process (`mousse-cli service run`) that runs the Mousse Main Service. It owns agents, queues, the scheduler, and channels, and keeps running when clients quit.
- **Client:** the Electron GUI or the CLI. Clients talk to the daemon over a local socket and never run agents themselves.
- **Profile:** one person's threads, projects, schedules, channels, and settings inside an installation. Provider credentials and the model catalog are shared by all profiles.
- **Project:** a workspace directory registered in a profile.
- **Thread:** a conversation and its work history. A thread that changes a Git repository gets its own branch and worktree.
- **Turn:** one user message and the agent work it starts.
- **Run:** the saved record of a turn in the Run Engine, with its own ID. Stop, Steer, and Undo act on a run.
- **Steer:** a message sent to a turn that is still running, to change its direction.
- **Provider:** the agent backend a thread uses, such as Claude or Codex. Each provider has an adapter that translates its protocol.
- **Provider instance:** one configured provider a profile can pick, with a stable id such as `claude`, `codex` or `pi:openai`. Every caller chooses an agent by instance id and model.
- **Agent:** a model working in a thread, including any subagents it starts.
- **Workflow:** a published sequence of steps that can run from the canvas, chat, CLI, channels, or schedules.
- **Channel:** an outside chat connection, such as Telegram, Discord, or a webhook, that sends messages to Mousse and gets replies.
- **Mousse Net:** networking between Mousse installations. It covers Bridge and Spaces.
- **Bridge:** one person controlling agents on several of their own machines from one place.
- **Space:** a group chat for a project. Members add their own bots, which run on the owner's machine with the owner's keys.
- **Primary checkout:** the first entry in `git worktree list`, normally the copy the user runs and reads.
- **Mousse Plus:** the hosted service that signs people in, links their machines and phones, and relays traffic between them. Its plan sets how many computers, phones and sessions an account may use.
- **Mousse ID:** the account a person signs in with for Mousse Plus.
- **Control server:** the self-hosted alternative to Mousse Plus, for people who run the service on their own infrastructure.
- **Node:** one Mousse installation registered with an account. It signs requests with its own key.
- **Relay:** the Mousse Plus service that forwards encrypted traffic between a phone or computer and a node when they cannot connect directly. It cannot read that traffic.
- **Pairing:** linking a phone or another client to a node, by QR code or sign-in, so they can talk through the relay.
- **Team:** a group of Mousse IDs that share machines, environments and AI subscriptions. Members can use team machines without seeing every team thread.
