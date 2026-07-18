import { Hero } from "./Hero";
import { LiveRail } from "./LiveRail";
import { ArticlesGrid } from "./ArticlesGrid";
import { AiCta } from "./AiCta";
import { CreatorsRow } from "./CreatorsRow";
import { Section } from "./parts";

/**
 * Discover / Home — the premium landing dashboard mounted at `/`.
 * A hero band, a live-now rail, fresh articles, an AI CTA, and a
 * creators-to-watch row, each loading independently and animating in.
 */
export default function HomeFeature() {
  return (
    <div className="space-y-10 pb-4">
      <Section delay={0}>
        <Hero />
      </Section>
      <Section delay={80}>
        <LiveRail />
      </Section>
      <Section delay={160}>
        <ArticlesGrid />
      </Section>
      <Section delay={240}>
        <AiCta />
      </Section>
      <Section delay={320}>
        <CreatorsRow />
      </Section>
    </div>
  );
}
