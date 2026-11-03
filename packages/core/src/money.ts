/** USDC on NEAR has 6 decimals. All amounts in Cascade are bigint base units. */
export const USDC_DECIMALS = 6;
const UNIT = 10n ** BigInt(USDC_DECIMALS);

/** "12.5" or "12.50" -> 12_500_000n. Rejects more than 6 decimals, signs and junk. */
export function parseUsd(input: string): bigint {
  const s = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a dollar amount: ${input}`);
  const [whole, frac = ""] = s.split(".") as [string, string?];
  if (frac.length > USDC_DECIMALS) throw new Error(`too many decimals: ${input}`);
  return BigInt(whole) * UNIT + BigInt(frac.padEnd(USDC_DECIMALS, "0"));
}

/** 12_500_000n -> "12.50" (always at least 2 decimals, trailing zeros trimmed beyond that). */
export function formatUsd(units: bigint | string): string {
  const v = BigInt(units);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / UNIT;
  let frac = (a % UNIT).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

export function sum(values: Iterable<bigint>): bigint {
  let t = 0n;
  for (const v of values) t += v;
  return t;
}
