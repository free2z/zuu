import { useEffect, useRef, useState } from "react";
import QrScannerLib from "qr-scanner";

interface QrScannerProps {
  onScan: (data: string) => void;
  onClose: () => void;
}

export function QrScanner({ onScan, onClose }: QrScannerProps) {
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScannerLib | null>(null);

  // Escape key handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const scanner = new QrScannerLib(
      video,
      (result) => {
        scanner.stop();
        onScan(result.data);
      },
      {
        preferredCamera: "environment",
        highlightScanRegion: true,
        highlightCodeOutline: true,
        maxScansPerSecond: 10,
      },
    );
    scannerRef.current = scanner;

    scanner.start().catch((err) => {
      const msg =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Camera permission denied. Grant camera access in your system settings to scan QR codes."
          : typeof err === "string"
            ? err
            : "Camera access denied or unavailable";
      setError(msg);
    });

    return () => {
      scanner.destroy();
      scannerRef.current = null;
    };
  }, [onScan]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="QR code scanner"
    >
      <div className="w-full max-w-sm mx-4">
        <div className="bg-zinc-900 rounded-2xl overflow-hidden border border-zinc-800">
          <div className="flex items-center justify-between p-4">
            <h3 className="text-white font-semibold">Scan QR Code</h3>
            <button
              onClick={onClose}
              className="p-2.5 text-zinc-400 hover:text-white transition-colors min-tap flex items-center justify-center"
              aria-label="Close QR scanner"
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div className="relative w-full aspect-square overflow-hidden bg-black">
            <video ref={videoRef} className="w-full h-full object-cover" />
          </div>

          {error && (
            <div className="p-4 text-center">
              <p className="text-red-400 text-sm mb-3">{error}</p>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm border border-zinc-700 text-zinc-300 rounded-lg hover:bg-zinc-800 transition-colors min-tap"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
