// node --test src/legal-plain/  (run by CI before the docs build)
const assert = require("node:assert/strict");
const test = require("node:test");
const { keep, unlink } = require("./remark-legal-links");

const text = (value) => ({ type: "text", value });
const tree = (...children) => ({ type: "root", children: [{ type: "paragraph", children }] });
const flat = (node) => JSON.stringify(node);

test("allow-listed siblings and mailto: stay links; everything else does not", () => {
  assert.equal(keep("./02-privacy-policy.md"), true);
  assert.equal(keep("./02-privacy-policy.md#cookies"), true);
  assert.equal(keep("mailto:help@free2z.com"), true);
  assert.equal(keep("./05-token-sale-and-usage-terms.md"), false);
  assert.equal(keep("./06-revenue-share-agreement.md"), false);
  assert.equal(keep("../getting-started/03-tuzis.md"), false);
  assert.equal(keep("https://free2z.cash/buy-2z"), false);
  assert.equal(keep("/docs/getting-started/tuzis"), false);
  assert.equal(keep(undefined), false);
});

test("a Markdown link to an excluded document becomes its text", () => {
  const node = tree({ type: "link", url: "./05-token-sale-and-usage-terms.md", children: [text("2Z Credits")] });
  unlink(node);
  assert.deepEqual(node.children[0].children, [text("2Z Credits")]);
});

test("a raw HTML <a> to the credits page loses its tag, keeps its text", () => {
  const node = tree({ type: "html", value: '<a href="/docs/getting-started/tuzis">Buy 2Z</a> and <a href="./02-privacy-policy.md">Privacy</a>' });
  unlink(node);
  const html = node.children[0].children[0].value;
  assert.equal(html, 'Buy 2Z and <a href="./02-privacy-policy.md">Privacy</a>');
});

test("raw HTML <area> to a non-allowed target is removed", () => {
  const node = tree({ type: "html", value: '<map><area href="https://free2z.cash/buy-2z" alt="buy"><area href="./02-privacy-policy.md" alt="p"></map>' });
  unlink(node);
  assert.equal(node.children[0].children[0].value, '<map><area href="./02-privacy-policy.md" alt="p"></map>');
});

test("MDX <a>, <area> and <Link> to a non-allowed target become their children", () => {
  for (const [name, attr] of [["a", "href"], ["area", "href"], ["Link", "to"]]) {
    const node = tree({
      type: "mdxJsxTextElement",
      name,
      attributes: [{ type: "mdxJsxAttribute", name: attr, value: "https://free2z.cash/buy-2z" }],
      children: [text("top up")],
    });
    unlink(node);
    assert.deepEqual(node.children[0].children, [text("top up")], name);
  }
});

test("an MDX link with a computed target is dropped, not trusted", () => {
  const node = tree({
    type: "mdxJsxTextElement",
    name: "Link",
    attributes: [{ type: "mdxJsxAttribute", name: "to", value: { type: "mdxJsxAttributeValueExpression", value: "x" } }],
    children: [text("somewhere")],
  });
  unlink(node);
  assert.ok(!flat(node).includes("mdxJsxTextElement"));
});
