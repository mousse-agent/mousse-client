// A demo thread with one of every timeline row the desktop shows, for the fake connection,
// screenshots and visual checks: ?signedIn&screen=thread:node-studio:t-showcase
import type { ChatItem, PendingQuestions } from '../../connection/types'

export const SHOWCASE_THREAD_ID = 't-showcase'

const PNG_DOT =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAAA8CAIAAAAWtijjAAAAZElEQVR42u3QAQ0AAAgDoKc1jIHMZwFnAjYSkK7hEQWCBAkSJEiQIEEIEiRIkCBBggQhSJAgQYIECRKEIEGCBAkSJEiQIAQJEiRIkCBBghAkSJAgQYIECUKQIEGCBAkSJEgQtwX1thks7rXe/gAAAABJRU5ErkJggg=='

export function showcaseItems(base: number): ChatItem[] {
  const t = (minutes: number) => base - minutes * 60_000
  return [
    {
      id: 's-u1',
      role: 'user',
      kind: 'message',
      text: 'The relay drops reconnects after a laptop sleeps. Find out why and fix it.',
      createdAt: t(42),
      status: 'done',
      images: [{ name: 'trace.png', mimeType: 'image/png', data: PNG_DOT }],
      files: ['relay.log'],
      references: [{ kind: 'file', title: 'relay.ts', path: 'src/net/relay.ts' }, { kind: 'thread', title: 'Relay reconnect backoff' }],
    },
    { id: 's-th1', role: 'assistant', kind: 'thinking', text: '**Tracing the reconnect path**\n\nThe log shows `ECONNRESET` right after resume, then no retry.', createdAt: t(41.8), status: 'done' },
    {
      id: 's-gr1',
      role: 'tool',
      kind: 'tool',
      text: '',
      createdAt: t(41.6),
      status: 'done',
      toolName: 'Grep',
      tool: { name: 'Grep', title: 'Grep', summary: '', details: [], input: { pattern: 'reconnect' }, output: 'src/net/relay.ts\nsrc/net/session.ts\ntests/net/link.test.ts' },
    },
    {
      id: 's-rd1',
      role: 'tool',
      kind: 'tool',
      text: '',
      createdAt: t(41.5),
      status: 'done',
      toolName: 'Read',
      tool: { name: 'Read', title: 'Read', summary: '', details: [], input: { file_path: '/home/ada/code/mousse/src/net/relay.ts' } },
    },
    {
      id: 's-bs1',
      role: 'tool',
      kind: 'tool',
      text: '',
      createdAt: t(41.2),
      status: 'done',
      toolName: 'Bash',
      tool: { name: 'Bash', title: 'Run', summary: '', details: [], input: { command: 'npm test -- tests/net/link.test.ts' }, output: { stdout: ' ✓ link (12 tests)\n × reconnects after sleep\n\nTests  1 failed | 11 passed', exitCode: 1, durationMs: 2400 } },
    },
    {
      id: 's-ed1',
      role: 'tool',
      kind: 'tool',
      text: '',
      createdAt: t(40),
      status: 'done',
      toolName: 'Edit',
      tool: {
        name: 'Edit',
        title: 'Edit',
        summary: '',
        details: [],
        input: {
          file_path: '/home/ada/code/mousse/src/net/relay.ts',
          old_string: 'function onClose(code: number) {\n  if (code === 1000) return\n  schedule(delay)\n}',
          new_string: 'function onClose(code: number) {\n  if (code === 1000 && !resumed) return\n  // A sleeping laptop closes sockets with 1006; retry from the first step.\n  schedule(resumed ? 0 : delay)\n}',
        },
      },
    },
    {
      id: 's-wr1',
      role: 'tool',
      kind: 'tool',
      text: '',
      createdAt: t(39.5),
      status: 'done',
      toolName: 'Write',
      tool: { name: 'Write', title: 'Write', summary: '', details: [], input: { file_path: '/home/ada/code/mousse/tests/net/resume.test.ts', content: "import { it } from 'vitest'\n\nit('reconnects after resume', async () => {\n  // …\n})\n" } },
    },
    {
      id: 's-a1',
      role: 'assistant',
      kind: 'message',
      text:
        'Found it. After a sleep the socket closes with **1006**, but `onClose` treated a clean close as final and never reset the backoff.\n\n' +
        '| Close code | Before | After |\n|:--|:--|:--|\n| 1000 | stop | stop unless resumed |\n| 1006 | wait 30s | retry now |\n\n' +
        '```ts\nschedule(resumed ? 0 : delay)\n```\n\n' +
        '- [x] Reproduce with a test\n- [x] Fix the close handler\n- [ ] Ship it\n\nSee [the WebSocket close codes](https://developer.mozilla.org/docs/Web/API/CloseEvent/code).',
      createdAt: t(38),
      status: 'done',
      meta: { modelName: 'claude-opus', totalResponseTimeMs: 238_000, tokensUsed: 18_420, tokensPerSecond: 61.3 },
    },
    { id: 's-u2', role: 'user', kind: 'message', text: 'Plan the follow-up: backoff jitter and a status pill.', createdAt: t(30), status: 'done' },
    { id: 's-ho', role: 'system', kind: 'handoff', text: '', createdAt: t(29.9), status: 'done', handoff: { from: 'openai / gpt-5', to: 'anthropic / claude-opus' } },
    {
      id: 's-td',
      role: 'tool',
      kind: 'tool',
      text: '',
      createdAt: t(29.8),
      status: 'done',
      toolName: 'TodoWrite',
      tool: {
        name: 'TodoWrite',
        title: 'Todo',
        summary: '',
        details: [],
        input: {
          todos: [
            { content: 'Add jitter to the backoff', status: 'completed' },
            { content: 'Show a reconnecting pill', status: 'in_progress' },
            { content: 'Document the close codes', status: 'pending' },
          ],
        },
      },
    },
    {
      id: 's-tk',
      role: 'tool',
      kind: 'tool',
      text: '',
      createdAt: t(29.5),
      status: 'done',
      toolName: 'Task',
      tool: { name: 'Task', title: 'Task', summary: '', details: [], input: { description: 'Survey reconnect UX in other apps', subagent_type: 'researcher', prompt: 'Look at how chat apps show reconnecting.' }, output: [{ type: 'text', text: '## Findings\n\nMost apps show a small **Reconnecting…** pill and retry silently.\n\n- Slack: a banner after 10 s\n- Discord: a pill at the top' }, { type: 'text', text: 'agentId: a1b2 (for resuming)' }] },
    },
    {
      id: 's-tk2',
      role: 'tool',
      kind: 'tool',
      text: '',
      createdAt: t(29.45),
      status: 'error',
      toolName: 'Task',
      tool: { name: 'Task', title: 'Task', summary: '', details: [], input: { description: 'Measure reconnect time on Android', subagent_type: 'general-purpose' }, output: 'No Android device is attached to this computer.' },
    },
    { id: 's-tk:1', role: 'tool', kind: 'tool', text: '', createdAt: t(29.4), status: 'done', toolName: 'WebSearch', tool: { name: 'WebSearch', title: '', summary: '', details: [], input: { query: 'reconnecting indicator chat app' }, output: { results: [{ title: 'Slack connection status' }, { title: 'Discord reconnect banner' }] } } },
    { id: 's-tk:2', role: 'tool', kind: 'tool', text: '', createdAt: t(29.3), status: 'done', toolName: 'Read', tool: { name: 'Read', title: '', summary: '', details: [], input: { file_path: 'notes/ux.md' } } },
    {
      id: 's-mcp',
      role: 'tool',
      kind: 'tool',
      text: '',
      createdAt: t(29.2),
      status: 'done',
      toolName: 'Mcp',
      tool: { name: 'Mcp', rawName: 'list_issues', server: 'github', title: 'list_issues', summary: '', details: [], input: { repo: 'mousse', query: 'reconnect' }, output: [{ type: 'text', text: '[{"number":112,"title":"Relay drops after sleep"}]' }] },
    },
    { id: 's-wn', role: 'system', kind: 'warning', text: 'The context is 82% full. Older tool results may be summarized.', createdAt: t(29.1), status: 'done' },
    { id: 's-cc', role: 'system', kind: 'compaction', text: 'Summarized 41 earlier messages.', createdAt: t(29), status: 'done' },
    {
      id: 's-pl',
      role: 'assistant',
      kind: 'plan',
      text: '',
      createdAt: t(28),
      status: 'done',
      plan: {
        title: 'Backoff jitter and a reconnecting pill',
        markdown: '## Goal\nReconnects feel instant after sleep and never stampede the relay.\n\n## Steps\n1. Add ±20% jitter to `schedule()`.\n2. Show a **Reconnecting…** pill in the top bar.\n3. Cover both with tests.\n\n## Risks\n- Jitter makes tests flaky unless the clock is injected.',
      },
    },
    {
      id: 's-ap1',
      role: 'assistant',
      kind: 'message',
      text: 'Here is the backoff curve to try out.\n\nThe logo for scale:',
      createdAt: t(27.5),
      status: 'done',
      parts: [
        { type: 'text', text: 'Here is the backoff curve to try out.' },
        {
          type: 'applet',
          applet: {
            appletId: 'applet_backoff',
            revisionId: 'rev_1',
            title: 'Backoff curve',
            description: 'Drag the jitter to see each retry delay.',
            source: {
              schemaVersion: 1,
              title: 'Backoff curve',
              description: 'Drag the jitter to see each retry delay.',
              html: "<label>Jitter <input id='j' type='range' min='0' max='50' value='20'> <output id='o'></output></label><ol id='l'></ol>",
              css: 'main,body{padding:12px;font:14px system-ui;color:var(--text-primary)}input{width:100%}li{margin:4px 0}',
              js: "const j=document.getElementById('j'),o=document.getElementById('o'),l=document.getElementById('l');function u(){o.textContent=j.value+'%';l.innerHTML='';for(let i=0;i<5;i++){const b=500*2**i;const li=document.createElement('li');li.textContent=Math.round(b*(1-j.value/100))+'–'+Math.round(b*(1+j.value/100))+' ms';l.appendChild(li)}window.mousseApplet.resize(document.body.scrollHeight)}j.addEventListener('input',u);u();",
              stateVersion: 1,
            },
          },
        },
        { type: 'text', text: `The logo for scale:\n\n![Mousse logo](${typeof location === 'undefined' ? 'https://mousse.work' : location.origin}/mousse-logo.svg)` },
      ],
    },
    {
      id: 's-a2',
      role: 'assistant',
      kind: 'message',
      text: 'The relay refused the request.',
      createdAt: t(27),
      status: 'error',
      error: { message: 'Provider returned 429: rate limited. Try again in a minute.', code: 'rate_limited' },
    },
  ]
}

