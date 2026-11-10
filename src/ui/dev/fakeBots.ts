// Bots for the demo build (VITE_FAKE_CONNECTION=1) and the UI tests: two bots with a chat each, an
// open ask, a piece of work, and replies that arrive a moment after a message.
import type { BotChatMessage, BotChatPage, BotDetail, BotLook, ComputerBots, ListBot } from '../../connection/bots'

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

interface FakeBot { bot: ListBot; messages: BotChatMessage[] }

function initialBots(): FakeBot[] {
  return [
    {
      bot: {
        id: 'bot-inbox', name: 'Pip', description: 'Sorts my inbox every morning and tells me what needs me.',
        look: { colour: 'teal', accessory: 'headphones' }, state: 'needs_you', stateText: 'Wants to read your Gmail',
        last: { text: 'I need to read your Gmail to sort it.', at: minutesAgo(12), author: 'bot' }, unread: 1, createdAt: minutesAgo(60 * 24 * 3),
      },
      messages: [
        { seq: 1, id: 'm1', at: minutesAgo(60 * 24 * 3), author: 'bot', kind: 'text', text: "Hi! I'm **Pip**. Each morning at 8 I'll sort your inbox and tell you what needs you.", chips: [{ icon: 'name', text: 'Picked a name', highlight: 'Pip' }] },
        { seq: 2, id: 'm2', at: minutesAgo(15), author: 'owner', kind: 'text', text: 'Can you start today?', chips: [] },
        {
          seq: 3, id: 'm3', at: minutesAgo(12), author: 'bot', kind: 'text', text: 'Sure. I need to read your Gmail to sort it, so I asked.',
          chips: [{ icon: 'schedule', text: 'Scheduled', highlight: 'every day · 08:00' }, { icon: 'ask', text: 'Asked for', highlight: 'Gmail' }],
          ask: { askId: 'ask-1', title: 'read your Gmail', note: 'Only reading. It can’t send or delete mail.', status: 'open' },
          replyTo: { id: 'm2', author: 'owner', text: 'Can you start today?' },
        },
      ],
    },
    {
      bot: {
        id: 'bot-release', name: 'Juno', description: 'Watches the Mousse nightly and tells me when it breaks.',
        look: { colour: 'purple', accessory: 'goggles', kind: 'mousse', eyes: 'star' }, state: 'working', stateText: 'Working on Check tonight’s nightly',
        last: { text: 'Checking the nightly now.', at: minutesAgo(3), author: 'bot' }, unread: 0, createdAt: minutesAgo(60 * 24 * 9),
        work: [{ id: 'act-9', title: 'Check tonight’s nightly', status: 'running', startedAt: minutesAgo(4) }],
      },
      messages: [
        { seq: 1, id: 'r1', at: minutesAgo(5), author: 'owner', kind: 'text', text: 'Did the nightly pass?', chips: [] },
        { seq: 2, id: 'r2', at: minutesAgo(3), author: 'bot', kind: 'text', text: 'Checking the nightly now. I’ll tell you here when I know.', chips: [{ icon: 'think', text: 'Started work', highlight: 'Check tonight’s nightly' }] },
        { seq: 3, id: 'r0', at: minutesAgo(60 * 20), author: 'bot', kind: 'run_report', text: '**Nightly 20261110 passed.** 2,814 tests, 0 failures. The Windows build took 4 minutes longer than usual.', chips: [{ icon: 'web', text: 'Read', highlight: 'github.com' }] },
      ].sort((a, b) => a.at.localeCompare(b.at)).map((message, index) => ({ ...message, seq: index + 1 })) as BotChatMessage[],
    },
  ]
}

export class FakeBots implements ComputerBots {
  private readonly bots = initialBots()
  private seq = 100
  /** Every message sent, for tests. */
  readonly sent: Array<{ botId: string; text: string; replyTo?: string }> = []

  constructor(private readonly changed: () => void, private readonly replyMs = 1200) {}

  list(): ListBot[] {
    return this.bots.map((entry) => ({ ...entry.bot }))
  }

  private find(botId: string): FakeBot {
    const entry = this.bots.find((candidate) => candidate.bot.id === botId)
    if (!entry) throw new Error('This bot was deleted.')
    return entry
  }

  private push(entry: FakeBot, message: Omit<BotChatMessage, 'seq' | 'id' | 'at'>): BotChatMessage {
    const full: BotChatMessage = { ...message, seq: ++this.seq, id: `fm-${this.seq}`, at: new Date().toISOString() }
    entry.messages.push(full)
    entry.bot = { ...entry.bot, last: { text: full.text, at: full.at, author: full.author } }
    return full
  }

