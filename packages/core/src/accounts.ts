/** NEAR account id rules (NEP-0: 2-64 chars, lowercase, separators . - _). */
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isAccountId(s: string): boolean {
  return s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);
}

/** 64-hex implicit accounts (1Click deposit addresses on NEAR look like this). */
export function isImplicitAccount(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

/** Mirror of contracts/factory `valid_name`. */
export function isValidName(name: string): boolean {
  return /^[a-z\d]+([-_][a-z\d]+)*$/.test(name) && name.length >= 2 && name.length <= 32;
}

export const RESERVED_NAMES = new Set([
  "app", "admin", "api", "relayer", "settler", "factory", "www", "mail", "team", "cascade", "near",
  "support", "help", "root", "pay", "usdc",
]);

export function nameAvailableLocally(name: string): boolean {
  return isValidName(name) && !RESERVED_NAMES.has(name);
}

/** "ada" + "cascade.near" -> "ada.cascade.near" */
export function nameToAccount(name: string, root: string): string {
  return `${name}.${root}`;
}

/** "ada.cascade.near" -> "ada" if it is directly under root. */
export function accountToName(account: string, root: string): string | null {
  const suffix = `.${root}`;
  if (!account.endsWith(suffix)) return null;
  const n = account.slice(0, -suffix.length);
  return n.includes(".") ? null : n;
}
