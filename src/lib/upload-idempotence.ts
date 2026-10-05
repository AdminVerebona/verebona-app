/**
 * Idempotence du dépôt — APP-PERF-30 (serveur).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE OPÉRATION LOGIQUE = UN FICHIER = AU PLUS UN DOCUMENT
 *
 * Le client tire un identifiant d'opération (`operationId`, UUID) par
 * fichier déposé et le présente à `presign` puis à `confirm`. Il est stocké
 * sur la ligne `asset_files` (`upload_operation_id`, unique par
 * utilisateur — migration 0241) avec l'empreinte de la demande.
 *
 *   · presign rejoué, même demande : même `fileId`, nouvelle URL signée pour
 *     la même clé S3 (ligne PENDING) ou « déjà confirmé » (COMPLETED) ;
 *   · confirm rejoué, même demande, fichier déjà confirmé : le résultat
 *     existant est rendu (plus d'INVALID_STATUS trompeur après une réponse
 *     perdue), sans nouvel événement ni nouvelle analyse ;
 *   · même clé, demande différente : refus 409 — l'idempotence n'est pas
 *     l'acceptation de n'importe quelle mutation répétée.
 *
 * Sans `operationId` (clients ouverts avant ce contrat, vignettes de biens),
 * le comportement antérieur est conservé à l'identique.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'crypto';

/** Clé d'opération acceptée : UUID ou jeton opaque court, sans espace. */
const CLE_OPERATION = /^[A-Za-z0-9_-]{16,64}$/;

export function estCleOperation(v: unknown): v is string {
  return typeof v === 'string' && CLE_OPERATION.test(v);
}

/** JSON canonique : clés triées, `undefined` → `null`. */
function canonique(v: unknown): unknown {
  if (v === undefined) return null;
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canonique);
  return Object.fromEntries(
    Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canonique((v as Record<string, unknown>)[k])]),
  );
}

export function empreinteCanonique(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonique(v))).digest('hex');
}

/** Empreinte d'une demande d'URL signée. */
export function empreintePresign(d: {
  accountId: number; assetId: number | null; filename: string; mimeType: string; size: number; sha256Hash: string;
}): string {
  return empreinteCanonique({ v: 1, ...d });
}

const entierOuNull = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '' || v === 0 || v === '0') return null;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
};
const texteOuNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Empreinte des métadonnées d'une confirmation (valeurs normalisées). */
export function empreinteConfirm(body: Record<string, unknown>): string {
  return empreinteCanonique({
    v: 1,
    assetId: entierOuNull(body.assetId),
    documentType: texteOuNull(body.documentType),
    documentDate: texteOuNull(body.documentDate),
    description: texteOuNull(body.description),
    supplier: texteOuNull(body.supplier),
    amountCents: body.amountCents === undefined || body.amountCents === null ? null : entierOuNull(body.amountCents),
    substructureId: entierOuNull(body.substructureId),
    equipmentId: entierOuNull(body.equipmentId),
  });
}

/** État d'une ligne au regard d'une opération rejouée. */
export interface LigneOperation {
  uploadStatus: string | null;
  deletedAt: Date | string | null;
  uploadOperationId: string | null;
  uploadRequestFingerprint?: string | null;
  confirmFingerprint?: string | null;
}

export type DecisionPresign =
  | { kind: 'pending' }
  | { kind: 'completed' }
  | { kind: 'refus'; status: 409; code: 'IDEMPOTENCY_KEY_REUSED' | 'OPERATION_CLOSED'; message: string };

/** Presign rejoué : que faire de la ligne existante ? */
export function deciderPresignRejoue(ligne: LigneOperation, empreinte: string): DecisionPresign {
  if (ligne.uploadRequestFingerprint && ligne.uploadRequestFingerprint !== empreinte) {
    return {
      kind: 'refus', status: 409, code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'Cet identifiant d’opération a déjà servi pour un autre fichier.',
    };
  }
  if (ligne.deletedAt || (ligne.uploadStatus !== 'PENDING' && ligne.uploadStatus !== 'COMPLETED')) {
    return {
      kind: 'refus', status: 409, code: 'OPERATION_CLOSED',
      message: 'Ce dépôt a été abandonné ou refusé. Relancez-le depuis le début.',
    };
  }
  return ligne.uploadStatus === 'COMPLETED' ? { kind: 'completed' } : { kind: 'pending' };
}

export type DecisionConfirm =
  | { kind: 'nouvelle' }
  | { kind: 'deja_confirme' }
  | { kind: 'refus'; status: 400 | 409; code: string; message: string };

/**
 * Confirmation d'UN fichier : nouvelle confirmation, rejeu d'une
 * confirmation réussie, ou refus explicite.
 */
export function deciderConfirm(ligne: LigneOperation, operationId: string | null, empreinte: string): DecisionConfirm {
  if (ligne.deletedAt) {
    return {
      kind: 'refus', status: 409, code: 'FILE_DISCARDED',
      message: 'Ce dépôt a été abandonné ou refusé et ne peut plus être confirmé. Relancez-le depuis le début.',
    };
  }
  if (operationId && ligne.uploadOperationId && ligne.uploadOperationId !== operationId) {
    return {
      kind: 'refus', status: 409, code: 'IDEMPOTENCY_KEY_MISMATCH',
      message: 'Cet identifiant d’opération ne correspond pas à ce fichier.',
    };
  }
  if (ligne.uploadStatus === 'PENDING') return { kind: 'nouvelle' };
  if (
    ligne.uploadStatus === 'COMPLETED' && operationId && ligne.uploadOperationId === operationId
  ) {
    if (ligne.confirmFingerprint && ligne.confirmFingerprint !== empreinte) {
      return {
        kind: 'refus', status: 409, code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        message: 'Ce fichier a déjà été enregistré avec d’autres informations.',
      };
    }
    return { kind: 'deja_confirme' };
  }
  return {
    kind: 'refus', status: 400, code: 'INVALID_STATUS',
    message: `File is not in PENDING status. Current status: ${ligne.uploadStatus}`,
  };
}
