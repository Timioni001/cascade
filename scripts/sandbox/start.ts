/**
 * Start a local NEAR sandbox node that matches mainnet's nearcore version.
 *
 * Some containers (CI runners, cloud dev boxes, possibly the judges' own)
 * cap the open-file limit below the 65535 nearcore insists on, and do not
 * allow raising it. In that case we fetch the sandbox binary ourselves and
 * run it with a tiny LD_PRELOAD shim (rlimit-shim.c) that clamps the
 * request instead of failing. Everywhere else near-sandbox runs as usual.
 */
import { execFileSync, execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "near-sandbox";

/** nearcore version on mainnet as of 2026-11-03 (RPC `status`). */
export const SANDBOX_VERSION = "2.14.0";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const cache = join(repo, ".sandbox");

function hardFileLimit(): number {
  try {
    const v = execSync("sh -c 'ulimit -Hn'", { encoding: "utf8" }).trim();
    return v === "unlimited" ? Infinity : Number(v);
  } catch {
    return Infinity;
  }
}

async function prepareShimmedBinary(): Promise<string> {
  const dir = join(cache, "bin", SANDBOX_VERSION);
  const bin = join(dir, "Linux-x86_64", "near-sandbox");
  if (!existsSync(bin)) {
    mkdirSync(dir, { recursive: true });
    const url = `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/${SANDBOX_VERSION}/near-sandbox.tar.gz`;
    process.stderr.write(`[sandbox] downloading nearcore ${SANDBOX_VERSION} sandbox...\n`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
    const tgz = join(dir, "near-sandbox.tar.gz");
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    execFileSync("tar", ["-xzf", tgz, "-C", dir]);
  }
  const shim = join(cache, "rlimit-shim.so");
  if (!existsSync(shim)) {
    execFileSync("cc", ["-shared", "-fPIC", "-O2", "-o", shim, join(here, "rlimit-shim.c"), "-ldl"]);
  }
  const wrapper = join(cache, "near-sandbox");
  writeFileSync(wrapper, `#!/bin/sh\nLD_PRELOAD="${shim}" exec "${bin}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

export async function startSandbox(): Promise<Sandbox> {
  if (!process.env.NEAR_SANDBOX_BIN_PATH && process.platform === "linux" && process.arch === "x64" && hardFileLimit() < 65535) {
    process.env.NEAR_SANDBOX_BIN_PATH = await prepareShimmedBinary();
  }
  process.env.NEAR_RPC_TIMEOUT_SECS ??= "60";
  // near-sandbox downloads into the OS temp dir and then rename()s into
  // node_modules. On WSL (and some Docker setups) /tmp is another filesystem,
  // so the rename fails with EXDEV. Keep its temp files next to the repo.
  const tmp = join(cache, "tmp");
  mkdirSync(tmp, { recursive: true });
  process.env.TMPDIR = tmp;
  return Sandbox.start({ version: SANDBOX_VERSION });
}
