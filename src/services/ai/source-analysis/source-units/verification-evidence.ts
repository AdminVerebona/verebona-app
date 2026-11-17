/**
 * Lot 115H (Trello #785, § 7) — INVENTAIRE DES VÉRIFICATIONS INCOMPLÈTES ET
 * DES PREUVES DÉTERMINISTES RÉELLEMENT DISPONIBLES.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE MODULE FAIT — ET CE QU'IL NE FAIT PAS
 *
 * La carte demande d'examiner les vérifications incomplètes du corpus (dont le
 * JPEG #389), page par page et document par document, et de les classer :
 * source illisible, omission prouvée, contrôle améliorable, scan ou image sans
 * preuve indépendante, couverture reconstruite (backfill). Elle interdit
 * explicitement d'inventer une voie de preuve ou d'annoncer cette partie comme
 * validée.
 *
 * Ce module CLASSE, à partir des SEULES preuves déjà persistées, et dit pour
 * chaque cas s'il existe une voie probante AUJOURD'HUI :
 *   · `DETERMINISTIC_REVERIFICATION` — le texte original de la source est en
 *     base (`document_raw_extracts`) et n'a pas encore été confronté à la
 *     lecture T1 dans sa forme actuelle : la confrontation déterministe du lot
 *     109K (aucun appel, aucun téléchargement) peut trancher. C'est une voie
 *     EXISTANTE, pas une voie nouvelle ;
 *   · `NONE` — aucune preuve indépendante n'est disponible. Ce qu'il
 *     FAUDRAIT est alors nommé (`whatWouldBeNeeded`), sans être promis : une
 *     capacité qui n'existe pas dans l'application à ce jour n'est pas une
 *     voie de preuve.
 *
 * Ce module N'INVENTE RIEN : il ne lit aucun fichier, n'appelle aucun modèle,
 * n'écrit rien, et ne promeut aucune unité. Un document sans preuve reste
 * VERIFICATION_INCOMPLETE avec son motif.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { SOURCE_VERIFIER_VERSION } from './source-verification';
import type { T1CoverageDiagnostics } from './types';

type Row = Record<string, unknown>;

/** Les cinq situations nommées par la carte (§ 7). */
export const VERIFICATION_GAP_KINDS = [
  'SOURCE_UNREADABLE', 'OMISSION_PROVEN', 'CHECK_IMPROVABLE', 'NO_INDEPENDENT_EVIDENCE', 'BACKFILL',
] as const;
export type VerificationGapKind = (typeof VERIFICATION_GAP_KINDS)[number];

/** Libellés administrateur (textes nouveaux — à valider par le PO). */
export const VERIFICATION_GAP_LABEL: Readonly<Record<VerificationGapKind, string>> = {
  SOURCE_UNREADABLE: 'source illisible',
  OMISSION_PROVEN: 'omission prouvée',
  CHECK_IMPROVABLE: 'contrôle améliorable',
  NO_INDEPENDENT_EVIDENCE: 'scan ou image sans preuve indépendante',
  BACKFILL: 'couverture reconstruite, jamais confrontée au fichier',
};

/** Voies de preuve EXISTANTES (aucune n'est inventée ici). */
export type ProbativePath = 'DETERMINISTIC_REVERIFICATION' | 'NONE';

export interface VerificationGapInput {
  fileId: number;
  qualityState: string;
  sourceVerification?: string | null;
  /** Diagnostics persistés (`verification`) — compteurs et codes seulement. */
  verification?: Record<string, unknown> | null;
  /** Le texte original de la source est-il en base, exploitable (extraction réussie, pages connues) ? */
  textLayerAvailable: boolean;
  /** Empreinte de la source actuellement en base (null : aucune). */
  sourceSha256?: string | null;
  /** Nombre d'unités de la couche A (une lecture T1 existe-t-elle ?). */
  unitCount: number;
}

