import { eq } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from "../../../utils/crypto.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";
import type { AuditContext } from "../../audit/types/audit.types.ts";
import type { Tx } from "../../users/types/user.types.ts";
import { domains } from "../models/domain.schema.ts";
import type { Domain } from "../types/domain.types.ts";
import { DkimRotationError } from "../errors.ts";
import {
  datedDkimSelector,
  dkimRecordHost,
  dkimRecordsMatchKey,
  generateDkimKeyPair,
} from "./dkim-keys.ts";
import { resolveDomainTxt } from "./domain-dns-status.service.ts";

/**
 * DKIM key rotation without downtime (#250), in three operator steps:
 *
 * 1. **Start** generates the next key under a dated selector
 *    (`bm<YYYYMMDD>`) and stores it as pending. Mail keeps being signed
 *    with the active key: the queue only ever reads the active columns.
 * 2. The operator publishes the pending TXT record next to the current one.
 * 3. **Complete** checks that the pending selector's TXT record carries the
 *    pending key (the comparison Verify uses), then, in one transaction,
 *    makes it the active key and keeps the old selector and public key as
 *    `previous` (informational: its private key is dropped, BunMail never
 *    signs with it). **Cancel** drops the pending key instead.
 *
 * Each applied step is audited in its own transaction (selector only, never
 * key material). A complete refused because the record is not published
 * is logged at `info`, not audited: nothing changed.
 */

/** The TXT lookup of the publish check; the domains DNS seam by default. */
export interface DkimRotationDeps {
  resolveTxt: (hostname: string) => Promise<string[][]>;
}

const defaultDeps: DkimRotationDeps = { resolveTxt: resolveDomainTxt };

/** DNS answers meaning "no such record", as opposed to a failed lookup. */
const NO_RECORD_CODES = new Set(["ENOTFOUND", "ENODATA"]);

/** Whether a selector's TXT record publishes a key, and why not. */
export interface DkimPublishCheck {
  ok: boolean;
  reason: string;
}

/**
 * Looks up `<selector>._domainkey.<domain>` and compares it with
 * `publicKeyPem` (`dkimRecordsMatchKey`, as Verify does). Never throws.
 */
export async function checkDkimKeyPublished(
  domainName: string,
  selector: string,
  publicKeyPem: string,
  deps: DkimRotationDeps = defaultDeps,
): Promise<DkimPublishCheck> {
  const host = dkimRecordHost(selector, domainName);
  let records: string[];
  try {
    records = (await deps.resolveTxt(host)).map((parts) => parts.join(""));
  } catch (error: unknown) {
    const code =
      error instanceof Error && "code" in error ? String(Reflect.get(error, "code")) : "";
    if (!NO_RECORD_CODES.has(code)) {
      return {
        ok: false,
        reason: `DNS lookup of ${host} failed (temporary): try again later`,
      };
    }
    records = [];
  }
  if (records.length === 0) {
    return { ok: false, reason: `No TXT record at ${host} yet` };
  }
  if (!dkimRecordsMatchKey(records, publicKeyPem)) {
    return {
      ok: false,
      reason: `The TXT record at ${host} does not carry the pending public key: publish the value shown for it`,
    };
  }
  return { ok: true, reason: `The pending key is published at ${host}` };
}

/** Locks one domain row for the rest of the transaction. */
async function lockDomain(tx: Tx, id: string): Promise<Domain | undefined> {
  const [row] = await tx.select().from(domains).where(eq(domains.id, id)).for("update");
  return row;
}

/**
 * Starts a rotation: a new RSA 2048 key pair under a dated selector,
 * stored as pending (private key encrypted like the active one).
 *
 * @returns The updated domain, or undefined when no domain has this id
 * @throws DkimRotationError `DKIM_ROTATION_PENDING` when one is already pending
 */
export async function startDkimRotation(
  id: string,
  audit: AuditContext,
  now: Date = new Date(),
): Promise<Domain | undefined> {
  /** Generated before the transaction: it takes a moment, the row lock should not. */
  const { privateKey, publicKey } = await generateDkimKeyPair();
  const encryptedPrivateKey = encryptSecret(privateKey, config.dkimEncryptionKey);

  const updated = await db.transaction(async (tx) => {
    const row = await lockDomain(tx, id);
    if (!row) return undefined;
    if (row.dkimPendingSelector !== null) {
      logger.warn("DKIM rotation not started: one is already pending", {
        domainId: id,
        pendingSelector: row.dkimPendingSelector,
      });
      throw new DkimRotationError(
        "DKIM_ROTATION_PENDING",
        `A DKIM key rotation is already pending (selector ${row.dkimPendingSelector}): complete or cancel it first.`,
      );
    }
    const selector = datedDkimSelector(now, [row.dkimSelector, row.dkimPreviousSelector]);
    const [changed] = await tx
      .update(domains)
      .set({
        dkimPendingSelector: selector,
        dkimPendingPrivateKey: encryptedPrivateKey,
        dkimPendingPublicKey: publicKey,
        dkimPendingCreatedAt: now,
        updatedAt: now,
      })
      .where(eq(domains.id, id))
      .returning();
    await recordAuditEvent(
      {
        ...audit,
        action: "domain.dkim_rotation_started",
        target: { type: "domain", id, label: row.name },
        metadata: { selector },
      },
      tx,
    );
    return changed;
  });

  if (updated) {
    logger.info("DKIM rotation started", {
      domainId: id,
      selector: updated.dkimPendingSelector,
      activeSelector: updated.dkimSelector,
    });
  }
  return updated;
}

/** Whether a stored private key can be used to sign (`v1:` decrypts, or legacy plaintext). */
function privateKeyReadable(stored: string): boolean {
  if (!isEncryptedSecret(stored)) return true;
  try {
    decryptSecret(stored, config.dkimEncryptionKey);
    return true;
  } catch {
    return false;
  }
}

