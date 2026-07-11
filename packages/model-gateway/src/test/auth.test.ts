import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";

import { authorizedRequest, timingSafeStringEqual, verifyBearerToken } from "../auth.js";

function requestWithHeaders(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test("timingSafeStringEqual matches only exact strings", () => {
  assert.equal(timingSafeStringEqual("secret", "secret"), true);
  assert.equal(timingSafeStringEqual("secret", "secre_"), false);
  assert.equal(timingSafeStringEqual("secret", "secret-longer"), false);
  assert.equal(timingSafeStringEqual("", ""), true);
});

test("verifyBearerToken requires the Bearer prefix and exact token", () => {
  assert.equal(verifyBearerToken("Bearer tok", "tok"), true);
  assert.equal(verifyBearerToken("bearer tok", "tok"), false);
  assert.equal(verifyBearerToken("tok", "tok"), false);
  assert.equal(verifyBearerToken(undefined, "tok"), false);
});

test("authorizedRequest accepts bearer header or x-api-key, rejects otherwise", () => {
  assert.equal(authorizedRequest(requestWithHeaders({ authorization: "Bearer tok" }), "tok"), true);
  assert.equal(authorizedRequest(requestWithHeaders({ "x-api-key": "tok" }), "tok"), true);
  assert.equal(authorizedRequest(requestWithHeaders({ authorization: "Bearer nope" }), "tok"), false);
  assert.equal(authorizedRequest(requestWithHeaders({ "x-api-key": "nope" }), "tok"), false);
  assert.equal(authorizedRequest(requestWithHeaders({}), "tok"), false);
});
