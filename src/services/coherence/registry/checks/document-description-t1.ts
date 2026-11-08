/**
 * COH-DOC-DESCRIPTION-T1 — description T1 d'un document reprise depuis la
 * sortie T1 PERSISTÉE, provenance établie sur preuve (lot 113Z, Trello #723
 * « Documents — Unifier « Notes / Description », sécuriser T1 et les dossiers
 * tiers », §3.B / §3.C). Ajouté EN FIN de registre, après
 * COH-DOC-BUSINESS-PERIODS (113W).
 *
 * C'est la REPRISE DE L'HISTORIQUE, SANS IA NI RÉANALYSE : la campagne
 * quotidienne parcourt les documents analysés ; un contrôle ciblé suit chaque
 * analyse ou modification.
 *
 * Objet : document visible du compte dont l'extraction T1 persistée
 * (`document_extractions.description`) porte une description, et
 *   · DESCRIPTION_MISSING_RECOVERABLE  `asset_files.description` vide, non
 *     verrouillée par l'utilisateur → la description de l'extraction est
 *     reposée, provenance T1 (constat `RECOVERED`) ;
 *   · DESCRIPTION_PROVENANCE_UNQUALIFIED  description en place IDENTIQUE à
 *     l'extraction, provenance non qualifiée → provenance T1 posée (preuve :
 *     égalité avec la sortie T1 persistée), valeur inchangée.
 * Une description d'origine inconnue DIFFÉRENTE de l'extraction n'est jamais
 * qualifiée ni remplacée (saisie historique possible) : aucune migration
 * aveugle, aucune fausse provenance. La note de l'utilisateur (`notes`,
 * `notes_user_owned`) n'est jamais lue pour décider ni écrite.
 * Interdits : appeler l'IA, réanalyser, écrire `notes`, qualifier une
 * description différente de la sortie T1, verser une description dans une
 * note (ou l'inverse).
 */
import type { CheckContext, CoherenceCheck, Inspection, RepairResult, Sql } from '../types';
import { hashOf, idsOf, intArray, rows, type Row } from '../util';
import { OPEN_DOCUMENT_SQL } from './document-links';
import { provenanceProvable, recoverableFromExtraction } from '@/services/documents/notes-description/t1-description';

export const DOCUMENT_DESCRIPTION_T1_CHECK_ID = 'COH-DOC-DESCRIPTION-T1';

type Anomaly = 'DESCRIPTION_MISSING_RECOVERABLE' | 'DESCRIPTION_PROVENANCE_UNQUALIFIED';

/** Colonnes de la migration 1580 présentes ? (sinon : contrôle sans objet). */
async function pret(sql: Sql): Promise<boolean> {
  const r = await rows(sql, `SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'asset_files' AND column_name IN ('description_source', 'description_t1_status')`, []);
  return Number(r[0]?.n) === 2;
}

const VERROU_SQL = `COALESCE(f.user_edited_fields ->> 'description', 'false') = 'true'`;
const SIGNATURE_SQL = `EXISTS (SELECT 1 FROM document_extractions x
   WHERE x.file_id = f.id AND x.account_id = f.account_id AND NULLIF(btrim(x.description), '') IS NOT NULL
     AND ((NULLIF(btrim(f.description), '') IS NULL AND NOT ${VERROU_SQL})
       OR (f.description_source IS NULL AND btrim(f.description) = btrim(x.description))))`;

interface Etat { current: string | null; source: string | null; extraction: string | null; locked: boolean }

/** Diagnostic PUR. */
export function diagnoseDocumentDescription(s: Etat): { verdict: Inspection['verdict']; anomaly?: Anomaly } {
  if (recoverableFromExtraction({ current: s.current, extraction: s.extraction, userLocked: s.locked })) {
    return { verdict: 'REPAIRABLE', anomaly: 'DESCRIPTION_MISSING_RECOVERABLE' };
  }
  if (provenanceProvable({ current: s.current, currentSource: s.source, extraction: s.extraction })) {
    return { verdict: 'REPAIRABLE', anomaly: 'DESCRIPTION_PROVENANCE_UNQUALIFIED' };
  }
  return { verdict: 'CONSISTENT' };
}

async function charger(ctx: Pick<CheckContext, 'sql'>, accountId: number, ids: readonly number[]): Promise<Map<number, Etat>> {
  const r = await rows(ctx.sql, `
    SELECT f.id, f.description, f.description_source, x.description AS extraction, ${VERROU_SQL} AS locked
      FROM asset_files f LEFT JOIN document_extractions x ON x.file_id = f.id AND x.account_id = f.account_id
     WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND ${OPEN_DOCUMENT_SQL}`, [accountId, intArray(ids)]);
  return new Map(r.map((x: Row) => [Number(x.id), {
    current: (x.description as string | null) ?? null, source: (x.description_source as string | null) ?? null,
    extraction: (x.extraction as string | null) ?? null, locked: x.locked === true,
  }]));
}

