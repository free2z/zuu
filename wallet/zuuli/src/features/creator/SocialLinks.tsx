import {
  Facebook,
  Github,
  Instagram,
  Link2,
  Linkedin,
  Send,
  Twitter,
  Youtube,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SocialLink } from "@/lib/utils/bio";

/** Branded icons are used only after the parser proves an unambiguous profile
 * namespace as well as the platform's exact host boundary. */
const BRANDED_ICONS: Record<SocialLink["key"], LucideIcon> = {
  twitter: Twitter,
  github: Github,
  instagram: Instagram,
  youtube: Youtube,
  facebook: Facebook,
  linkedin: Linkedin,
  reddit: Link2,
  telegram: Send,
  mastodon: Link2,
  nostr: Zap,
  website: Link2,
};

export function CreatorSocialLinks({
  creatorName,
  socials,
}: {
  creatorName: string;
  socials: SocialLink[];
}) {
  if (socials.length === 0) return null;

  return (
    <div className="creator-profile-inset mt-4 flex flex-wrap gap-2">
      {socials.map((social) => {
        const branded = social.trust === "branded";
        const Icon = branded ? BRANDED_ICONS[social.key] : Link2;
        return (
          <a
            key={social.key}
            href={social.url}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={
              branded
                ? `${creatorName} on ${social.label}`
                : `${creatorName} link to ${social.destinationHost}`
            }
            data-social-trust={social.trust}
            data-destination-host={social.destinationHost}
            className="min-tap inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/40 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            <span
              className={branded ? undefined : "font-semibold text-foreground"}
            >
              {social.display}
            </span>
          </a>
        );
      })}
    </div>
  );
}
