// Character guard for tool action arguments and labels, ported from mousse/src/shared/bots/personal/modelSlots.ts.

function hiddenChar(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  )
}

/** One character policy, with the label's replacement rules and data's script-safe rules. */
export function guardTextCharacters(text: string, mode: 'label' | 'data' | 'address' = 'data'): string {
  return [...text]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0
      if (mode === 'label') return hiddenChar(code) ? ' ' : char
      const joiner = code === 0x200c || code === 0x200d
      const preserve = code === 9 || code === 10 || code === 13 || (joiner && mode !== 'address')
      const hidden =
        (!preserve && hiddenChar(code)) ||
        code === 0xad ||
        code === 0x34f ||
        code === 0x180e ||
        code === 0x115f ||
        code === 0x1160 ||
        code === 0x3164 ||
        code === 0xffa0 ||
        (code >= 0x2060 && code <= 0x2064) ||
        (code >= 0xfff9 && code <= 0xfffb) ||
        (code >= 0xe0000 && code <= 0xe007f)
      return hidden ? '\uFFFD' : char
    })
    .join('')
}