export interface VerificationGapVerdict {
  fileId: number;
  kind: VerificationGapKind;
  label: string;
  /** Motif vérifiable, en codes et compteurs (jamais de contenu de document). */
  reason: string;
  /** Pages concernées, telles que les diagnostics les consignent. */
  pages: { expected: number; verified: number; missing: number[]; unverified: number[] };
  probativePath: ProbativePath;
  /**
   * Ce qu'il faudrait pour trancher quand aucune voie n'existe. Jamais une
   * promesse : une capacité absente de l'application n'est pas une voie.
   */
  whatWouldBeNeeded: string | null;
  /** Une action automatique est-elle utile ? (faux : ni alerte de réparation, ni relance périodique) */
  actionable: boolean;
}

const nombres = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

/**
 * CLASSEMENT d'une vérification incomplète (pure). L'ordre des cas est celui de
 * la preuve la plus forte à la plus faible : une omission OBJECTIVÉE primes sur
 * une limite de contrôle, et une source illisible primes sur tout (rien n'a pu
 * être lu).
 */
export function classifyVerificationGap(p: VerificationGapInput): VerificationGapVerdict {
  const d = (p.verification ?? {}) as Partial<T1CoverageDiagnostics> & Record<string, unknown>;
  const motif = typeof d.verificationReason === 'string' ? d.verificationReason : null;
  const manquantes = nombres(d.pagesMissing);
  const nonVerifiees = nombres(d.pagesUnverified);
  const attendues = Number(d.pagesExpected ?? 0) || 0;
  const verifiees = Number(d.pagesVerified ?? 0) || 0;
  const pages = { expected: attendues, verified: verifiees, missing: manquantes, unverified: nonVerifiees };
  const vue = (kind: VerificationGapKind, reason: string, probativePath: ProbativePath, whatWouldBeNeeded: string | null, actionable: boolean): VerificationGapVerdict =>
    ({ fileId: p.fileId, kind, label: VERIFICATION_GAP_LABEL[kind], reason, pages, probativePath, whatWouldBeNeeded, actionable });

  // 1. La source n'a pas pu être lue du tout : ce n'est pas une limite de contrôle, c'est un incident de fichier.
  if (motif === 'source_unreadable' || motif === 'pdf_unreadable' || motif === 'source_too_large') {
    return vue('SOURCE_UNREADABLE', `source non lue (${motif})`, 'NONE',
      'un nouveau dépôt du fichier, ou le rétablissement de son accès : tant que la source n’est pas lisible, aucune preuve ne peut être produite', true);
  }
  // 2. Omission OBJECTIVÉE : des pages du texte original sont absentes de la lecture — c'est une preuve, pas un doute.
  if (manquantes.length > 0) {
    return vue('OMISSION_PROVEN', `${manquantes.length} page(s) du texte original absente(s) de la lecture (pages ${manquantes.join(', ')})`,
      'DETERMINISTIC_REVERIFICATION', null, true);
  }
  // 3. Couverture RECONSTRUITE d'une analyse antérieure : jamais confrontée au fichier.
  if (p.sourceVerification === 'RECONSTRUCTED' || motif === 'backfill') {
    return p.textLayerAvailable && p.unitCount > 0
      ? vue('BACKFILL', 'couverture reconstruite ; un texte original est en base et n’a jamais été confronté à la lecture',
        'DETERMINISTIC_REVERIFICATION', null, true)
      : vue('BACKFILL', 'couverture reconstruite ; aucun texte original en base pour la confronter', 'NONE',
        'l’extraction du texte original de ce fichier (reprise du texte brut), puis la confrontation déterministe existante', false);
  }
  // 4. Contrôle AMÉLIORABLE : la preuve existe en base et la confrontation courante n'a pas encore été faite.
  if (p.textLayerAvailable && p.unitCount > 0 && Number(d.verifierVersion ?? 1) < SOURCE_VERIFIER_VERSION) {
    return vue('CHECK_IMPROVABLE',
      `texte original en base, confronté par une version antérieure du vérificateur (v${Number(d.verifierVersion ?? 1)} < v${SOURCE_VERIFIER_VERSION})`,
      'DETERMINISTIC_REVERIFICATION', null, true);
  }
  // 5. Aucune preuve indépendante : image, scan sans couche texte, format non contrôlable page par page.
  const sans = p.textLayerAvailable
    ? `aucune page confrontable (${nonVerifiees.length} page(s) sans texte original exploitable)`
    : `aucun texte original indépendant en base${motif ? ` (${motif})` : ''}`;
  return vue('NO_INDEPENDENT_EVIDENCE', sans, 'NONE',
    'une seconde lecture INDÉPENDANTE de l’image (capacité absente de l’application à ce jour) ou un contrôle visuel humain motivé, dans le cadre du § 1 : '
    + 'aucune relecture par le même moyen n’apporterait de preuve nouvelle', false);
}

