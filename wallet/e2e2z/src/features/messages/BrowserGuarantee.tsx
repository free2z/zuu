// The browser build's standing statement of its weaker guarantee (§11.1), and
// the durability notice that goes with no-ACK mode (§11.2).
//
// §11.1 makes this a hard product constraint rather than a nicety: it must be
// visible and persistent, in the messaging UI, at the point where someone
// decides whether to have a sensitive conversation — not in a footer and not in
// a help page.

import { ShieldAlert, ShieldQuestion } from "lucide-react";
import { Callout } from "../../components/ui/callout";
import type { DeviceInfo } from "../../lib/messaging/types";

export function BrowserGuarantee({ device }: { device: DeviceInfo }) {
  if (device.platform !== "browser") return null;

  const durable = device.durability === "durable";

  return (
    <div className="space-y-4">
      <Callout
        tone="warning"
        icon={ShieldQuestion}
        title="In a browser, this protection depends on the server being honest right now"
      >
        A browser downloads the program that does the encryption from the same
        party the encryption protects you against, every time the page loads. A
        server that was compelled to target you could send you a modified
        program, and nothing on your side would show it. ZUULI, the signed app,
        is fetched once and can be checked independently, so the strong claims
        are made there. For a conversation where that matters, use ZUULI.
      </Callout>

      {!durable && (
        <Callout
          tone="warning"
          icon={ShieldAlert}
          title="This browser cannot promise to keep your messages"
        >
          Browser storage can be cleared without warning, so this tab does not
          confirm receipt of anything. Your messages stay on the relay instead
          and are deleted when they expire there, usually after seven days.
          Anything you have not opened in ZUULI or another device by then is
          gone. Your queue also fills up, and once it is full people cannot send
          to you — and they are not told why.
        </Callout>
      )}
    </div>
  );
}
