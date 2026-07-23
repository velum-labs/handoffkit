/** Shared local account-store view used by shell completion. */
import { accountStoreEntries } from "@velum-labs/routekit-accounts";
import type { AccountStoreEntry } from "@velum-labs/routekit-accounts";

export type AccountListEntry = AccountStoreEntry;

export function listAccounts(): AccountListEntry[] {
  return accountStoreEntries();
}
