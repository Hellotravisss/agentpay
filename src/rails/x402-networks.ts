/**
 * x402 v2 names networks in CAIP-2 form ("eip155:84532"); v1 used short names
 * ("base-sepolia"). Policies, rail config and the signer's chain table are all
 * keyed by the short names, so v2 networks are normalized on the way in. The
 * merchant's original CAIP-2 string is still echoed back verbatim inside the
 * v2 `accepted` object — only our internal routing uses the short name.
 *
 * Unknown CAIP-2 ids (other chains, Solana, ...) are passed through unchanged:
 * no configured rail will claim them, so they fall out of routing cleanly.
 */
const CAIP2_TO_NAME: Record<string, string> = {
  "eip155:8453": "base",
  "eip155:84532": "base-sepolia",
};

export function normalizeX402Network(network: string): string {
  return CAIP2_TO_NAME[network] ?? network;
}
