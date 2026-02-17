import { useState } from "react";

interface Props {
  address: string;
  label?: string;
}

export function AddressCard({ address, label }: Props) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800/50 rounded-xl p-4">
      {label && (
        <p className="text-xs text-zinc-400 uppercase tracking-wider mb-2">
          {label}
        </p>
      )}
      <div className="flex items-start gap-2">
        <code className="text-sm text-white flex-1 break-all font-mono leading-relaxed">
          {address}
        </code>
        <button
          onClick={copyToClipboard}
          className="p-3 text-zinc-400 hover:text-purple-400 transition-colors rounded-lg hover:bg-purple-500/10 shrink-0 min-tap flex items-center justify-center"
          aria-label={copied ? "Address copied" : "Copy address to clipboard"}
        >
          {copied ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          )}
        </button>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Address copied to clipboard" : ""}
      </span>
    </div>
  );
}
