// Receive: large QR of the unified address with copy + shielded receipt note.
import { QRCodeSVG } from "qrcode.react";
import { ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useWallet } from "@/store/wallet";
import { CopyButton } from "./shared";

export function Receive() {
  const address = useWallet((s) => s.unifiedAddress);

  return (
    <div className="mx-auto max-w-md">
      <Card className="rounded-xl">
        <CardContent className="flex flex-col items-center gap-6 p-8 text-center">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Receive ZEC</h2>
            <p className="text-sm text-muted-foreground">
              Share this unified address to get paid.
            </p>
          </div>

          {address ? (
            <div className="rounded-2xl bg-white p-4 shadow-glow">
              <QRCodeSVG
                value={address}
                size={224}
                bgColor="#ffffff"
                fgColor="#1a1206"
                level="M"
                aria-label="Unified address QR code"
              />
            </div>
          ) : (
            <Skeleton className="h-[256px] w-[256px] rounded-2xl" />
          )}

          {address ? (
            <div className="w-full space-y-3">
              <div className="break-all rounded-lg border border-border bg-background/40 p-3 font-mono text-xs text-foreground">
                {address}
              </div>
              <CopyButton
                value={address}
                size="sm"
                label="Address copied"
                ariaLabel="Copy unified address"
                className="w-full"
              />
            </div>
          ) : (
            <Skeleton className="h-9 w-full" />
          )}

          <p className="flex items-start gap-2 text-left text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#f4b728]" />
            Unified addresses receive shielded ZEC and support encrypted memos,
            keeping the amount and sender private on-chain.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
