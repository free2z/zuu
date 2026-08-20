import {
  useMemo,
  useState,
  type ImgHTMLAttributes,
  type ReactNode,
} from "react";
import { EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MEDIA_BASE } from "@/lib/env";
import { mediaUrl } from "@/lib/api/http";
import {
  normalizeRemoteMediaTarget,
  type RemoteMediaTarget,
} from "@/lib/media/remote-media-policy";
import { cn } from "@/lib/utils";

export type RemoteMediaKind = "image" | "audio" | "video";

function documentBase(): string {
  if (MEDIA_BASE) return `${MEDIA_BASE}/`;
  if (typeof window !== "undefined") return window.location.href;
  // SSR/static-markup tests need a syntactically valid base. Production
  // builds always have MEDIA_BASE; this value is never used for a request.
  return "https://zuuli.invalid/";
}

/** Resolve a backend-relative or authored media source without requesting it. */
export function resolveRemoteMediaSource(
  source: string,
): RemoteMediaTarget | null {
  const resolved = mediaUrl(source);
  if (!resolved) return null;
  // Production MEDIA_BASE is HTTPS. Make protocol-relative authored media
  // deterministic in the HTTP Vite harness too instead of ever consenting an
  // insecure third-party request merely because the test document is HTTP.
  const candidate = resolved.startsWith("//") ? `https:${resolved}` : resolved;
  return normalizeRemoteMediaTarget(candidate, documentBase());
}

/**
 * One-item consent boundary for creator-selected network media.
 *
 * Consent is bound to this component instance AND the exact canonical URL.
 * Changing `source` can therefore never reuse consent from the previous item,
 * even for a single render. Nothing is persisted in storage or shared through
 * context.
 */
export function RemoteMedia({
  source,
  kind,
  className,
  children,
}: {
  source: string;
  kind: RemoteMediaKind;
  className?: string;
  children: (target: RemoteMediaTarget) => ReactNode;
}) {
  const target = useMemo(() => resolveRemoteMediaSource(source), [source]);
  const [consentedUrl, setConsentedUrl] = useState<string | null>(null);

  if (!target) {
    return (
      <span
        data-remote-media-blocked
        className={cn(
          "flex min-h-24 w-full min-w-0 items-center justify-center rounded-lg border border-border bg-muted/40 px-3 py-4 text-center text-sm text-muted-foreground",
          className,
        )}
        role="status"
      >
        Media blocked
      </span>
    );
  }

  if (consentedUrl === target.url) {
    return (
      <span
        data-remote-media-loaded
        data-remote-media-host={target.hostname}
        className={cn("block min-w-0", className)}
      >
        {children(target)}
      </span>
    );
  }

  return (
    <span
      data-remote-media-consent
      data-remote-media-host={target.hostname}
      className={cn(
        "flex min-h-24 w-full min-w-0 flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border border-border bg-muted/40 px-3 py-4 text-center",
        className,
      )}
      role="group"
      aria-label={`Remote ${kind} from ${target.hostname}`}
    >
      <EyeOff className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 max-w-full break-all text-xs text-muted-foreground">
        {target.hostname}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-tap h-12 min-h-12 max-w-full"
        aria-label={`Load ${kind} from ${target.hostname}`}
        onClick={(event) => {
          // Some article cards use the loaded image as a navigation link. Keep
          // this first consent click scoped to media, never route navigation.
          event.preventDefault();
          event.stopPropagation();
          setConsentedUrl(target.url);
        }}
      >
        Load {kind}
      </Button>
    </span>
  );
}

export function RemoteImage({
  src,
  containerClassName,
  alt = "",
  ...imageProps
}: {
  src: string;
  containerClassName?: string;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "referrerPolicy">) {
  return (
    <RemoteMedia source={src} kind="image" className={containerClassName}>
      {({ url }) => (
        <img
          {...imageProps}
          src={url}
          alt={alt}
          referrerPolicy="no-referrer"
        />
      )}
    </RemoteMedia>
  );
}
