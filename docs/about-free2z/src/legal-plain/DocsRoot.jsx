import React from "react";
import renderRoutes from "@docusaurus/renderRoutes";
import LayoutProvider from "@theme/Layout/Provider";

/** The theme's providers without its navbar, footer or skip links. */
export default function PlainDocsRoot(props) {
  return <LayoutProvider>{renderRoutes(props.route.routes)}</LayoutProvider>;
}
