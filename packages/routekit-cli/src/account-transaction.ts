import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { join } from "node:path";

import {
  commitSubscriptionEnrollment,
  planSubscriptionEnrollment,
  restoreSubscriptionEnrollment
} from "@routekit/accounts";
import {
  commitEffectiveRouterConfigUpdate,
  planEffectiveRouterConfigUpdate,
  restoreEffectiveRouterConfigUpdate,
  routekitHome
} from "@routekit/config";
import type { UpdateRouterConfigInput } from "@routekit/config";
import type { SubscriptionMode } from "@routekit/registry";
import { writeFileAtomic } from "@routekit/runtime";

import type { AccountListEntry } from "./accounts.js";

type EnrollmentJournal = {
  version: 1;
  mode: SubscriptionMode;
  label: string;
  credentialPath: string;
  previousCredential: string | null;
  configPath: string;
  previousConfig: string;
};

function transactionsDirectory(): string {
  return join(routekitHome(), "transactions");
}

function journalPath(mode: SubscriptionMode, label: string): string {
  return join(transactionsDirectory(), `enrollment-${mode}-${label}.json`);
}

function writeJournal(path: string, journal: EnrollmentJournal): void {
  mkdirSync(transactionsDirectory(), { recursive: true, mode: 0o700 });
  chmodSync(transactionsDirectory(), 0o700);
  writeFileAtomic(path, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function restoreJournal(journal: EnrollmentJournal): void {
  restoreEffectiveRouterConfigUpdate({
    path: journal.configPath,
    previousContent: journal.previousConfig
  });
  restoreSubscriptionEnrollment({
    targetPath: journal.credentialPath,
    ...(journal.previousCredential !== null
      ? { previousContent: journal.previousCredential }
      : {})
  });
}

export function recoverPendingEnrollmentTransactions(): string[] {
  const directory = transactionsDirectory();
  if (!existsSync(directory)) return [];
  const recovered: string[] = [];
  const failures: unknown[] = [];
  for (const name of readdirSync(directory).filter(
    (entry) => entry.startsWith("enrollment-") && entry.endsWith(".json")
  )) {
    const path = join(directory, name);
    try {
      const journal = JSON.parse(readFileSync(path, "utf8")) as EnrollmentJournal;
      if (
        journal.version !== 1 ||
        typeof journal.credentialPath !== "string" ||
        typeof journal.configPath !== "string" ||
        typeof journal.previousConfig !== "string"
      ) {
        throw new Error(`invalid enrollment transaction journal: ${path}`);
      }
      restoreJournal(journal);
      rmSync(path, { force: true });
      recovered.push(`${journal.mode}/${journal.label}`);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "could not recover one or more pending account enrollment transactions"
    );
  }
  return recovered;
}

function enableProvider(
  draft: Record<string, unknown>,
  subscriptionKind: SubscriptionMode
): void {
  const providers =
    typeof draft.providers === "object" &&
    draft.providers !== null &&
    !Array.isArray(draft.providers)
      ? (draft.providers as Record<string, unknown>)
      : {};
  const current =
    typeof providers[subscriptionKind] === "object" &&
    providers[subscriptionKind] !== null &&
    !Array.isArray(providers[subscriptionKind])
      ? (providers[subscriptionKind] as Record<string, unknown>)
      : {};
  draft.providers = {
    ...providers,
    [subscriptionKind]: { ...current }
  };
}

export async function enrollAndActivateAccount(input: {
  subscriptionKind: SubscriptionMode;
  label?: string;
  sourcePath?: string;
  config: UpdateRouterConfigInput;
}): Promise<AccountListEntry & { configPath: string }> {
  recoverPendingEnrollmentTransactions();
  const configPlan = planEffectiveRouterConfigUpdate(input.config, (draft) =>
    enableProvider(draft, input.subscriptionKind)
  );
  const credentialPlan = await planSubscriptionEnrollment(
    input.subscriptionKind,
    {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.sourcePath !== undefined ? { sourcePath: input.sourcePath } : {})
    }
  );
  const path = journalPath(input.subscriptionKind, credentialPlan.label);
  const journal: EnrollmentJournal = {
    version: 1,
    mode: input.subscriptionKind,
    label: credentialPlan.label,
    credentialPath: credentialPlan.targetPath,
    previousCredential: credentialPlan.previousContent ?? null,
    configPath: configPlan.path,
    previousConfig: configPlan.previousContent
  };
  writeJournal(path, journal);
  try {
    commitSubscriptionEnrollment(credentialPlan);
    commitEffectiveRouterConfigUpdate(configPlan);
    rmSync(path, { force: true });
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    try {
      restoreJournal(journal);
    } catch (rollbackError) {
      rollbackFailures.push(rollbackError);
    }
    rmSync(path, { force: true });
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        `could not activate ${input.subscriptionKind}/${credentialPlan.label}; rollback failed`
      );
    }
    throw error;
  }
  return {
    subscriptionKind: input.subscriptionKind,
    provider: input.subscriptionKind,
    label: credentialPlan.label,
    path: credentialPlan.targetPath,
    configPath: configPlan.path
  };
}
