// What Settings says when PATCH /api/auth/user/ refuses a save.
// The page used to say "Failed to save settings." whatever the server said.
import assert from "node:assert/strict";
import { test } from "node:test";

import { readProfileSaveFailure } from "../src/lib/profile-save-errors.ts";

const OPTIONS = {
  labels: { member_price: "Membership price", p2paddr: "Zcash Address" },
  genericMessage: "Failed to save settings.",
  summaryMessage: "The server refused these settings.",
};

function response(status, body) {
  return {
    status,
    json: async () => {
      if (typeof body === "string") throw new SyntaxError("not JSON");
      return body;
    },
  };
}

test("the prod 400 is shown, labelled, not discarded", async () => {
  const failure = await readProfileSaveFailure(
    response(400, {
      member_price: ["Ensure this value is greater than or equal to 1."],
    }),
    OPTIONS,
  );
  assert.deepEqual(failure.fieldErrors, {
    member_price: "Ensure this value is greater than or equal to 1.",
  });
  assert.equal(
    failure.saveError,
    "Membership price: Ensure this value is greater than or equal to 1.",
  );
});

test("every rejected field is named, including ones with no label", async () => {
  const failure = await readProfileSaveFailure(
    response(400, {
      p2paddr: ["Bad address."],
      username: ["Taken."],
      non_field_errors: ["Try again later."],
    }),
    OPTIONS,
  );
  assert.equal(failure.fieldErrors.p2paddr, "Bad address.");
  assert.equal(failure.fieldErrors.username, "Taken.");
  assert.equal(
    failure.saveError,
    "Try again later. Zcash Address: Bad address. username: Taken.",
  );
});

test("a body that is not JSON (an nginx 502 page) is the generic message", async () => {
  const failure = await readProfileSaveFailure(
    response(502, "<html>Bad Gateway</html>"),
    OPTIONS,
  );
  assert.deepEqual(failure.fieldErrors, {});
  assert.equal(failure.saveError, "Failed to save settings.");
});

test("a request-level refusal (403 detail) is the server's sentence", async () => {
  const failure = await readProfileSaveFailure(
    response(403, { detail: "Authentication credentials were not provided." }),
    OPTIONS,
  );
  assert.equal(
    failure.saveError,
    "Authentication credentials were not provided.",
  );
});
