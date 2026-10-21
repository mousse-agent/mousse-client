// Same wrapper as mousse/src/renderer/lib/icons.tsx: Hugeicons Stroke Rounded at
// stroke 1.5, exported under the desktop's names so screens read the same.
import { forwardRef, type ForwardRefExoticComponent, type RefAttributes, type SVGProps } from 'react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import ArrowDown02Icon from '@hugeicons/core-free-icons/ArrowDown02Icon'
import ArrowUp01Icon from '@hugeicons/core-free-icons/ArrowUp01Icon'
import Attachment01Icon from '@hugeicons/core-free-icons/Attachment01Icon'
import Copy01Icon from '@hugeicons/core-free-icons/Copy01Icon'
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon'
import Edit02Icon from '@hugeicons/core-free-icons/Edit02Icon'
import GridViewIcon from '@hugeicons/core-free-icons/GridViewIcon'
import HammerIcon from '@hugeicons/core-free-icons/HammerIcon'
import Infinity01Icon from '@hugeicons/core-free-icons/Infinity01Icon'
import Navigation03Icon from '@hugeicons/core-free-icons/Navigation03Icon'
import SparklesIcon from '@hugeicons/core-free-icons/SparklesIcon'
import StarIcon from '@hugeicons/core-free-icons/StarIcon'
import Task01Icon from '@hugeicons/core-free-icons/Task01Icon'
import Image01Icon from '@hugeicons/core-free-icons/Image01Icon'
import MoreHorizontalIcon from '@hugeicons/core-free-icons/MoreHorizontalIcon'
import Add01Icon from '@hugeicons/core-free-icons/Add01Icon'
import AlertCircleIcon from '@hugeicons/core-free-icons/AlertCircleIcon'
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon'
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon'
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon'
import ArrowUp02Icon from '@hugeicons/core-free-icons/ArrowUp02Icon'
import BubbleChatIcon from '@hugeicons/core-free-icons/BubbleChatIcon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import CheckmarkCircle02Icon from '@hugeicons/core-free-icons/CheckmarkCircle02Icon'
import ComputerIcon from '@hugeicons/core-free-icons/ComputerIcon'
import CrownIcon from '@hugeicons/core-free-icons/CrownIcon'
import Folder01Icon from '@hugeicons/core-free-icons/Folder01Icon'
import InformationCircleIcon from '@hugeicons/core-free-icons/InformationCircleIcon'
import Link01Icon from '@hugeicons/core-free-icons/Link01Icon'
import Loading03Icon from '@hugeicons/core-free-icons/Loading03Icon'
import Logout01Icon from '@hugeicons/core-free-icons/Logout01Icon'
import Mail01Icon from '@hugeicons/core-free-icons/Mail01Icon'
import PinIcon from '@hugeicons/core-free-icons/PinIcon'
import QrCodeIcon from '@hugeicons/core-free-icons/QrCodeIcon'
import RefreshIcon from '@hugeicons/core-free-icons/RefreshIcon'
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon'
import Settings01Icon from '@hugeicons/core-free-icons/Settings01Icon'
import SmartPhone01Icon from '@hugeicons/core-free-icons/SmartPhone01Icon'
import SquareLock01Icon from '@hugeicons/core-free-icons/SquareLock01Icon'
import StopIcon from '@hugeicons/core-free-icons/StopIcon'
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon'
import UserCircleIcon from '@hugeicons/core-free-icons/UserCircleIcon'
import Wrench01Icon from '@hugeicons/core-free-icons/Wrench01Icon'
import BubbleChatAddIcon from '@hugeicons/core-free-icons/BubbleChatAddIcon'
import FolderLibraryIcon from '@hugeicons/core-free-icons/FolderLibraryIcon'
import FolderOpenIcon from '@hugeicons/core-free-icons/FolderOpenIcon'
import GitBranchIcon from '@hugeicons/core-free-icons/GitBranchIcon'
import MessageMultiple01Icon from '@hugeicons/core-free-icons/MessageMultiple01Icon'
import Structure01Icon from '@hugeicons/core-free-icons/Structure01Icon'
import Mic01Icon from '@hugeicons/core-free-icons/Mic01Icon'
import VolumeHighIcon from '@hugeicons/core-free-icons/VolumeHighIcon'
import Download04Icon from '@hugeicons/core-free-icons/Download04Icon'
import SquareIcon from '@hugeicons/core-free-icons/SquareIcon'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'stroke'> {
  size?: number | string
  stroke?: number | string
}

export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>

function createIcon(name: string, icon: IconSvgElement): IconComponent {
  const Component = forwardRef<SVGSVGElement, IconProps>(function AppIcon({ size = 18, stroke, strokeWidth, className = '', ...props }, ref) {
    return <HugeiconsIcon
      ref={ref}
      icon={icon}
      size={size}
      strokeWidth={strokeWidth === undefined ? (typeof stroke === 'number' ? stroke : 1.5) : Number(strokeWidth)}
      {...(typeof stroke === 'string' ? { stroke } : {})}
      aria-hidden={props['aria-label'] ? undefined : true}
      data-icon-library="hugeicons"
      className={`mousse-icon ${className}`.trim()}
      {...props}
    />
  })
  Component.displayName = name
  return Component
}