export function showcaseQuestions(): PendingQuestions[] {
  return [
    {
      requestId: 'showcase-q1',
      questions: [
        { id: 'pill', prompt: 'Where should the reconnecting pill go?', options: [{ id: 'top', label: 'Top bar' }, { id: 'composer', label: 'Above the composer' }] },
        { id: 'tests', prompt: 'Which tests should run before merging?', allowMultiple: true, options: [{ id: 'unit', label: 'Unit' }, { id: 'link', label: 'Link' }, { id: 'e2e', label: 'End to end' }] },
      ],
    },
    { requestId: 'showcase-q2', questions: [{ id: 'approval', prompt: 'Run `npm run release` on the computer?', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] }] },
  ]
}

/** A thread with a turn still running, for the live states: ?signedIn&screen=thread:node-studio:t-showcase-live */
export const SHOWCASE_LIVE_THREAD_ID = 't-showcase-live'

export function showcaseLiveItems(base: number): ChatItem[] {
  const t = (seconds: number) => base - seconds * 1000
  const call = (id: string, at: number, name: string, input: Record<string, unknown>, extra: Partial<ChatItem> = {}): ChatItem => ({
    id,
    role: 'tool',
    kind: 'tool',
    text: '',
    createdAt: t(at),
    status: 'done',
    toolName: name,
    tool: { name, title: name, summary: '', details: [], input },
    ...extra,
  })
  return [
    { id: 'l-u1', role: 'user', kind: 'message', text: 'Run the link tests and fix what fails.', createdAt: t(40), status: 'done' },
    { id: 'l-th1', role: 'assistant', kind: 'thinking', text: '**Finding the tests**\n\nThe link tests live under tests/net.', createdAt: t(38), status: 'done' },
    call('l-gl', 36, 'Glob', { pattern: 'tests/net/*.test.ts' }, { tool: { name: 'Glob', title: 'Glob', summary: '', details: [], input: { pattern: 'tests/net/*.test.ts' }, output: 'tests/net/link.test.ts\ntests/net/resume.test.ts' } }),
    call('l-rd', 34, 'Read', { file_path: 'tests/net/link.test.ts' }),
    { id: 'l-n1', role: 'assistant', kind: 'message', text: 'Both test files are small. Running them now.', createdAt: t(30), status: 'done' },
    call('l-tk', 25, 'Task', { description: 'Check the relay logs for 1006 closes', subagent_type: 'Explore' }, { status: 'streaming' }),
    call('l-tk2', 24, 'Task', {}, { status: 'streaming' }),
    call('l-bs', 20, 'Bash', { command: 'npm test -- tests/net' }, { status: 'streaming', tool: { name: 'Bash', title: 'Bash', summary: '', details: [], input: { command: 'npm test -- tests/net' }, output: { stdout: ' ✓ link (12 tests)\n ✓ resume (3 tests)\n' } } }),
  ]
}