export interface VerificationGapInventory {
  documents: number;
  byKind: Record<string, number>;
  byProbativePath: Record<string, number>;
  verdicts: VerificationGapVerdict[];
  /** Couche A absente : rien n'a pu être inventorié. */
  unavailable?: boolean;
}

/**
 * Inventaire des documents en VERIFICATION_INCOMPLETE d'un compte (ou de tous),
 * classés par la fonction pure ci-dessus. LECTURE SEULE : aucune écriture,
 * aucun appel, aucune promotion d'unité. Paginé par identifiant de document.
 */
export async function inventoryVerificationGaps(opts: {
  accountId?: number; fileIds?: readonly number[]; limit?: number;
} = {}): Promise<VerificationGapInventory> {
  const vide: VerificationGapInventory = { documents: 0, byKind: {}, byProbativePath: {}, verdicts: [] };
  const { sourceLayerReady } = await import('./repository');
  if (!(await sourceLayerReady())) return { ...vide, unavailable: true };
  const { pgClient } = await import('@/db');
  const limite = Math.min(2_000, Math.max(1, Math.trunc(opts.limit ?? 500)));
  const rows = (await pgClient.unsafe(
    `SELECT c.file_id AS "fileId", c.quality_state AS "qualityState", c.total_units AS "unitCount",
            to_jsonb(c) ->> 'source_verification' AS "sourceVerification", to_jsonb(c) -> 'verification' AS verification,
            x.source_sha256 AS "sourceSha256",
            (x.file_id IS NOT NULL AND x.extraction_status IS DISTINCT FROM 'FAILED'
               AND COALESCE(x.page_count, 0) > 0 AND COALESCE(length(x.full_text), 0) > 0) AS "textLayerAvailable"
       FROM document_extraction_coverage c
       JOIN asset_files af ON af.id = c.file_id AND af.account_id = c.account_id AND af.deleted_at IS NULL
       LEFT JOIN document_raw_extracts x ON x.file_id = c.file_id AND x.account_id = c.account_id
      WHERE c.quality_state = 'VERIFICATION_INCOMPLETE'
        AND ($1::int IS NULL OR c.account_id = $1)
        AND ($2::int[] IS NULL OR c.file_id = ANY($2::int[]))
      ORDER BY c.file_id
      LIMIT $3`,
    [opts.accountId ?? null, opts.fileIds ? [...opts.fileIds] : null, limite] as never[],
  ).catch(() => [])) as unknown as Row[];
  const verdicts = rows.map((r) => classifyVerificationGap({
    fileId: Number(r.fileId),
    qualityState: String(r.qualityState),
    sourceVerification: r.sourceVerification == null ? null : String(r.sourceVerification),
    verification: (typeof r.verification === 'string' ? JSON.parse(r.verification) : r.verification) as Record<string, unknown> | null,
    textLayerAvailable: r.textLayerAvailable === true,
    sourceSha256: r.sourceSha256 == null ? null : String(r.sourceSha256),
    unitCount: Number(r.unitCount ?? 0),
  }));
  const byKind: Record<string, number> = {};
  const byProbativePath: Record<string, number> = {};
  for (const v of verdicts) {
    byKind[v.kind] = (byKind[v.kind] ?? 0) + 1;
    byProbativePath[v.probativePath] = (byProbativePath[v.probativePath] ?? 0) + 1;
  }
  return { documents: verdicts.length, byKind, byProbativePath, verdicts };
}
