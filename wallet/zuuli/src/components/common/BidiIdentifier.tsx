import { truncateAddress } from "@/lib/format";
import type { ComponentPropsWithoutRef } from "react";

export interface BidiIdentifierProps
  extends Omit<
    ComponentPropsWithoutRef<"bdi">,
    "children" | "dir" | "title"
  > {
  /** The complete opaque identifier. It is always preserved in the title. */
  value: string;
  /** Shorten the visible value in the middle while preserving its tail. */
  shorten?: boolean;
  head?: number;
  tail?: number;
}

/**
 * Isolate an opaque, left-to-right identifier from surrounding localized text.
 *
 * Deliberately does not accept `children`, `dir`, or `title`: callers provide
 * the authoritative value once, and this boundary owns all three renderings.
 */
export function BidiIdentifier({
  value,
  shorten = false,
  head,
  tail,
  ...props
}: BidiIdentifierProps) {
  return (
    <bdi {...props} dir="ltr" title={value}>
      {shorten ? truncateAddress(value, head, tail) : value}
    </bdi>
  );
}