/** The refusal of a complete or cancel with nothing pending. */
function noPendingRotation(): DkimRotationError {
  return new DkimRotationError(
    "DKIM_NO_PENDING_ROTATION",
    "No DKIM key rotation is pending for this domain.",
  );
}

/**
 * Completes the pending rotation once its TXT record is published: the
 * pending key becomes the active one, the old selector and public key are
 * kept as `previous` with the switch time, and DKIM counts as verified
 * (the record of the new key was just found).
 *
 * @returns The updated domain, or undefined when no domain has this id
 * @throws DkimRotationError `DKIM_NO_PENDING_ROTATION`, `DKIM_PENDING_KEY_UNREADABLE`
 *   or `DKIM_PENDING_NOT_PUBLISHED` (with the reason); nothing changes then
 */
export async function completeDkimRotation(
  id: string,
  audit: AuditContext,
  deps: DkimRotationDeps = defaultDeps,
  now: Date = new Date(),
): Promise<Domain | undefined> {
  const [domain] = await db.select().from(domains).where(eq(domains.id, id));
  if (!domain) return undefined;
  const selector = domain.dkimPendingSelector;
  const publicKey = domain.dkimPendingPublicKey;
  const privateKey = domain.dkimPendingPrivateKey;
  if (selector === null || publicKey === null || privateKey === null) {
    logger.warn("DKIM rotation not completed: none pending", { domainId: id });
    throw noPendingRotation();
  }

  /**
   * Switching to a key that does not decrypt would hold every send from
   * the domain in production (#244): refuse, the operator cancels and
   * starts again.
   */
  if (!privateKeyReadable(privateKey)) {
    logger.warn("DKIM rotation not completed: pending key does not decrypt", {
      domainId: id,
      selector,
    });
    throw new DkimRotationError(
      "DKIM_PENDING_KEY_UNREADABLE",
      "The pending private key does not decrypt with DKIM_ENCRYPTION_KEY: cancel the rotation and start a new one.",
    );
  }

  /** The DNS lookup runs before the transaction: no row lock across it. */
  const check = await checkDkimKeyPublished(domain.name, selector, publicKey, deps);
  if (!check.ok) {
    logger.info("DKIM rotation not completed: pending key not published", {
      domainId: id,
      selector,
      reason: check.reason,
    });
    throw new DkimRotationError("DKIM_PENDING_NOT_PUBLISHED", check.reason);
  }

  const updated = await db.transaction(async (tx) => {
    const row = await lockDomain(tx, id);
    if (!row) return undefined;
    if (row.dkimPendingSelector === null) {
      logger.warn("DKIM rotation not completed: cancelled meanwhile", { domainId: id });
      throw noPendingRotation();
    }
    /** Cancelled and restarted while the record was looked up: that key was not checked. */
    if (row.dkimPendingSelector !== selector || row.dkimPendingPublicKey !== publicKey) {
      logger.warn("DKIM rotation not completed: pending key changed meanwhile", {
        domainId: id,
        selector,
      });
      throw new DkimRotationError(
        "DKIM_PENDING_NOT_PUBLISHED",
        "The pending key changed while its DNS record was checked: complete the rotation again.",
      );
    }
    const [changed] = await tx
      .update(domains)
      .set({
        dkimSelector: selector,
        dkimPrivateKey: privateKey,
        dkimPublicKey: publicKey,
        dkimVerified: true,
        dkimPreviousSelector: row.dkimSelector,
        dkimPreviousPublicKey: row.dkimPublicKey,
        dkimRotatedAt: now,
        dkimPendingSelector: null,
        dkimPendingPrivateKey: null,
        dkimPendingPublicKey: null,
        dkimPendingCreatedAt: null,
        updatedAt: now,
      })
      .where(eq(domains.id, id))
      .returning();
    await recordAuditEvent(
      {
        ...audit,
        action: "domain.dkim_rotation_completed",
        target: { type: "domain", id, label: row.name },
        metadata: { selector },
      },
      tx,
    );
    return changed;
  });

  if (updated) {
    logger.info("DKIM rotation completed", {
      domainId: id,
      selector: updated.dkimSelector,
      previousSelector: updated.dkimPreviousSelector,
    });
  }
  return updated;
}

/**
 * Cancels the pending rotation: the pending selector and key are dropped,
 * the active key is untouched.
 *
 * @returns The updated domain, or undefined when no domain has this id
 * @throws DkimRotationError `DKIM_NO_PENDING_ROTATION` when none is pending
 */
export async function cancelDkimRotation(
  id: string,
  audit: AuditContext,
): Promise<Domain | undefined> {
  const result = await db.transaction(async (tx) => {
    const row = await lockDomain(tx, id);
    if (!row) return undefined;
    const selector = row.dkimPendingSelector;
    if (selector === null) {
      logger.warn("DKIM rotation not cancelled: none pending", { domainId: id });
      throw noPendingRotation();
    }
    const [changed] = await tx
      .update(domains)
      .set({
        dkimPendingSelector: null,
        dkimPendingPrivateKey: null,
        dkimPendingPublicKey: null,
        dkimPendingCreatedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(domains.id, id))
      .returning();
    await recordAuditEvent(
      {
        ...audit,
        action: "domain.dkim_rotation_cancelled",
        target: { type: "domain", id, label: row.name },
        metadata: { selector },
      },
      tx,
    );
    return changed === undefined ? undefined : { domain: changed, selector };
  });

  if (result) {
    logger.info("DKIM rotation cancelled", {
      domainId: id,
      selector: result.selector,
    });
  }
  return result?.domain;
}
