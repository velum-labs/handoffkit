import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PANEL_DEPTH_HEADER,
  panelDepthFromRequest,
  parsePanelDepth
} from "../request-context.js";

test("FusionKit owns and parses its namespaced panel-depth request context", () => {
  assert.equal(parsePanelDepth(undefined), 0);
  assert.equal(parsePanelDepth("2"), 2);
  assert.equal(parsePanelDepth(["3", "4"]), 3);
  assert.equal(parsePanelDepth("-1"), 0);
  assert.equal(parsePanelDepth("invalid"), 0);
  assert.equal(
    panelDepthFromRequest({
      requestContext: {
        headers: {
          [PANEL_DEPTH_HEADER]: "5",
          "x-routekit-session-id": "session"
        }
      }
    }),
    5
  );
});
