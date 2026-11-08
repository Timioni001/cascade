/**
 * The merchant's API key in the browser, shared by the dashboard and the
 * point of sale.
 *
 * - Always kept for this tab (sessionStorage).
 * - Also kept on this device (localStorage) when the person chooses to stay
 *   signed in. Sandbox keys (`sk_test_`, `rk_test_`) default to remembered;
 *   live keys default to this tab only.
 * - Signing out, or a key the API rejects, clears both.
 */
const KEY = "cascade_dashboard_key";

export const isTestKey = (k: string) => /^(sk|rk)_test_/.test(k);

export function readKey(): string {
  try {
    return sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveKey(k: string, remember: boolean): void {
  try {
    sessionStorage.setItem(KEY, k);
    if (remember) localStorage.setItem(KEY, k);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the page keeps the key in memory only */
  }
}

export function clearKey(): void {
  try {
    sessionStorage.removeItem(KEY);
    localStorage.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
}
