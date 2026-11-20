import type { BrowserContext, Page } from "@playwright/test";

/** Match the resolved request boundary, never prose, JSON null or query values. */
export function isDirectoryNullUrl(
  value: string,
  base: string,
  documentUrl = base,
) {
  try {
    const resolved = new URL(value, base);
    const boundary = new URL("null", documentUrl);
    return (
      /^https?:$/.test(resolved.protocol) &&
      resolved.origin === boundary.origin &&
      decodeURIComponent(resolved.pathname).replace(/\/$/, "") ===
        decodeURIComponent(boundary.pathname)
    );
  } catch {
    return false;
  }
}

// Self-contained: Playwright serializes this into each document before scripts.
// Results contain counts and source categories only, never visitor URLs/content.
export function installNullUrlAudit() {
  const findings = new Set<string>();
  const inventory = new Map<string, number>();
  let mutations = 0;
  const candidate = (
    value: string,
    source: string,
    base = document.baseURI,
  ) => {
    inventory.set(source, (inventory.get(source) || 0) + 1);
    try {
      const url = new URL(value, base);
      const boundary = new URL("null", location.href);
      if (
        /^https?:$/.test(url.protocol) &&
        url.origin === boundary.origin &&
        decodeURIComponent(url.pathname).replace(/\/$/, "") ===
          decodeURIComponent(boundary.pathname)
      )
        findings.add(source);
    } catch {
      /* Invalid URLs are outside this investigation's request shape. */
    }
  };
  const css = (value: string, source: string, base?: string) => {
    // Skip comments and ordinary CSS strings: content: "url(null)" is text,
    // whereas background-image: url("null") is a resource reference.
    const tokens =
      /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*?))\s*\)/gi;
    for (const match of value.matchAll(tokens)) {
      const url = match[1] ?? match[2] ?? match[3];
      if (url !== undefined) candidate(url, source, base);
    }
  };
  const srcset = (value: string, source: string) => {
    // URL tokens can contain commas (notably data:). Descriptors end at a
    // comma; a URL without a descriptor may itself end with separators.
    let rest = value;
    while (rest.trim()) {
      rest = rest.replace(/^[\s,]+/, "");
      const token = /^[^\s]+/.exec(rest)?.[0];
      if (!token) break;
      candidate(token.replace(/,+$/, ""), source);
      rest = rest.slice(token.length);
      if (!token.endsWith(",")) rest = rest.replace(/^[^,]*(,|$)/, "");
    }
  };
  const attribute = (el: Element, name: string, value: string) => {
    if (name === "data" && el.localName !== "object") return;
    const source = `${el.localName}:${name}`;
    if (
      [
        "src",
        "href",
        "xlink:href",
        "poster",
        "action",
        "formaction",
        "data",
      ].includes(name)
    ) {
      candidate(value, source);
    } else if (["srcset", "imagesrcset"].includes(name)) srcset(value, source);
    else if (name === "style") css(value, source);
    else if (
      el.localName === "meta" &&
      name === "content" &&
      /^(og:(image|video|audio|url)(:url|:secure_url)?|twitter:(image|player))$/.test(
        el.getAttribute("property") || el.getAttribute("name") || "",
      )
    )
      candidate(value, source);
  };
  const jsonLd = (value: unknown, key = "") => {
    if (
      typeof value === "string" &&
      /^(url|@id|image|logo|sameAs|contentUrl|embedUrl|thumbnailUrl|target)$/.test(
        key,
      )
    )
      candidate(value, `jsonld:${key}`);
    else if (Array.isArray(value)) value.forEach((entry) => jsonLd(entry, key));
    else if (value && typeof value === "object")
      Object.entries(value).forEach(([name, entry]) => jsonLd(entry, name));
  };
  const scan = (root: ParentNode) => {
    const elements = [...root.querySelectorAll("*")];
    if (root instanceof Element) elements.unshift(root);
    for (const el of elements) {
      for (const attr of el.attributes) attribute(el, attr.name, attr.value);
      if (el.localName === "style") css(el.textContent || "", "style:sheet");
      if (el.matches('script[type="application/ld+json"]')) {
        try {
          jsonLd(JSON.parse(el.textContent || "null"));
        } catch {
          /* Not JSON. */
        }
      }
      if (el.shadowRoot) scan(el.shadowRoot);
    }
  };
  const observer = new MutationObserver((records) => {
    mutations += records.length;
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof Element) {
        // Preserve a transient bad attribute even if removed in the same task.
        if (record.oldValue !== null)
          attribute(record.target, record.attributeName!, record.oldValue);
        const current = record.target.getAttribute(record.attributeName!);
        if (current !== null)
          attribute(record.target, record.attributeName!, current);
      } else {
        for (const node of record.addedNodes)
          if (node instanceof Element) scan(node);
        if (record.target instanceof Element) scan(record.target);
      }
    }
  });
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true,
  });
  const rules = (list: CSSRuleList, base: string) => {
    for (const rule of list) {
      css(rule.cssText, "css:rule", base);
      if ("cssRules" in rule) rules((rule as CSSGroupingRule).cssRules, base);
    }
  };
  const snapshot = () => {
    scan(document);
    for (const sheet of document.styleSheets) {
      try {
        rules(sheet.cssRules, sheet.href || document.baseURI);
      } catch {
        /* Cross-origin sheet. Network remains observed. */
      }
    }
    for (const el of document.querySelectorAll("*")) {
      for (const pseudo of [null, "::before", "::after"])
        css(
          getComputedStyle(el, pseudo).cssText +
            " " +
            getComputedStyle(el, pseudo).backgroundImage +
            " " +
            getComputedStyle(el, pseudo).content,
          "css:computed",
        );
    }
    return {
      findings: [...findings].sort(),
      inventory: Object.fromEntries(inventory),
      mutations,
    };
  };
  (
    window as unknown as { nullUrlAudit: { snapshot: typeof snapshot } }
  ).nullUrlAudit = { snapshot };
  // Mutation delivery covers streaming SSR insertion as well as hydration.
  // A snapshot also covers documents parsed with JavaScript disabled.
}

export async function auditSnapshot(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as {
        nullUrlAudit: {
          snapshot: () => {
            findings: string[];
            inventory: Record<string, number>;
            mutations: number;
          };
        };
      }
    ).nullUrlAudit.snapshot(),
  );
}

export async function observeNullUrls(context: BrowserContext) {
  const networkTypes: Record<string, number> = {};
  const badRequests: string[] = [];
  const workers = { dedicated: 0, service: 0 };
  const watchPage = (page: Page) =>
    page.on("worker", () => workers.dedicated++);
  context.pages().forEach(watchPage);
  context.on("page", watchPage);
  context.on("serviceworker", () => workers.service++);
  context.on("request", (request) => {
    const kind = request.resourceType();
    networkTypes[kind] = (networkTypes[kind] || 0) + 1;
    let documentUrl = request.headers().referer;
    try {
      documentUrl ||= request.frame().url();
    } catch {
      /* Service worker. */
    }
    if (documentUrl && isDirectoryNullUrl(request.url(), documentUrl))
      badRequests.push(kind);
  });
  await context.addInitScript(installNullUrlAudit);
  return { networkTypes, badRequests, workers };
}
