/**
 * Mirror ephemeral view state (filters, sort, inspected event) into the URL's
 * search params without triggering a Next.js navigation, so views are
 * shareable and survive reloads. replaceState keeps history clean while the
 * user tweaks filters.
 */
export function replaceSearchParams(updates: Record<string, string | undefined>): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.replaceState(null, "", url);
}