export const ArrowDown = /* @__PURE__ */ createIcon('ArrowDown', ArrowDown02Icon)
export const ChevronUp = /* @__PURE__ */ createIcon('ChevronUp', ArrowUp01Icon)
export const ClipboardList = /* @__PURE__ */ createIcon('ClipboardList', Task01Icon)
export const Copy = /* @__PURE__ */ createIcon('Copy', Copy01Icon)
export const Hammer = /* @__PURE__ */ createIcon('Hammer', HammerIcon)
export const InfinityIcon = /* @__PURE__ */ createIcon('Infinity', Infinity01Icon)
export const Image = /* @__PURE__ */ createIcon('Image', Image01Icon)
export const MoreHorizontal = /* @__PURE__ */ createIcon('MoreHorizontal', MoreHorizontalIcon)
export const LayoutGrid = /* @__PURE__ */ createIcon('LayoutGrid', GridViewIcon)
export const Paperclip = /* @__PURE__ */ createIcon('Paperclip', Attachment01Icon)
export const Pencil = /* @__PURE__ */ createIcon('Pencil', Edit02Icon)
export const Sparkles = /* @__PURE__ */ createIcon('Sparkles', SparklesIcon)
export const Star = /* @__PURE__ */ createIcon('Star', StarIcon)
export const Steer = /* @__PURE__ */ createIcon('Steer', Navigation03Icon)
export const Trash2 = /* @__PURE__ */ createIcon('Trash2', Delete02Icon)
export const ArrowUp = /* @__PURE__ */ createIcon('ArrowUp', ArrowUp02Icon)
export const Check = /* @__PURE__ */ createIcon('Check', Tick02Icon)
export const ChevronDown = /* @__PURE__ */ createIcon('ChevronDown', ArrowDown01Icon)
export const ChevronLeft = /* @__PURE__ */ createIcon('ChevronLeft', ArrowLeft01Icon)
export const ChevronRight = /* @__PURE__ */ createIcon('ChevronRight', ArrowRight01Icon)
export const CircleAlert = /* @__PURE__ */ createIcon('CircleAlert', AlertCircleIcon)
export const CircleCheck = /* @__PURE__ */ createIcon('CircleCheck', CheckmarkCircle02Icon)
export const Crown = /* @__PURE__ */ createIcon('Crown', CrownIcon)
export const Folder = /* @__PURE__ */ createIcon('Folder', Folder01Icon)
export const Info = /* @__PURE__ */ createIcon('Info', InformationCircleIcon)
export const Link2 = /* @__PURE__ */ createIcon('Link2', Link01Icon)
export const Loader2 = /* @__PURE__ */ createIcon('Loader2', Loading03Icon)
export const Lock = /* @__PURE__ */ createIcon('Lock', SquareLock01Icon)
export const LogOut = /* @__PURE__ */ createIcon('LogOut', Logout01Icon)
export const Mail = /* @__PURE__ */ createIcon('Mail', Mail01Icon)
export const MessageSquare = /* @__PURE__ */ createIcon('MessageSquare', BubbleChatIcon)
export const Monitor = /* @__PURE__ */ createIcon('Monitor', ComputerIcon)
export const Pin = /* @__PURE__ */ createIcon('Pin', PinIcon)
export const Plus = /* @__PURE__ */ createIcon('Plus', Add01Icon)
export const QrCode = /* @__PURE__ */ createIcon('QrCode', QrCodeIcon)
export const RefreshCw = /* @__PURE__ */ createIcon('RefreshCw', RefreshIcon)
export const Search = /* @__PURE__ */ createIcon('Search', Search01Icon)
export const Settings = /* @__PURE__ */ createIcon('Settings', Settings01Icon)
export const Smartphone = /* @__PURE__ */ createIcon('Smartphone', SmartPhone01Icon)
export const Stop = /* @__PURE__ */ createIcon('Stop', StopIcon)
export const User = /* @__PURE__ */ createIcon('User', UserCircleIcon)
export const Wrench = /* @__PURE__ */ createIcon('Wrench', Wrench01Icon)
export const X = /* @__PURE__ */ createIcon('X', Cancel01Icon)
// Sidebar (mousse/src/renderer/lib/icons.tsx names).
export const FolderKanban = /* @__PURE__ */ createIcon('FolderKanban', FolderLibraryIcon)
export const FolderOpen = /* @__PURE__ */ createIcon('FolderOpen', FolderOpenIcon)
export const GitBranch = /* @__PURE__ */ createIcon('GitBranch', GitBranchIcon)
export const ListTree = /* @__PURE__ */ createIcon('ListTree', Structure01Icon)
export const MessageSquarePlus = /* @__PURE__ */ createIcon('MessageSquarePlus', BubbleChatAddIcon)
export const MessagesSquare = /* @__PURE__ */ createIcon('MessagesSquare', MessageMultiple01Icon)
// Voice (dictation and read aloud).
export const Mic = /* @__PURE__ */ createIcon('Mic', Mic01Icon)
export const VolumeHigh = /* @__PURE__ */ createIcon('VolumeHigh', VolumeHighIcon)
export const Download = /* @__PURE__ */ createIcon('Download', Download04Icon)
export const Square = /* @__PURE__ */ createIcon('Square', SquareIcon)
