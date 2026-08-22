import { Hero } from "./Hero";
import { LiveRail } from "./LiveRail";
import { ArticlesGrid } from "./ArticlesGrid";
import { AiCta } from "./AiCta";
import { CreatorsRow } from "./CreatorsRow";
import { Section } from "./parts";

/**
 * Discover / Home — the premium landing dashboard mounted at `/`.
 * A hero band, a live-now rail, fresh articles, an AI CTA, and a
 * creators-to-watch row, each loading independently and settling in with a
 * short, small entrance (suppressed entirely under prefers-reduced-motion).
 */
export default function HomeFeature() {
  return (
    <div className="space-y-10 pb-4">
      <Section delay={0}>
        <Hero />
      </Section>
      <Section delay={40}>
        <LiveRail />
      </Section>
      <Section delay={80}>
        <ArticlesGrid />
      </Section>
      <Section delay={120}>
        <AiCta />
      </Section>
      <Section delay={160}>
        <CreatorsRow />
      </Section>
    </div>
  );
}
