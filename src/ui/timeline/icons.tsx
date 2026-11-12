// Timeline icons, under the desktop's names and with the same Hugeicons as
// mousse/src/renderer/lib/icons.tsx (Stroke Rounded, stroke 1.5).
import { forwardRef, type ForwardRefExoticComponent, type RefAttributes } from 'react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import ArrowDown02Icon from '@hugeicons/core-free-icons/ArrowDown02Icon'
import Atom01Icon from '@hugeicons/core-free-icons/Atom01Icon'
import Attachment01Icon from '@hugeicons/core-free-icons/Attachment01Icon'
import Brain01Icon from '@hugeicons/core-free-icons/Brain01Icon'
import BubbleChatQuestionIcon from '@hugeicons/core-free-icons/BubbleChatQuestionIcon'
import CancelCircleIcon from '@hugeicons/core-free-icons/CancelCircleIcon'
import Copy01Icon from '@hugeicons/core-free-icons/Copy01Icon'
import Edit02Icon from '@hugeicons/core-free-icons/Edit02Icon'
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon'
import File02Icon from '@hugeicons/core-free-icons/File02Icon'
import FileAddIcon from '@hugeicons/core-free-icons/FileAddIcon'
import FileScriptIcon from '@hugeicons/core-free-icons/FileScriptIcon'
import Folder01Icon from '@hugeicons/core-free-icons/Folder01Icon'
import FolderSearchIcon from '@hugeicons/core-free-icons/FolderSearchIcon'
import GitBranchIcon from '@hugeicons/core-free-icons/GitBranchIcon'
import Globe02Icon from '@hugeicons/core-free-icons/Globe02Icon'
import Image01Icon from '@hugeicons/core-free-icons/Image01Icon'
import InformationCircleIcon from '@hugeicons/core-free-icons/InformationCircleIcon'
import Logout01Icon from '@hugeicons/core-free-icons/Logout01Icon'
import PlugIcon from '@hugeicons/core-free-icons/PlugIcon'
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon'
import SparklesIcon from '@hugeicons/core-free-icons/SparklesIcon'
import Task01Icon from '@hugeicons/core-free-icons/Task01Icon'
import TerminalIcon from '@hugeicons/core-free-icons/TerminalIcon'
import TextWrapIcon from '@hugeicons/core-free-icons/TextWrapIcon'
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import ViewIcon from '@hugeicons/core-free-icons/ViewIcon'
import VolumeHighIcon from '@hugeicons/core-free-icons/VolumeHighIcon'
import Wrench01Icon from '@hugeicons/core-free-icons/Wrench01Icon'
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon'
import Link01Icon from '@hugeicons/core-free-icons/Link01Icon'
import ComputerIcon from '@hugeicons/core-free-icons/ComputerIcon'
import Robot01Icon from '@hugeicons/core-free-icons/Robot01Icon'
import BubbleChatIcon from '@hugeicons/core-free-icons/BubbleChatIcon'

export interface TimelineIconProps {
  size?: number
  className?: string
}

export type TimelineIcon = ForwardRefExoticComponent<TimelineIconProps & RefAttributes<SVGSVGElement>>

function icon(name: string, svg: IconSvgElement): TimelineIcon {
  const Component = forwardRef<SVGSVGElement, TimelineIconProps>(function TimelineIconView({ size = 18, className = '' }, ref) {
    return <HugeiconsIcon ref={ref} icon={svg} size={size} strokeWidth={1.5} aria-hidden data-icon-library="hugeicons" className={`mousse-icon ${className}`.trim()} />
  })
  Component.displayName = name
  return Component
}

export const ArrowDown = /* @__PURE__ */ icon('ArrowDown', ArrowDown02Icon)
export const Brain = /* @__PURE__ */ icon('Brain', Brain01Icon)
export const Check = /* @__PURE__ */ icon('Check', Tick02Icon)
export const ChevronDown = /* @__PURE__ */ icon('ChevronDown', ArrowDown01Icon)
export const ChevronRight = /* @__PURE__ */ icon('ChevronRight', ArrowRight01Icon)
export const CircleX = /* @__PURE__ */ icon('CircleX', CancelCircleIcon)
export const ClipboardList = /* @__PURE__ */ icon('ClipboardList', Task01Icon)
export const Copy = /* @__PURE__ */ icon('Copy', Copy01Icon)
export const Eye = /* @__PURE__ */ icon('Eye', ViewIcon)
export const FileCode = /* @__PURE__ */ icon('FileCode', FileScriptIcon)
export const FilePlus = /* @__PURE__ */ icon('FilePlus', FileAddIcon)
export const FileText = /* @__PURE__ */ icon('FileText', File02Icon)
export const Folder = /* @__PURE__ */ icon('Folder', Folder01Icon)
export const FolderSearch = /* @__PURE__ */ icon('FolderSearch', FolderSearchIcon)
export const GitBranch = /* @__PURE__ */ icon('GitBranch', GitBranchIcon)
export const Globe = /* @__PURE__ */ icon('Globe', Globe02Icon)
export const Image = /* @__PURE__ */ icon('Image', Image01Icon)
export const Info = /* @__PURE__ */ icon('Info', InformationCircleIcon)
export const Link = /* @__PURE__ */ icon('Link', Link01Icon)
export const Logout = /* @__PURE__ */ icon('Logout', Logout01Icon)
export const MessageQuestion = /* @__PURE__ */ icon('MessageQuestion', BubbleChatQuestionIcon)
export const MessageSquare = /* @__PURE__ */ icon('MessageSquare', BubbleChatIcon)
export const Monitor = /* @__PURE__ */ icon('Monitor', ComputerIcon)
export const Pencil = /* @__PURE__ */ icon('Pencil', Edit02Icon)
export const Paperclip = /* @__PURE__ */ icon('Paperclip', Attachment01Icon)
export const Plug = /* @__PURE__ */ icon('Plug', PlugIcon)
export const Bot = /* @__PURE__ */ icon('Bot', Robot01Icon)
export const Search = /* @__PURE__ */ icon('Search', Search01Icon)
export const Sparkles = /* @__PURE__ */ icon('Sparkles', SparklesIcon)
export const Terminal = /* @__PURE__ */ icon('Terminal', TerminalIcon)
export const TextWrap = /* @__PURE__ */ icon('TextWrap', TextWrapIcon)
export const VolumeHigh = /* @__PURE__ */ icon('VolumeHigh', VolumeHighIcon)
export const Wrench = /* @__PURE__ */ icon('Wrench', Wrench01Icon)
export const X = /* @__PURE__ */ icon('X', Cancel01Icon)

/**
 * The thinking icon (Hugeicons Atom 01), as the desktop's ThinkingIcon: its own SVG so the centre
 * circle and the orbits are separate, and only the orbits turn while `active` (timeline.css).
 */
export function ThinkingIcon({ size = 18, active = false, className = '' }: TimelineIconProps & { active?: boolean }) {
  const [centre, ...orbits] = Atom01Icon as unknown as Array<[string, Record<string, string>]>
  const draw = ([tag, { key, ...attrs }]: [string, Record<string, string>]) => {
    const shape = { ...attrs, stroke: 'currentColor', strokeWidth: 1.5 }
    return tag === 'circle' ? <circle key={key} {...shape} /> : <path key={key} {...shape} />
  }
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      data-icon-library="hugeicons"
      data-thinking={active ? 'active' : 'done'}
      className={`mousse-icon m-thinking-icon${active ? ' is-thinking' : ''} ${className}`.trim()}
    >
      {draw(centre!)}
      <g className="m-thinking-icon__orbit">{orbits.map(draw)}</g>
    </svg>
  )
}
