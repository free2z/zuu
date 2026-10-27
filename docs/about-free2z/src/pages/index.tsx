import React, { useEffect, useRef, useState } from "react";
import Link from "@docusaurus/Link";
import Layout from "@theme/Layout";
import HomepageFeatures from "@site/src/components/HomepageFeatures";
import Header3d from "@site/src/components/Header3d";
import styles from "./index.module.css";

const verbs = ["create", "speak", "publish", "share", "connect", "build"];

function HomepageHeader(): JSX.Element {
  const hero = useRef<HTMLElement>(null);
  const [mounted, setMounted] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [visible, setVisible] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);
  const [paused, setPaused] = useState(false);
  const [word, setWord] = useState(0);
  const active = mounted && !reducedMotion && visible && pageVisible && !paused;

  useEffect(() => {
    setMounted(true);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(motion.matches);
    const updateVisibility = () => setPageVisible(!document.hidden);
    updateMotion();
    updateVisibility();
    motion.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    const observer = new IntersectionObserver((entries) => {
      // Exit and re-entry can arrive together; use the latest observation.
      const entry = entries[entries.length - 1];
      if (entry) setVisible(entry.isIntersecting);
    });
    if (hero.current) observer.observe(hero.current);
    return () => {
      motion.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updateVisibility);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(
      () => setWord((index) => (index + 1) % verbs.length),
      3000,
    );
    return () => window.clearInterval(timer);
  }, [active]);

  return (
    <header ref={hero} className={`${styles.hero} container`}>
      <div className={styles.heroContent}>
        <p className="docs-eyebrow">Your ideas. Your voice. Your community.</p>
        <h1 className={styles.title}>
          <span className={styles.accessibleHeading}>
            Free to create. Free to speak. Free to connect.
          </span>
          <span aria-hidden="true">
            Free to <span className={styles.verb}>{verbs[word]}.</span>
          </span>
        </h1>
        <p className="docs-intro">
          Make something worth sharing. Write a page, create with AI, go live
          with your community, or build an application people love.
        </p>
        <div className="docs-hero-actions">
          <Link className="button button--primary" to="/docs/overview/">
            Discover Free2Z
          </Link>
          <Link
            className="button button--secondary"
            to="/docs/getting-started/tuzis"
          >
            Explore 2Z credits
          </Link>
        </div>
      </div>
      <div className={styles.artwork}>
        <div className={styles.cloud} aria-hidden="true">
          {mounted && !reducedMotion && visible && pageVisible ? (
            <Header3d active={active} />
          ) : (
            <div className={styles.staticWords}>
              Create · Publish · Connect
              <br />
              Share · Build · Imagine
            </div>
          )}
        </div>
        {mounted && !reducedMotion && (
          <button
            className={styles.motionControl}
            type="button"
            aria-pressed={paused}
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? "Play animation" : "Pause animation"}
          </button>
        )}
      </div>
    </header>
  );
}

export default function Home(): JSX.Element {
  return (
    <Layout
      title="Free2Z Docs"
      description="Free to create, publish, and connect. Explore AI, live experiences, Zcash, and creator tools on Free2Z."
    >
      <HomepageHeader />
      <main>
        <HomepageFeatures />
        <section
          className={`container ${styles.credits}`}
          aria-labelledby="docs-model-title"
        >
          <p className="docs-eyebrow">More ways to take part</p>
          <h2 id="docs-model-title">
            Buy, use, and share 2Zs. Earn from your services.
          </h2>
          <p>
            Buy 2Zs with Zcash for AI, livestream time and access, comments,
            votes, boosts, subscriptions, and supported SDK applications.
            Holding credits also unlocks larger uploads. Share credits or join a
            creator’s membership: 2Zs are platform credits, not money to cash
            out.
          </p>
          <p>
            Approved, verified creators can earn USD owed by 2Z Inc. for
            qualifying delivered PPV and SDK services under accepted terms, paid
            in shielded Zcash. Earnings stay separate from credits. Supporters
            can also send Zcash directly to a creator’s displayed wallet
            address.
          </p>
          <Link to="/docs/revenue-sharing">Explore creator earnings →</Link>
        </section>
        <section
          className={`container ${styles.promise}`}
          aria-labelledby="docs-promise-title"
        >
          <h2 id="docs-promise-title">A place for your voice.</h2>
          <p>
            We believe in creative freedom, direct relationships, and a
            community that helps people grow. We will never sell your personal
            data.
          </p>
          <Link to="/docs/overview/core-values">What we stand for →</Link>
        </section>
      </main>
    </Layout>
  );
}