  async chat(botId: string): Promise<BotChatPage> {
    const entry = this.find(botId)
    return { messages: [...entry.messages], ...(entry.bot.chat && entry.bot.activity ? { live: { activationId: entry.bot.chat.activationId, chip: entry.bot.activity } } : {}) }
  }

  async send(botId: string, text: string, replyTo?: string): Promise<BotChatMessage> {
    const entry = this.find(botId)
    this.sent.push({ botId, text, ...(replyTo ? { replyTo } : {}) })
    const quoted = replyTo ? entry.messages.find((message) => message.id === replyTo) : undefined
    const message = this.push(entry, { author: 'owner', kind: 'text', text, chips: [], ...(quoted ? { replyTo: { id: quoted.id, author: quoted.author, text: quoted.text.split('\n')[0] } } : {}) })
    entry.bot = { ...entry.bot, state: 'working', stateText: 'Working…', chat: { activationId: `chat-${this.seq}` }, activity: { icon: 'think', text: 'Thinking' } }
    this.changed()
    setTimeout(() => {
      if (!entry.bot.chat) return
      this.push(entry, { author: 'bot', kind: 'text', text: `On it. I noted “${text.slice(0, 60)}” and I’ll report back here.`, chips: [{ icon: 'memory', text: 'Remembered', highlight: 'your request' }], replyTo: { id: message.id, author: 'owner', text } })
      const { chat: _chat, activity: _activity, ...rest } = entry.bot
      entry.bot = { ...rest, state: entry.bot.work?.length ? 'working' : 'idle', stateText: '', lastOutcome: 'ok' }
      this.changed()
    }, this.replyMs)
    return message
  }

  async stop(botId: string): Promise<void> {
    const entry = this.find(botId)
    const { chat: _chat, activity: _activity, ...rest } = entry.bot
    entry.bot = { ...rest, state: entry.bot.work?.length ? 'working' : 'idle', lastOutcome: 'stopped' }
    this.changed()
  }

  async stopWork(botId: string, workId: string): Promise<void> {
    const entry = this.find(botId)
    const work = (entry.bot.work ?? []).filter((item) => item.id !== workId)
    entry.bot = { ...entry.bot, work, ...(work.length || entry.bot.chat ? {} : { state: 'idle' as const, stateText: '' }) }
    this.changed()
  }

  async markRead(botId: string): Promise<void> {
    const entry = this.find(botId)
    if (!entry.bot.unread) return
    entry.bot = { ...entry.bot, unread: 0 }
    this.changed()
  }

  async answer(botId: string, askId: string, answer: 'allow' | 'not_now'): Promise<BotChatMessage> {
    const entry = this.find(botId)
    const index = entry.messages.findIndex((message) => message.ask?.askId === askId)
    if (index < 0) throw new Error('This ask was already answered.')
    const updated = { ...entry.messages[index], ask: { ...entry.messages[index].ask!, status: answer === 'allow' ? 'allowed' as const : 'not_now' as const } }
    entry.messages[index] = updated
    entry.bot = { ...entry.bot, state: 'idle', stateText: '' }
    this.changed()
    return updated
  }

  async get(botId: string): Promise<BotDetail> {
    const entry = this.find(botId)
    return {
      summary: { ...entry.bot },
      permissions: [{ id: 'p1', title: 'search the web', note: 'Only reading pages.', grantedAt: entry.bot.createdAt }],
      runs: botId === 'bot-inbox' ? [{ id: 's1', label: 'every day · 08:00', nextAt: minutesAgo(-600), kind: 'schedule' }] : [],
    }
  }

  async pause(botId: string): Promise<ListBot> {
    const entry = this.find(botId)
    entry.bot = { ...entry.bot, state: 'paused', stateText: 'Paused' }
    this.changed()
    return { ...entry.bot }
  }

  async resume(botId: string): Promise<ListBot> {
    const entry = this.find(botId)
    entry.bot = { ...entry.bot, state: 'idle', stateText: '' }
    this.changed()
    return { ...entry.bot }
  }

  async create(input: { look: BotLook; description: string; name?: string }): Promise<ListBot> {
    const id = `bot-${++this.seq}`
    const name = input.name?.trim() || 'Nova'
    const entry: FakeBot = { bot: { id, name, description: input.description, look: input.look, state: 'idle', stateText: '', unread: 1, createdAt: new Date().toISOString() }, messages: [] }
    this.bots.push(entry)
    this.push(entry, { author: 'bot', kind: 'text', text: `Hi, I'm **${name}**. ${input.description} Tell me when to start.`, chips: [{ icon: 'name', text: 'Picked a name', highlight: name }] })
    this.changed()
    return { ...entry.bot }
  }
}
