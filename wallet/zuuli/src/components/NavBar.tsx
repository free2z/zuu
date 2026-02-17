import type { Page } from "../types";
import { useWalletStore } from "../store/wallet";

interface Props {
  currentPage: Page;
  onNavigate: (page: Page) => void;
}

const navItems: { page: Page; label: string; icon: JSX.Element }[] = [
  {
    page: "home",
    label: "Home",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
  },
  {
    page: "send",
    label: "Send",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="5 12 12 5 19 12" />
      </svg>
    ),
  },
  {
    page: "receive",
    label: "Receive",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <polyline points="19 12 12 19 5 12" />
      </svg>
    ),
  },
  {
    page: "history",
    label: "History",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    ),
  },
  {
    page: "settings",
    label: "Settings",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
  },
];

const walletIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="M16 12h.01" />
    <path d="M2 10h20" />
  </svg>
);

export function NavBar({ currentPage, onNavigate }: Props) {
  const walletStatus = useWalletStore((s) => s.walletStatus);

  return (
    <>
      {/* Desktop sidebar */}
      <nav className="hidden md:flex flex-col w-52 bg-zuuli-surface border-r border-zinc-800/50 py-6 gap-0.5 shrink-0">
        <span className="text-white font-bold text-2xl mb-2 px-6 tracking-tight">ZUULI</span>
        {walletStatus?.activeWalletName && (
          <button
            onClick={() => onNavigate("wallet-picker")}
            className="flex items-center gap-2 px-6 py-1.5 mb-6 text-xs text-zinc-500 hover:text-purple-400 transition-colors group"
          >
            {walletIcon}
            <span className="truncate">{walletStatus.activeWalletName}</span>
            {(walletStatus.walletCount ?? 0) > 1 && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 opacity-50 group-hover:opacity-100">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            )}
          </button>
        )}
        {navItems.map(({ page, label, icon }) => (
          <button
            key={page}
            onClick={() => onNavigate(page)}
            className={`flex items-center gap-3 text-left px-6 py-2.5 text-sm transition-colors relative ${
              currentPage === page
                ? "text-purple-400 bg-purple-500/5"
                : "text-zinc-400 hover:text-white hover:bg-zinc-800/50"
            }`}
          >
            {currentPage === page && (
              <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-purple-500 rounded-r" />
            )}
            {icon}
            {label}
          </button>
        ))}
      </nav>

      {/* Mobile bottom tabs */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-zuuli-surface/95 backdrop-blur-sm border-t border-zinc-800/50 flex z-50">
        {navItems.map(({ page, label, icon }) => (
          <button
            key={page}
            onClick={() => onNavigate(page)}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-[10px] transition-colors ${
              currentPage === page
                ? "text-purple-400"
                : "text-zinc-500"
            }`}
          >
            {icon}
            {label}
          </button>
        ))}
      </nav>
    </>
  );
}
