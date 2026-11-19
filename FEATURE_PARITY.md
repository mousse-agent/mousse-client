# Mousse Mobile feature parity

| Electron GUI surface | Mobile client | MMS method family / adaptation |
| --- | --- | --- |
| Server connection and owner approval | Full | Discovery, dynamic registration, external browser OAuth + PKCE |
| Projects and thread lifecycle | Full core | `projects.*`, `threads.*`, `thread.snapshot` |
| Chat streaming, tool events, steering, retries, stop | Full core | SSE plus `orchestrator.*`, `queue.*` |
| Pending questions | Full core | `orchestrator.answerQuestions`, `orchestrator.dismissQuestions` |
| Agents and tasks | Full core | `agents.*`, `tasks.*`, `mousseAgent.*` |
| Workspace state, undo, redo, fork and publish | Full core | `workspace.*`, `actions.*`, `operations.*`, `publish.*` |
| File read/write and Git | Full core | `files.*`, `git.*`; paths are server-relative |
| Terminal | Full core | `pty.*`; native terminal is represented by remote PTY controls |
| Scheduled jobs | Full core | `scheduled.*` |
| Personal bots | Full remote | `bots.*` (chat, cards, held action reviews, quick-reply asks/questions/reminders, slash commands, Find in chat, presence/tasks/menu/memory/About sheets, per-permission switches, rename/look, empty-page mascot). Computer-only features (`bots.model.*`, `bots.files.*`, `bots.browser.*`, `bots.chat.react`, `secrets.*`, applets, prompt/device/delete/clear/forget/reset) are not exposed remotely by MMS |
| Channel activity/configuration | Full core | `channels.*` |
| Providers, MCP, skills and settings | Full core | `providers.*`, `mcp.*`, `skills.*`, `settings.*`; credentials remain write-only |
| Offline/reconnect and event replay | Full | Reconnecting SSE, last event ID, reset snapshot reload, lifecycle suspension |
| Browser tabs / native browser view | Not applicable | System browser is used for OAuth only |
| Electron windows, titlebar, restart, OS dialogs | Clearly unavailable | Intentionally excluded by the MMS protocol |
| Local Mousse folder / named pipe IPC | Not applicable | Client uses HTTP only |

Some advanced operations are server-version/capability dependent. The client sends the documented method to MMS and reports a structured server error when a method or scope is unavailable.
