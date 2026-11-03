/**
 * pnpm demo-merchant --api https://<backend> --web https://<web> [--name lagos-prints] [--dry-run]
 *
 * Sets up the demo shop on a deployed Cascade (testnet), the way a real
 * merchant would onboard:
 *   1. create <name>.<root> with the factory (the relayer pays)
 *   2. register it with Cascade, fee-free (NEP-366, signed by its limited key)
 *   3. onboard it to the hosted checkout API with a signed NEP-413 message
 * Prints the CASCADE_SECRET_KEY and CASCADE_WEBHOOK_SECRET to set on the web
 * app (Vercel). Keys are saved to .env, never printed whole.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { KeyPair, type KeyPairString } from "near-api-js";
import { ONBOARDING_RECIPIENT, onboardingMessage } from "@cascade/engine";
import { Chain, appCalls, decodeSignedDelegate, factoryCalls, relayCall, signMeta } from "@cascade/near";
import { cliIo, describeActions } from "./io.js";
import { loadEnv, maskKey, readConfig, saveKeyToEnv } from "./env.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  loadEnv();
  const cfg = readConfig();
  const dryRun = process.argv.includes("--dry-run");
  const io = cliIo({ network: cfg.network, dryRun });
  try {
    const api = arg("api")?.replace(/\/$/, "");
    const web = arg("web")?.replace(/\/$/, "");
    if (!api || !web) throw new Error("usage: pnpm demo-merchant --api https://<backend> --web https://<web> [--name lagos-prints]");
    if (!cfg.relayer.key) throw new Error("RELAYER_PRIVATE_KEY is required (deploy first)");
    const name = arg("name") ?? "lagos-prints";
    const id = `${name}.${cfg.root.id}`;
    const chain = new Chain(cfg.rpc, cfg.network);
    const relayer = chain.account(cfg.relayer.id, cfg.relayer.key);

    // 1. The account, via the factory.
    let full = process.env.DEMO_MERCHANT_PRIVATE_KEY as KeyPairString | undefined;
    let appKey = process.env.DEMO_MERCHANT_APP_KEY as KeyPairString | undefined;
    const exists = await chain.account(id).getState().then(() => true, () => false);
    io.step(`1. ${id}`);
    if (!exists) {
      const f = KeyPair.fromRandom("ed25519");
      const a = KeyPair.fromRandom("ed25519");
      const call = factoryCalls(cfg.root.id).createName(name, f.getPublicKey().toString(), a.getPublicKey().toString());
      if (!(await io.approve({ title: `create ${id}`, signer: cfg.relayer.id, receiver: cfg.root.id, details: describeActions(call.actions) }))) process.exit(0);
      const r = await chain.send<boolean>(relayer, call);
      if (!r.ok || r.value !== true) throw new Error(`create_name failed: ${r.error ?? "returned false"}`);
      saveKeyToEnv("DEMO_MERCHANT_ACCOUNT_ID", id);
      saveKeyToEnv("DEMO_MERCHANT_PRIVATE_KEY", f.toString());
      saveKeyToEnv("DEMO_MERCHANT_APP_KEY", a.toString());
      full = f.toString() as KeyPairString;
      appKey = a.toString() as KeyPairString;
      io.log(`✓ created, tx ${r.hash}; keys saved to .env (${maskKey(full)})`);
    } else if (!full || !appKey) {
      throw new Error(`${id} exists but DEMO_MERCHANT_PRIVATE_KEY / DEMO_MERCHANT_APP_KEY are not in .env; pick another --name`);
    } else io.log("exists");

    // 2. Register with Cascade, fee-free.
    io.step("2. Register with Cascade (fee-free)");
    if (await chain.view(cfg.app, "get_owner", { id })) io.log("already registered");
    else {
      const d = decodeSignedDelegate(await signMeta(chain.account(id, appKey), appCalls(cfg.app).registerOwner("Account", [])));
      if (!(await io.approve({ title: "relay register_owner (NEP-366)", signer: cfg.relayer.id, receiver: id, details: [`inner: ${cfg.app}.register_owner`] }))) process.exit(0);
      const r = await chain.send(relayer, relayCall(d.raw), { target: cfg.app });
      if (!r.ok) throw new Error(`register failed: ${r.error}`);
      io.log(`✓ registered, tx ${r.hash}`);
    }

    // 3. Onboard to the hosted API with an NEP-413 signature (no transaction, no cost).
    io.step(`3. Onboard to ${api}`);
    if (dryRun) {
      io.log("dry run: skipped");
      process.exit(0);
    }
    const issuedAt = new Date().toISOString();
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const shopName = "Lagos Prints";
    const signed = await chain.account(id, full).signNep413Message({ message: onboardingMessage({ account: id, name: shopName, issuedAt }), recipient: ONBOARDING_RECIPIENT, nonce });
    const res = await fetch(`${api}/v1/merchants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: id, name: shopName, webhookUrl: `${web}/api/shop/webhook`,
        proof: { signer: id, publicKey: signed.publicKey.toString(), signature: Buffer.from(signed.signature).toString("base64"), nonce: Buffer.from(nonce).toString("base64"), issuedAt },
      }),
    });
    const j = (await res.json()) as { secretKey?: string; webhookSecret?: string; error?: { message: string } };
    if (res.status !== 201 || !j.secretKey || !j.webhookSecret) throw new Error(`onboarding failed (${res.status}): ${j.error?.message}`);
    saveKeyToEnv("DEMO_SHOP_SECRET_KEY", j.secretKey);
    saveKeyToEnv("DEMO_SHOP_WEBHOOK_SECRET", j.webhookSecret);
    io.step("Done. Set these on the web app (Vercel), then redeploy it:");
    io.log("CASCADE_SECRET_KEY      = the value of DEMO_SHOP_SECRET_KEY in your .env");
    io.log("CASCADE_WEBHOOK_SECRET  = the value of DEMO_SHOP_WEBHOOK_SECRET in your .env");
    io.log(`Dashboard: ${web}/dashboard (paste the secret key)`);
  } catch (e) {
    io.warn((e as Error).message);
    process.exitCode = 1;
  } finally {
    io.close();
  }
}
