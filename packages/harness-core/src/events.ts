import type {
  HarnessContentStream,
  HarnessEvent as RouteHarnessEvent,
  HarnessEventRaw,
  HarnessEventType,
  HarnessItemType,
  HarnessRequestType,
  HarnessTokenUsage,
  HarnessTurnEndReason
} from "@routekit/contracts";

import type { HarnessKind } from "./kinds.js";

export type HarnessEvent = RouteHarnessEvent<HarnessKind>;

export type {
  HarnessContentStream,
  HarnessEventRaw,
  HarnessEventType,
  HarnessItemType,
  HarnessRequestType,
  HarnessTokenUsage,
  HarnessTurnEndReason
};
