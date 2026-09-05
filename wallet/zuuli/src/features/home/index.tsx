import { Hero } from "./Hero";
import { VaultActions } from "./VaultActions";
import { Section } from "./parts";

/**
 * Home — the vault overview mounted at `/`.
 *
 * Until #904 this route was a discovery dashboard: a live-now rail, an article
 * grid, an AI call to action and a creators row, every one of them rendering
 * remote copy and remote images inside the WebView that holds the seed. Those
 * rails moved to `wallet/free2z` and are deleted here rather than hidden — a
 * surface that still exists is a surface a confused frame can reach (#367).
 *
 * What is left is authored entirely by this app: the account greeting, the two
 * balances, and the wallet destinations they lead to.
 */
export default function HomeFeature() {
  return (
    <div className="space-y-10 pb-4">
      <Section delay={0}>
        <Hero />
      </Section>
      <Section delay={40}>
        <VaultActions />
      </Section>
    </div>
  );
}
