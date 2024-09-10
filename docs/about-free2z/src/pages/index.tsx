import React from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import Head from '@docusaurus/Head';
import Header3d from '@site/src/components/Header3d';


function HomepageHeader() {
  return (
    <div style={{ minHeight: '50vh', position: 'relative' }}>
      <div style={{
        position: 'absolute',
        width: '100%',
        top: '7%',
        display: 'flex',
        justifyContent: 'center',
        zIndex: 10
      }}>
        {/* Make a nice header */}
        <h4>Free to Speak. Free to Earn. Free to ...</h4>
      </div>
      <Header3d />

      <div style={{
        position: 'absolute',
        width: '100%',
        bottom: '3%',
        display: 'flex',
        justifyContent: 'center',
        zIndex: 10
      }}>
        <Link
          to="/docs/overview"
          className="button"
          style={{
            padding: '10px 20px',
            backgroundColor: '#6200EE', // Example background color
            color: 'white', // Text color
            textDecoration: 'none',
            borderRadius: '5px',
          }}
        >
          Learn More About Free2Z
        </Link>
      </div>
    </div>
  );
}

export default function Home(): JSX.Element {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={`Free2Z Documentation`}
      description="Express yourself freely, monetize, support and reward!">
      <Head>
        <meta property="og:image" content="/docs/img/tuzi.svg" />
      </Head>
      <HomepageHeader />
      <main>
        <HomepageFeatures />
      </main>
    </Layout>
  );
}