export const documentDescriptionT1Check: CoherenceCheck = {
  id: DOCUMENT_DESCRIPTION_T1_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Documents : description T1 reprise depuis la sortie T1 persistée, provenance établie sur preuve',
  domain: 'documents',
  level: 'N2',
  objectType: 'document',
  scope: 'documents visibles du compte dont l’extraction T1 persistée porte une description',
  sources: ['asset_files', 'document_extractions'],
  applicability: 'compte éligible (actif et modifiable)',
  invariant: 'la description d’un document analysé est celle de sa sortie T1 persistée quand rien ne l’a remplacée ; sa provenance T1 n’est posée que sur preuve ; la note de l’utilisateur n’est jamais touchée',
  anomalies: ['DESCRIPTION_MISSING_RECOVERABLE', 'DESCRIPTION_PROVENANCE_UNQUALIFIED'],
  autoRepairWhen: 'description vide non verrouillée et extraction T1 disponible (reprise), ou description identique à l’extraction sans provenance (qualification)',
  forbiddenRepairs: [
    'appeler l’IA', 'réanalyser le document', 'écrire la note de l’utilisateur (notes)',
    'qualifier ou remplacer une description différente de la sortie T1 (origine inconnue)', 'verser une description dans une note',
  ],
  services: ['documents/notes-description/repair#repairDocumentDescriptionFromExtraction'],
  chain: ['T1', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED'],
  frequency: 'campagne exhaustive quotidienne (reprise par lots, sans IA) + contrôle ciblé après analyse ou modification du document',
  criticality: 'LOW',
  tests: ['L113Z-U-COH', 'L113Z-E2E-13'],

  async listObjects(ctx, accountId, afterId, limit) {
    if (!(await pret(ctx.sql))) return [];
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f
       WHERE f.account_id = $1 AND f.id > $2 AND ${OPEN_DOCUMENT_SQL} AND ${SIGNATURE_SQL}
       ORDER BY f.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null || !(await pret(ctx.sql))) return [];
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND f.id = $2 AND ${OPEN_DOCUMENT_SQL} AND ${SIGNATURE_SQL}`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const etats = await charger(ctx, accountId, ids);
    for (const id of ids) {
      const s = etats.get(id);
      if (!s) { out.set(id, { verdict: 'GONE' }); continue; }
      const d = diagnoseDocumentDescription(s);
      if (d.verdict === 'CONSISTENT') { out.set(id, { verdict: 'CONSISTENT', detail: { fileId: id } }); continue; }
      // Jamais de contenu de document dans le constat : longueurs seulement.
      const observed = { currentChars: s.current?.trim().length ?? 0, extractionChars: s.extraction?.trim().length ?? 0, source: s.source };
      out.set(id, {
        verdict: d.verdict, anomaly: d.anomaly, faultyLink: 'PERSISTENCE', observed,
        expected: { descriptionSource: 'T1' },
        detail: { fileId: id, anomaly: d.anomaly },
        inputHash: hashOf({ id, a: d.anomaly, o: observed }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const etats = await charger(ctx, accountId, items.map((x) => x.id));
    const { repairDocumentDescriptionFromExtraction } = await import('@/services/documents/notes-description/repair');
    for (const { id, inspection } of items) {
      const s = etats.get(id);
      if (!s) { out.set(id, { called: false, service: 'none', result: { skipped: 'DOCUMENT_GONE' } }); continue; }
      const d = diagnoseDocumentDescription(s);
      if (!d.anomaly || d.anomaly !== (inspection.detail as { anomaly?: string } | undefined)?.anomaly) {
        out.set(id, { called: false, service: 'none', result: { skipped: 'STATE_CHANGED' } });
        continue;
      }
      const r = await repairDocumentDescriptionFromExtraction(ctx.sql, {
        accountId, fileId: id, mode: d.anomaly === 'DESCRIPTION_MISSING_RECOVERABLE' ? 'RECOVER' : 'QUALIFY',
      });
      out.set(id, {
        called: true, service: 'repairDocumentDescriptionFromExtraction', aiCalls: 0,
        result: { anomaly: d.anomaly, changed: r.changed },
        rollbackRef: d.anomaly === 'DESCRIPTION_MISSING_RECOVERABLE'
          ? `asset_files:id=${id}:description=NULL:description_source=${s.source ?? 'NULL'}`
          : `asset_files:id=${id}:description_source=NULL`,
        reevaluation: 'TECHNICAL_REBUILD',
      });
    }
    return out;
  },
};
