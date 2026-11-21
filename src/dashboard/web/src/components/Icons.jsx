const paths = {
  status: <><path d="M4 13.5 9 18 20 6" /><path d="M4 6h5" /><path d="M4 10h3" /></>,
  console: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3" /><path d="M12 15h5" /></>,
  messages: <><path d="M20 15a3 3 0 0 1-3 3H9l-5 3v-6a3 3 0 0 1-1-2V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3Z" /><path d="M7 8h8" /><path d="M7 12h5" /></>,
  groups: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2" /><path d="M3 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2" /><path d="M15 13h2a4 4 0 0 1 4 4v2" /></>,
  admin: <><path d="M4 7h10" /><path d="M18 7h2" /><path d="M4 17h2" /><path d="M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /><path d="M4 12h16" /></>,
  review: <><path d="M6 3h12v18H6z" /><path d="M9 8h6" /><path d="M9 12h6" /><path d="m9 17 2 2 4-4" /></>,
  model: <><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 9h6v6H9z" /><path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" /></>,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  play: <><path d="m8 5 11 7-11 7Z" /></>,
  arrow: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
  local: <><path d="M12 3 4 7v5c0 5 3.5 8 8 9 4.5-1 8-4 8-9V7Z" /><path d="m8 12 3 3 5-6" /></>,
}

export default function Icon({ name, size = 18, className = '' }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name] || paths.status}
    </svg>
  )
}

export function BrandMark() {
  return (
    <svg className="brand-mark" width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true">
      <path d="M5 20.5 13 8l5 8 7-6" />
      <circle cx="5" cy="20.5" r="2.5" />
      <circle cx="13" cy="8" r="2.5" />
      <circle cx="18" cy="16" r="2.5" />
      <circle cx="25" cy="10" r="2.5" />
    </svg>
  )
}
