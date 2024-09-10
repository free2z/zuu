import React from 'react';
import clsx from 'clsx';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  Svg?: React.ComponentType<React.ComponentProps<'svg'>>;
  imageSrc?: string;
  description: JSX.Element;
  link: string;
  size?: string;
};


const FeatureList: FeatureItem[] = [
  {
    title: 'Free to Speak.',
    description: (
      <>
        Free2Z champions the power of free expression. From independent journalists to cultural commentators, our platform is a haven for diverse voices. Embrace the freedom to speak out, share insights, and engage in meaningful discussions, all within a supportive and collaborative community.
      </>
    ),
    link: "/docs/overview",
    imageSrc: "https://free2z.com/uploadz/public/free2z/free-to-speak-300.png",
  },
  {
    title: 'Free to Monetize.',
    description: (
      <>
        Unlock the potential of your creativity with Free2Z's innovative monetization tools. Whether you're an artist, educator, or tech visionary, our platform offers unique revenue-sharing programs and peer-to-peer donations. Monetize your work transparently and fairly, turning your passion into profit.
      </>
    ),
    link: "/docs/for-creators",
    imageSrc: "https://free2z.com/uploadz/public/free2z/free-to-monetize-300.png",
  },
  {
    title: 'Free to Support.',
    description: (
      <>
        Supporting your favorite creators is more impactful with Free2Z. Enjoy an ad-free experience, fair pricing, and minimal platform fees. Whether you're buying a coffee or funding a project, your contributions make a real difference, fostering a direct and meaningful connection with creators.
      </>
    ),
    link: "/docs/for-supporters",
    imageSrc: "https://free2z.com/uploadz/public/free2z/free-to-support-300.png",
  },
  {
    title: 'Free to Think.',
    description: (
      <>
        Free2Z redefines online privacy and security. Engage, support, and explore content while maintaining complete anonymity. Our platform ensures your privacy with options like anonymous donations via Zcash and secure, hassle-free logins. Experience true freedom of expression without surveillance.
      </>
    ),
    link: "/docs/privacy-and-security",
    size: "col--6",
    imageSrc: "https://free2z.com/uploadz/public/free2z/free-to-think-300.png",
  },
  {
    title: 'Free to Build.',
    description: (
      <>
        Discover a world of creative possibilities with Free2Z's advanced toolkit. From long-form articles to scalable live streams, our platform equips you with everything you need to create, publish, and engage. Elevate your content with AI conversations, video production, and more in our all-in-one media hub.
      </>
    ),
    link: "/docs/getting-started",
    size: "col--6",
    imageSrc: "https://free2z.com/uploadz/public/free2z/free-to-build-300.png",
  },
];


function Feature({ title, Svg, imageSrc, description, link, size }: FeatureItem) {
  const cl = size || "col--4";
  let target = "_self";
  if (link.startsWith("https://")) {
    target = "_blank";
  }
  return (
    <div className={clsx(`col ${cl}`)}>
      <div className="text--center padding-horiz--md">
        <h3>
          <a href={link} target={target}>
            {title}
          </a>
        </h3>
      </div>
      <a href={link}>
        <div className="text--center">
          {Svg ? (
            <Svg className={styles.featureSvg} role="img" />
          ) : (
            <img src={imageSrc} alt={title} className={styles.featureImage}
              style={{ maxWidth: "300px" }}
            />
          )}
        </div>
      </a>
      <div className="text--center padding-horiz--md">
        <p>{description}</p>
      </div>
    </div>
  );
}


export default function HomepageFeatures(): JSX.Element {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
