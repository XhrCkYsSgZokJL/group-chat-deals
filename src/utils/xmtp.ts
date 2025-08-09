import { getRandomValues } from "node:crypto";
import { IdentifierKind, type Signer } from "@xmtp/node-sdk";
import { fromString, toString } from "uint8arrays";
import { createWalletClient, http, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

// Environment validation
export function validateEnvironment(vars: string[]): Record<string, string> {
  const missing = vars.filter(v => !process.env[v]);

  if (missing.length) {
    console.error("Missing env vars:", missing.join(", "));
    process.exit(1);
  }

  return vars.reduce<Record<string, string>>((acc, key) => {
    acc[key] = process.env[key] as string;
    return acc;
  }, {});
}

// User interface and creation
interface User {
  key: `0x${string}`;
  account: ReturnType<typeof privateKeyToAccount>;
  wallet: ReturnType<typeof createWalletClient>;
}

export const createUser = (key: string): User => {
  const account = privateKeyToAccount(key as `0x${string}`);
  return {
    key: key as `0x${string}`,
    account,
    wallet: createWalletClient({
      account,
      chain: sepolia,
      transport: http(),
    }),
  };
};

// XMTP signer creation
export const createSigner = (key: string): Signer => {
  const sanitizedKey = key.startsWith("0x") ? key : `0x${key}`;
  const user = createUser(sanitizedKey);
  
  return {
    type: "EOA",
    getIdentifier: () => ({
      identifierKind: IdentifierKind.Ethereum,
      identifier: user.account.address.toLowerCase(),
    }),
    signMessage: async (message: string) => {
      const signature = await user.wallet.signMessage({
        message,
        account: user.account,
      });
      return toBytes(signature);
    },
  };
};

// Encryption key utilities
export const generateEncryptionKeyHex = (): string => {
  const uint8Array = getRandomValues(new Uint8Array(32));
  return toString(uint8Array, "hex");
};

export const getEncryptionKeyFromHex = (hex: string): Uint8Array => {
  return fromString(hex, "hex");
};