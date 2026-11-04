import logoOutlineSvg from '../assets/mousse_logo_icon_outline.svg?raw'

/** The desktop's outline logo (mousse/src/renderer/components/MousseLogoOutline.tsx); it takes the text colour. */
export function MousseLogoOutline({ className }: { className?: string }) {
  return <div className={className} role="img" aria-label="Mousse" dangerouslySetInnerHTML={{ __html: logoOutlineSvg }} />
}
