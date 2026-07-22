/** Shared local account-store view used by shell completion. */
import { accountStoreEntries } from "@routekit/accounts";
import type { AccountStoreEntry } from "@routekit/accounts";

export type AccountListEntry = AccountStoreEntry;

export function listAccounts(): AccountListEntry[] {
  return accountStoreEntries();
}
