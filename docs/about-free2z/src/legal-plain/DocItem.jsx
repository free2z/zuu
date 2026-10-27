import React from "react";
import Head from "@docusaurus/Head";
import { DocProvider } from "@docusaurus/plugin-content-docs/client";
import DocItemMetadata from "@theme/DocItem/Metadata";
import DocItemContent from "@theme/DocItem/Content";

/**
 * The ordinary page for the same document, which search engines index:
 * /docs/plain/legal/ is /docs/legal/, /docs/plain/<doc> is /docs/legal/<doc>.
 */
function canonicalPath(permalink) {
  if (permalink === "/docs/plain/legal/") return "/docs/legal/";
  return permalink.replace(/^\/docs\/plain\//, "/docs/legal/");
}

/** The article alone: no breadcrumbs, table of contents, pager or edit link. */
export default function PlainDocItem(props) {
  const MDXComponent = props.content;
  const { permalink } = props.content.metadata;
  return (
    <DocProvider content={props.content}>
      <DocItemMetadata />
      <Head>
        <meta name="robots" content="noindex" />
        <link rel="canonical" href={canonicalPath(permalink)} />
      </Head>
      <main className="container margin-vert--lg">
        <article>
          {/* The theme's content block: it adds the title as an <h1>. */}
          <DocItemContent>
            <MDXComponent />
          </DocItemContent>
        </article>
      </main>
    </DocProvider>
  );
}
