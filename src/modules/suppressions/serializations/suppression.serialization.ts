import type { Suppression } from "../types/suppression.types.ts";

/**
 * Public response shape. Drops `apiKeyId` — the caller already knows
 * which key they're scoped to (it's their own auth token), and exposing
 * it back is needless noise. Everything else passes through unchanged.
 */
export interface SerializedSuppression {
  id: string;
  email: string;
  reason: string;
  bounceType: string | null;
  diagnosticCode: string | null;
  sourceEmailId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export function serializeSuppression(row: Suppression): SerializedSuppression {
  return {
    id: row.id,
    email: row.email,
    reason: row.reason,
    bounceType: row.bounceType,
    diagnosticCode: row.diagnosticCode,
    sourceEmailId: row.sourceEmailId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}
