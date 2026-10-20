// Small building blocks. Class names and materials follow the desktop's
// polish.css (primary button, raised rows, status dots) at phone sizes.
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { Loader2, Search, X } from './icons'
import logoUrl from '../assets/mousse_logo_icon.svg'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  busy?: boolean
  block?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', busy = false, block = false, icon, className = '', children, disabled, type = 'button', ...props }, ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`m-button m-button--${variant}${block ? ' m-button--block' : ''} ${className}`.trim()}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? <Spinner size={16} /> : icon}
      {children !== undefined && <span>{children}</span>}
    </button>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  tone?: 'plain' | 'accent'
}

/** Always at least 44 x 44 so it is easy to hit with a thumb. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, tone = 'plain', className = '', children, type = 'button', ...props }, ref
) {
  return (
    <button ref={ref} type={type} aria-label={label} title={label} className={`m-icon-button m-icon-button--${tone} ${className}`.trim()} {...props}>
      {children}
    </button>
  )
})

export function Spinner({ size = 18, label }: { size?: number; label?: string }) {
  return <Loader2 size={size} className="m-spinner" role={label ? 'status' : undefined} aria-label={label} />
}

export type DotState = 'online' | 'offline' | 'running' | 'waiting' | 'error'

export function StatusDot({ state, label }: { state: DotState; label?: string }) {
  return <span className={`m-dot m-dot--${state}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />
}

export function MousseLogo({ size = 28 }: { size?: number }) {
  return <img className="m-logo" src={logoUrl} width={size} height={size} alt="" aria-hidden="true" />
}

export interface TopBarProps {
  title: ReactNode
  subtitle?: ReactNode
  leading?: ReactNode
  trailing?: ReactNode
}

export function TopBar({ title, subtitle, leading, trailing }: TopBarProps) {
  return (
    <header className="m-topbar">
      <div className="m-topbar__side">{leading}</div>
      <div className="m-topbar__title">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="m-topbar__side m-topbar__side--end">{trailing}</div>
    </header>
  )
}

export function SectionHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="m-section-heading">
      <h2>{children}</h2>
      {action}
    </div>
  )
}

export interface ListRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  leading?: ReactNode
  title: ReactNode
  detail?: ReactNode
  trailing?: ReactNode
  active?: boolean
}

export function ListRow({ leading, title, detail, trailing, active = false, className = '', type = 'button', ...props }: ListRowProps) {
  return (
    <button type={type} className={`m-row${active ? ' m-row--active' : ''} ${className}`.trim()} aria-current={active ? 'true' : undefined} {...props}>
      {leading && <span className="m-row__leading">{leading}</span>}
      <span className="m-row__body">
        <span className="m-row__title">{title}</span>
        {detail && <span className="m-row__detail">{detail}</span>}
      </span>
      {trailing && <span className="m-row__trailing">{trailing}</span>}
    </button>
  )
}

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: string
  onChange(value: string): void
}

export function SearchField({ value, onChange, placeholder = 'Search', ...props }: SearchFieldProps) {
  return (
    <div className="m-search">
      <Search size={17} className="m-search__icon" />
      <input
        type="search"
        inputMode="search"
        enterKeyHint="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...props}
      />
      {value && (
        <button type="button" className="m-search__clear" aria-label="Clear search" onClick={() => onChange('')}>
          <X size={16} />
        </button>
      )}
    </div>
  )
}

export interface SegmentedOption<T extends string> { value: T; label: ReactNode }

export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: SegmentedOption<T>[]
  value: T
  onChange(value: T): void
  label: string
}) {
  return (
    <div className="m-segmented" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className="m-segmented__option"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="m-field">
      <label className="m-field__control">
        <span className="m-field__label">{label}</span>
        {children}
      </label>
      {hint && <span className="m-field__hint">{hint}</span>}
    </div>
  )
}

export function Notice({ tone = 'error', children }: { tone?: 'error' | 'info' | 'success'; children: ReactNode }) {
  return <div className={`m-notice m-notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`m-card ${className}`.trim()}>{children}</section>
}
