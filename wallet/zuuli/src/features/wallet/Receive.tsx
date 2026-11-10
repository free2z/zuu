import { useTranslation as useUiTranslation } from "react-i18next";
import { MESSAGE_KEYS } from "@/i18n/messages";
// Receive: large QR of the unified address with copy + shielded receipt note.
import { QRCodeSVG } from "qrcode.react";
import { ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BidiIdentifier } from "@/components/common/BidiIdentifier";
import { useWallet } from "@/store/wallet";
import { CopyButton } from "./shared";

export function Receive() {
  const { t: uiT } = useUiTranslation();

  const address = useWallet((s) => s.unifiedAddress);

  return (
    <div className="mx-auto max-w-md">
      <Card className="rounded-xl">
        <CardContent className="flex flex-col items-center gap-6 p-8 text-center">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">
              {uiT(MESSAGE_KEYS.featuresWalletReceiveReceiveZEC)}
            </h2>
            <p className="text-sm text-muted-foreground">
              {uiT(
                MESSAGE_KEYS.featuresWalletReceiveShareThisUnifiedAddressToGetPaid,
              )}
            </p>
          </div>

          {address ? (
            <div className="rounded-2xl bg-white p-4">
              <QRCodeSVG
                value={address}
                size={224}
                bgColor="#ffffff"
                fgColor="#1a1206"
                level="M"
                aria-label={uiT(
                  MESSAGE_KEYS.featuresWalletReceiveUnifiedAddressQRCode,
                )}
              />
            </div>
          ) : (
            <Skeleton className="h-[256px] w-[256px] rounded-2xl" />
          )}

          {address ? (
            <div className="w-full space-y-3">
              <BidiIdentifier
                value={address}
                className="mono-id block break-all rounded-lg border border-border bg-background/40 p-3 font-mono text-xs text-foreground"
              />
              <CopyButton
                value={address}
                size="sm"
                label={uiT(MESSAGE_KEYS.featuresWalletReceiveAddressCopied)}
                ariaLabel={uiT(
                  MESSAGE_KEYS.featuresWalletReceiveCopyUnifiedAddress,
                )}
                className="w-full"
              />
            </div>
          ) : (
            <Skeleton className="h-9 w-full" />
          )}

          <p className="flex items-start gap-2 text-start text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-zec" />
            {uiT(
              MESSAGE_KEYS.featuresWalletReceiveUnifiedAddressesReceiveShieldedZECAndSupport,
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
