import React from "react";
import Link from "@docusaurus/Link";
import styles from "./styles.module.css";

const paths = [
  {
    title: "Your words, your world",
    description:
      "Publish rich zPages, share media, and let readers explore your work in another language.",
    link: "/docs/overview/key-features",
    label: "Explore publishing",
  },
  {
    title: "Bring your community live",
    description:
      "Broadcast, meet your subscribers, host a private room, or offer a paid live experience.",
    link: "/docs/for-creators/free2z-live",
    label: "Explore livestreams",
  },
  {
    title: "Make more with AI",
    description:
      "Explore ideas, shape a draft, and try the available AI tools with 2Z credits and spending controls.",
    link: "/docs/for-creators/AI-content-generation",
    label: "Explore AI",
  },
  {
    title: "Build something people love",
    description:
      "Connect your application to Free2Z sign-in, AI services, and user credit budgets.",
    link: "/docs/for-creators/sdk-applications",
    label: "Explore the source preview",
    badge: "SDK preview",
  },
];

const showcases = [
  {
    title: "A home for independent voices.",
    description:
      "Discover original work, follow a creator, and publish something of your own. Your profile brings your pages and community together.",
    image: "creator-profile",
    caption: "Your profile brings your work and community together.",
    alt: "The official Free2Z creator profile",
    link: "/docs/overview/",
    label: "Discover Free2Z",
  },
  {
    title: "Small posts. Real conversations.",
    description:
      "Share an update, ask a question, or join a thread. Converse brings the community into one public feed.",
    image: "converse",
    caption: "Find an idea. Join the conversation.",
    alt: "The Converse feed with search and community threads",
    link: "/docs/overview/key-features",
    label: "Find your community",
  },
  {
    title: "Find your next great read.",
    description:
      "Explore stories, profiles, and topics. Start with something that catches your attention, then share what inspires you.",
    image: "discover",
    caption: "Discover something that inspires you.",
    alt: "The Free2Z discovery page",
    link: "/docs/overview/key-features",
    label: "See what you can do",
  },
];

export default function HomepageFeatures(): JSX.Element {
  return (
    <>
      <section
        className={`container ${styles.features}`}
        aria-label="Explore Free2Z features"
      >
        {paths.map((path) => (
          <Link key={path.link} to={path.link} className={styles.path}>
            {path.badge && <span className={styles.badge}>{path.badge}</span>}
            <h2>{path.title}</h2>
            <p>{path.description}</p>
            <span>{path.label} →</span>
          </Link>
        ))}
      </section>
      <section
        className={`container ${styles.showcases}`}
        aria-label="See Free2Z in action"
      >
        {showcases.map((item) => (
          <article key={item.image} className={styles.showcase}>
            <div>
              <h2>{item.title}</h2>
              <p>{item.description}</p>
              <Link to={item.link}>{item.label} →</Link>
            </div>
            <figure>
              <img
                src={`/docs/img/product-2026-10/${item.image}.png`}
                alt={item.alt}
                width="1280"
                height="820"
                loading="lazy"
              />
              <figcaption>{item.caption}</figcaption>
            </figure>
          </article>
        ))}
      </section>
    </>
  );
}
