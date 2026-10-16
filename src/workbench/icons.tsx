import type { CSSProperties } from 'react';

export type IconName = 'book' | 'plus' | 'chevron' | 'arrow' | 'settings' | 'export' | 'spark' | 'chat' | 'close' | 'check' | 'heart' | 'flag' | 'quiet' | 'play' | 'pause' | 'clock' | 'history' | 'search' | 'folder' | 'leaf' | 'stop';
const paths: Record<IconName, React.ReactNode> = {
  book: <><path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Z"/><path d="M12 6v14"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,
  export: <><path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5"/></>,
  spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/></>,
  chat: <path d="M21 11a8 8 0 0 1-8 8H8l-5 3V11a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  check: <path d="m4 12 5 5L20 6"/>,
  heart: <path d="M20.2 5.8a5 5 0 0 0-7.1 0L12 7l-1.1-1.2a5 5 0 0 0-7.1 7.1L12 21l8.2-8.1a5 5 0 0 0 0-7.1Z"/>,
  flag: <><path d="M5 21V4c5-4 9 4 14 0v10c-5 4-9-4-14 0"/></>,
  quiet: <><path d="m6 9 4-4v14l-4-4H3V9h3ZM15 9l6 6m0-6-6 6"/></>,
  play: <path d="m8 4 12 8-12 8V4Z"/>,
  pause: <path d="M8 5v14M16 5v14"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  history: <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l4 2"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  folder: <path d="M3 6h7l2 3h9v11H3V6Z"/>,
  leaf: <><path d="M20 3C8 2 2 8 5 15c3 7 16 3 15-12Z"/><path d="m4 21 10-12"/></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
};
export function Icon({ name, size = 18, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} style={style}>{paths[name]}</svg>;
}
