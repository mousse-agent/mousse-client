export interface ShaderCost {
  /** How many copies of each function `main` ends up with once every call is inlined. */
  copies: Record<string, number>
  total: { statements: number; tokens: number }
}
export function shaderSource(text: string): string
export function shaderCost(src: string): ShaderCost
