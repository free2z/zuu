import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";

interface QrScannerProps {
  onScan: (data: string) => void;
  onClose: () => void;
}

export function QrScanner({ onScan, onClose }: QrScannerProps) {
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const scannerId = "qr-reader";
    let scanner: Html5Qrcode | null = null;

    const startScanner = async () => {
      try {
        scanner = new Html5Qrcode(scannerId);
        await scanner.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          (decodedText) => {
            if (!mountedRef.current) return;
            runningRef.current = false;
            scanner?.stop().catch(() => {});
            onScan(decodedText);
          },
          () => {},
        );
        runningRef.current = true;
      } catch (err) {
        if (!mountedRef.current) return;
        runningRef.current = false;
        const msg =
          err instanceof DOMException && err.name === "NotAllowedError"
            ? "Camera permission denied. Grant camera access in your system settings to scan QR codes."
            : typeof err === "string"
              ? err
              : "Camera access denied or unavailable";
        setError(msg);
      }
    };

    startScanner();

    return () => {
      mountedRef.current = false;
      if (runningRef.current && scanner) {
        runningRef.current = false;
        scanner.stop().catch(() => {});
      }
    };
  }, [onScan]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="w-full max-w-sm mx-4">
        <div className="bg-zinc-900 rounded-2xl overflow-hidden border border-zinc-800">
          <div className="flex items-center justify-between p-4">
            <h3 className="text-white font-semibold">Scan QR Code</h3>
            <button
              onClick={onClose}
              className="text-zinc-400 hover:text-white transition-colors"
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
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div id="qr-reader" className="w-full" />

          {error && (
            <div className="p-4 text-center">
              <p className="text-red-400 text-sm mb-3">{error}</p>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm border border-zinc-700 text-zinc-300 rounded-lg hover:bg-zinc-800 transition-colors"
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
