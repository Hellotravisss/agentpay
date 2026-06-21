import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { PaymentContext } from "../types.js";
import { parseAmount } from "../money.js";

/**
 * Real x402 "exact" scheme client-side payment: an EIP-3009
 * transferWithAuthorization signature over the requested asset (USDC),
 * base64-encoded into the X-PAYMENT header. Signing is fully offline — the
 * merchant's facilitator verifies the signature and settles it on-chain, so
 * the gateway needs no RPC connection, only the agent treasury's key.
 */

export const CHAIN_IDS: Record<string, number> = {
  base: 8453,
  "base-sepolia": 84532,
};

/** Circle's canonical USDC deployments, used when a 402 omits the asset address. */
export const DEFAULT_USDC: Record<string, Hex> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface X402Authorization {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface X402PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: Hex;
    authorization: X402Authorization;
  };
}

export interface Eip3009SignerOptions {
  /** Hex private key of the agent treasury wallet (fund it with testnet USDC for Base Sepolia). */
  privateKey: Hex;
  /**
   * Asset contracts the signer is willing to sign for, per network. Defaults to
   * canonical USDC only. This is the SSRF-equivalent guard for signing: without
   * it, a malicious 402 could name an arbitrary (more valuable) token as the
   * asset and trick the wallet into authorizing a transfer of it. A merchant
   * asset that isn't on this list is refused.
   */
  allowedAssets?: Record<string, Hex[]>;
  /**
   * Symbol the settled asset is denominated in (default "USDC"). The signer
   * refuses unless `requirement.currency` matches it. This stops a merchant from
   * mislabeling the currency (e.g. "CNY") so the policy budget — which values the
   * payment via that currency's FX rate — under-counts, while the chain still
   * transfers `amount` units of USDC.
   */
  assetSymbol?: string;
  /** Hard cap (seconds) on how long a signed authorization stays valid, regardless of what the 402 asks. */
  maxAuthorizationSeconds?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Build a signPayment callback for X402Rail. Returns the base64 X-PAYMENT
 * header value carrying a signed EIP-3009 authorization the facilitator can
 * settle. Amounts are converted to 6-dp atomic units (USDC precision).
 */
export function createEip3009Signer(options: Eip3009SignerOptions) {
  const account = privateKeyToAccount(options.privateKey);
  const now = options.now ?? Date.now;
  const allowedAssets = options.allowedAssets ?? {
    base: [DEFAULT_USDC.base!],
    "base-sepolia": [DEFAULT_USDC["base-sepolia"]!],
  };
  const maxAuthSeconds = options.maxAuthorizationSeconds ?? 600;
  const assetSymbol = options.assetSymbol ?? "USDC";

  return async (ctx: PaymentContext): Promise<string> => {
    const { requirement: req } = ctx;
    const chainId = CHAIN_IDS[req.network];
    if (chainId === undefined) {
      throw new Error(`Unknown x402 network "${req.network}"`);
    }
    const allowed = allowedAssets[req.network];
    if (!allowed || allowed.length === 0) {
      throw new Error(`No allowlisted asset for network "${req.network}"`);
    }
    const asset = (req.asset as Hex | undefined) ?? allowed[0]!;
    if (!allowed.some((a) => a.toLowerCase() === asset.toLowerCase())) {
      // Refuse to sign a transfer of a token the operator hasn't allowlisted.
      throw new Error(`Refusing to sign: asset ${asset} is not allowlisted for "${req.network}"`);
    }
    if (req.currency.toUpperCase() !== assetSymbol.toUpperCase()) {
      // Currency must match the settled asset, or the policy budget under-counts the real spend.
      throw new Error(`Refusing to sign: currency "${req.currency}" does not match settlement asset "${assetSymbol}"`);
    }

    const nowSec = Math.floor(now() / 1000);
    // Ignore a non-positive / non-finite merchant timeout (would sign an already-expired auth); cap at the max.
    const requested = req.maxTimeoutSeconds;
    const ttl = typeof requested === "number" && requested > 0 ? Math.min(requested, maxAuthSeconds) : maxAuthSeconds;
    const authorization: X402Authorization = {
      from: account.address,
      to: req.payTo as Hex,
      value: parseAmount(req.amount).toString(),
      validAfter: "0",
      validBefore: String(nowSec + ttl),
      nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
    };

    const signature = await account.signTypedData({
      domain: {
        name: req.extra?.name ?? "USDC",
        version: req.extra?.version ?? "2",
        chainId,
        verifyingContract: asset,
      },
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });

    const payload: X402PaymentPayload = {
      x402Version: 1,
      scheme: req.scheme,
      network: req.network,
      payload: { signature, authorization },
    };
    return Buffer.from(JSON.stringify(payload)).toString("base64");
  };
}

/** Decode an X-PAYMENT header produced by createEip3009Signer (for tests/inspection). */
export function decodeXPayment(header: string): X402PaymentPayload {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as X402PaymentPayload;
}
