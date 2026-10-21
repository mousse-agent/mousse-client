// The desktop's provider marks (mousse/src/renderer/lib/providerIcons.tsx), from the same SVG assets.
const ASSET_URLS = import.meta.glob('../assets/provider-icons/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>

function asset(name: string): string | undefined {
  return ASSET_URLS[`../assets/provider-icons/${name}.svg`]
}

/** Icon name → asset file; monochrome marks follow the text color through a CSS filter. */
const ASSETS: Record<string, { file: string; monochrome?: boolean }> = {
  antgroup: { file: 'antgroup-color' },
  anthropic: { file: 'anthropic', monochrome: true },
  claude: { file: 'claude', monochrome: true },
  aws: { file: 'aws-color' },
  azure: { file: 'azure-color' },
  baseten: { file: 'baseten', monochrome: true },
  cerebras: { file: 'cerebras-color' },
  cloudflare: { file: 'cloudflare-color' },
  cohere: { file: 'cohere-color' },
  copilot: { file: 'copilot-color' },
  cursor: { file: 'cursor', monochrome: true },
  deepseek: { file: 'deepseek-color' },
  fireworks: { file: 'fireworks-color' },
  github: { file: 'github', monochrome: true },
  google: { file: 'google-color' },
  groq: { file: 'groq', monochrome: true },
  huggingface: { file: 'huggingface-color' },
  kimi: { file: 'kimi-color' },
  meta: { file: 'meta-color' },
  minimax: { file: 'minimax-color' },
  mistral: { file: 'mistral-color' },
  moonshot: { file: 'moonshot', monochrome: true },
  nvidia: { file: 'nvidia-color' },
  openai: { file: 'openai', monochrome: true },
  opencode: { file: 'opencode', monochrome: true },
  'opencode-go': { file: 'opencode', monochrome: true },
  openrouter: { file: 'openrouter-color' },
  qwen: { file: 'qwen-color' },
  together: { file: 'together-color' },
  vercel: { file: 'vercel', monochrome: true },
  xai: { file: 'xai', monochrome: true },
  xiaomi: { file: 'xiaomimimo', monochrome: true },
  zai: { file: 'zai', monochrome: true },
  zhipu: { file: 'zhipu-color' }
}

export function normalizeProviderId(providerId: string): string {
  const id = providerId.toLowerCase()
  if (id === 'claude' || id === 'claude-subscription') return 'claude'
  if (id.includes('anthropic')) return 'anthropic'
  if (id.includes('ant-ling') || id.includes('antling')) return 'antgroup'
  if (id.includes('azure')) return 'azure'
  if (id.includes('openai')) return 'openai'
  if (id.includes('opencode-go')) return 'opencode-go'
  if (id.includes('opencode')) return 'opencode'
  if (id.includes('google') || id.includes('gemini') || id.includes('vertex')) return 'google'
  if (id.includes('amazon') || id.includes('bedrock')) return 'aws'
  if (id.includes('baseten')) return 'baseten'
  if (id.includes('cerebras')) return 'cerebras'
  if (id.includes('cloudflare')) return 'cloudflare'
  if (id.includes('copilot') || id.includes('github')) return 'copilot'
  if (id.includes('fireworks')) return 'fireworks'
  if (id.includes('huggingface')) return 'huggingface'
  if (id.includes('kimi')) return 'kimi'
  if (id.includes('minimax')) return 'minimax'
  if (id.includes('moonshot')) return 'moonshot'
  if (id.includes('nvidia')) return 'nvidia'
  if (id.includes('openrouter')) return 'openrouter'
  if (id.includes('deepseek')) return 'deepseek'
  if (id.includes('xai') || id.includes('grok')) return 'xai'
  if (id.includes('mistral')) return 'mistral'
  if (id.includes('groq')) return 'groq'
  if (id.includes('meta') || id.includes('llama')) return 'meta'
  if (id.includes('cohere')) return 'cohere'
  if (id.includes('qwen')) return 'qwen'
  if (id.includes('together')) return 'together'
  if (id.includes('vercel')) return 'vercel'
  if (id.includes('xiaomi')) return 'xiaomi'
  if (id.includes('zhipu') || id.includes('glm')) return 'zhipu'
  if (id === 'zai' || id.startsWith('zai-') || id.includes('z-ai')) return 'zai'
  if (id.includes('cursor')) return 'cursor'
  return id
}

function GenericProviderIcon({ size }: { size: number }) {
  return (
    <svg className="m-provider-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 3.5v6M20.5 12h-6M12 20.5v-6M3.5 12h6" />
    </svg>
  )
}

export function ProviderIcon({ providerId, size = 14 }: { providerId: string; size?: number }) {
  const entry = ASSETS[normalizeProviderId(providerId)]
  const src = entry && asset(entry.file)
  if (!entry || !src) return <GenericProviderIcon size={size} />
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      aria-hidden
      className={`m-provider-icon${entry.monochrome ? ' m-provider-icon--mono' : ''}`}
    />
  )
}
