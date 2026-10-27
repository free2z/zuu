import React from "react";
import { useDocRootMetadata } from "@docusaurus/plugin-content-docs/client";

/** No sidebar: just the document. */
export default function PlainDocRoot(props) {
  const metadata = useDocRootMetadata(props);
  if (!metadata) return <p>Not found.</p>;
  return metadata.docElement;
}
