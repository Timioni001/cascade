/**
 * Connects MockOneClick to a real NEAR network whose USDC is the Cascade mock
 * token (sandbox, testnet demo). "Delivering" a swap mints mock USDC to the
 * recipient, exactly where 1Click would deliver real USDC:
 *   - plain delivery: mint to the recipient;
 *   - with customRecipientMsg: mint to the minter, then ft_transfer_call to
 *     the recipient with that msg (how revenue splits receive payments).
 * Never used with real USDC: the mock token's `mint` does not exist there.
 */
import { actions, type Account } from "near-api-js";
import { ftCalls, type Chain } from "@cascade/near";
import type { MockDriver } from "@cascade/oneclick";
import { expectOk } from "./executor.js";

export function mintingDriver(chain: Chain, minter: Account, usdc: string): MockDriver {
  return {
    deliverUsdc: async (recipient, amount, msg) => {
      if (msg === undefined) return expectOk(await chain.send(minter, ftCalls(usdc).mint(recipient, amount)), "mock delivery").hash;
      expectOk(await chain.send(minter, ftCalls(usdc).mint(minter.accountId, amount)), "mock mint");
      const call = {
        receiverId: usdc,
        label: "mock delivery with msg",
        actions: [actions.functionCall("ft_transfer_call", { receiver_id: recipient, amount: amount.toString(), msg }, 100n * 10n ** 12n, 1n)],
      };
      return expectOk(await chain.send(minter, call), "mock delivery (ft_transfer_call)").hash;
    },
    usdcBalance: (account) => chain.ftBalance(usdc, account),
  };
}
