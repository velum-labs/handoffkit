// Theme plumbing shared by the root layout and the sidebar toggle.
//
// The chosen theme lives in a cookie (not localStorage) so the server layout
// can render the correct `dark` class on <html> during SSR — no flash and no
// hydration mismatch for explicit choices. "system" is resolved before first
// paint by THEME_INIT_SCRIPT and tracked live via a media-query listener.

export const THEME_COOKIE = "scope_theme";

export const THEMES = ["light", "dark", "system"] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/**
 * Inline, render-blocking snippet that resolves "system" (or a stale cookie)
 * into the `dark` class before the first paint. Kept tiny and defensive: a
 * failure must never break rendering.
 */
export const THEME_INIT_SCRIPT = `(function () {
  try {
    var match = document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]*)/);
    var theme = match ? decodeURIComponent(match[1]) : "system";
    var dark =
      theme === "dark" ||
      (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch (error) {}
})();`;

export function readThemeCookie(): Theme {
  if (typeof document === "undefined") return "system";
  const match = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]*)`));
  const value = match !== null ? decodeURIComponent(match[1]) : undefined;
  return isTheme(value) ? value : "system";
}

export function applyTheme(theme: Theme): void {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
}
