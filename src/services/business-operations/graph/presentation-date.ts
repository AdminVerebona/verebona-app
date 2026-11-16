/**
 * Carte #744, point F (CDC « Opérations / Agenda V2.0 » §11 ; AC32, AC33,
 * AC35) — LECTURE des faits datés qui fondent la DATE DE PRÉSENTATION d'un
 * événement de référence. Serveur uniquement. La RÈGLE est dans
 * `@/lib/reference-events/presentation-date` (pure) : ce module ne fait que
 * lire les faits, toujours bornés au compte, et n'écrit rien.
 *
 * UNE lecture des faits pour toutes les surfaces :
 *   · `presentationFactColumnsSql` : colonnes `pd_*` à ajouter à une requête
 *     qui lit déjà `business_operations` (page, recherche, exports) — la
 *     règle est ensuite appliquée par `presentationDateOf` (TypeScript) ;
 *   · `presentationScalarSql` : sous-requête scalaire « date|fondement » pour
 *     trier et paginer EN BASE (Timeline du bien) — la règle y est appliquée
 *     par `presentationDateSql`, engendrée depuis la MÊME table.
 * L'égalité des deux chemins est prouvée sur PostgreSQL réel (L114OF-E01).
 *
 * Faits (aucun n'est une date d'événement de l'Agenda, ni un horodatage) :
 *   · réalisation : `realized_date`, SAUF si T3 a tracé des dates de
 *     réalisation contradictoires (provenance 78A, au moins deux valeurs) —
 *     même définition que la projection (`agenda-projection/service.ts`,
 *     lot 83A) : une date contestée n'est pas fiable ;
 *   · premier devis : plus ancienne « date du document » des justificatifs
 *     SOURCES ACTIFS de rôle devis, non supprimés, du compte ;
 *   · début : `start_date` ; date prévue : `planned_date` ;
 *   · première couverture connue : plus ancien début (jour complet et réel)
 *     des périodes de couverture ACTIVES des justificatifs membres actifs.
 *     Limite assumée : c'est la plus ancienne période CONNUE, sans rejouer la
 *     résolution des divergences (`operationPeriodResolution`) — un repère,
 *     jamais une prise d'effet ; rien n'est écrit.
 */
import {
  presentationDateOf, presentationDateSql, presentationDay,
  type PresentationDate, type PresentationDateBasis, type PresentationDateFacts,
} from '@/lib/reference-events/presentation-date';

type Row = Record<string, unknown>;
/** Exécuteur SQL paramétré ($1…). */
export type PresentationQuery = (sql: string, params?: unknown[]) => Promise<Row[]>;

const JOUR_COMPLET = `'^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'`;

/**
 * Expression SQL (type date, NULL si absent) de chaque fait, pour la ligne
 * `business_operations` d'alias `o`, dans le compte `acc` (paramètre SQL).
 * Les alias internes sont préfixés `pd` pour ne masquer aucun alias appelant.
 */
export function presentationFactsSql(o: string, acc = '$1'): Readonly<Record<PresentationDateBasis, string>> {
  const conteste = `(SELECT count(DISTINCT pdv->>'value') FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(to_jsonb(${o})->'attribute_provenance'->'conflicts') = 'array' THEN to_jsonb(${o})->'attribute_provenance'->'conflicts' ELSE '[]'::jsonb END) pdc,
    jsonb_array_elements(CASE WHEN jsonb_typeof(pdc->'values') = 'array' THEN pdc->'values' ELSE '[]'::jsonb END) pdv
    WHERE pdc->>'field' = 'realizedDate' AND pdv->>'value' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') >= 2`;
  return {
    REALIZED: `CASE WHEN ${o}.realized_date IS NOT NULL AND NOT ${conteste} THEN ${o}.realized_date END`,
    FIRST_QUOTE: `(SELECT min(pdf.document_date) FROM business_operation_sources pds
       JOIN asset_files pdf ON pdf.id = CASE WHEN pds.source_entity_key ~ '^[0-9]{1,9}$' THEN pds.source_entity_key::int END
        AND pdf.account_id = ${acc} AND pdf.deleted_at IS NULL
      WHERE pds.account_id = ${acc} AND pds.operation_id = ${o}.id AND pds.active
        AND pds.source_kind = 'DOCUMENT' AND pds.source_role = 'QUOTE')`,
    START: `${o}.start_date`,
    // CASE : garantit que la conversion en date n'est tentée que sur un jour complet ET réel (« 2024-02-31 » ignoré).
    FIRST_COVERAGE: `(SELECT min(CASE WHEN pdp.start_on ~ ${JOUR_COMPLET}
           THEN CASE WHEN substr(pdp.start_on, 9, 2)::int
                       <= extract(day FROM (substr(pdp.start_on, 1, 7) || '-01')::date + interval '1 month' - interval '1 day')
                     THEN pdp.start_on::date END END)
       FROM business_operation_documents pdd
       JOIN asset_files pdg ON pdg.id = pdd.file_id AND pdg.account_id = pdd.account_id AND pdg.deleted_at IS NULL
       JOIN document_business_periods pdp ON pdp.file_id = pdg.id AND pdp.account_id = pdd.account_id
        AND pdp.status = 'ACTIVE' AND pdp.period_kind = 'COVERAGE'
      WHERE pdd.account_id = ${acc} AND pdd.operation_id = ${o}.id AND pdd.active)`,
    PLANNED: `${o}.planned_date`,
  };
}

/** Colonnes de faits d'une ligne (`pd_type` et `pd_<fait>` en AAAA-MM-JJ). */
const COLONNE: Readonly<Record<PresentationDateBasis, string>> = {
  REALIZED: 'pd_realized', FIRST_QUOTE: 'pd_first_quote', START: 'pd_start', FIRST_COVERAGE: 'pd_first_coverage', PLANNED: 'pd_planned',
};

/**
 * Colonnes `pd_*` (texte AAAA-MM-JJ) à ajouter au SELECT d'une requête dont
 * `o` est la ligne `business_operations` ; à relire avec `presentationFactsOfRow`.
 */
export function presentationFactColumnsSql(o: string, acc = '$1'): string {
  const f = presentationFactsSql(o, acc);
  return [`${o}.type_code AS pd_type`, ...(Object.keys(COLONNE) as PresentationDateBasis[])
    .map((b) => `to_char(${f[b]}, 'YYYY-MM-DD') AS ${COLONNE[b]}`)].join(',\n       ');
}

/** Ligne SQL portant les colonnes `pd_*` → faits typés. */
export function presentationFactsOfRow(r: Row): PresentationDateFacts {
  const type = typeof r.pd_type === 'string' && r.pd_type.trim() ? r.pd_type : null;
  return {
    typeCode: type,
    realizedDate: presentationDay(r.pd_realized), firstQuoteDate: presentationDay(r.pd_first_quote),
    startDate: presentationDay(r.pd_start), firstCoverageStart: presentationDay(r.pd_first_coverage),
    plannedDate: presentationDay(r.pd_planned),
  };
}

/** Ligne SQL portant les colonnes `pd_*` → date de présentation (règle pure). */
export const presentationDateOfRow = (r: Row): PresentationDate => presentationDateOf(presentationFactsOfRow(r));

/**
 * Sous-requête SCALAIRE corrélée sur la clé primaire : « AAAA-MM-JJ|FONDEMENT »
 * de l'événement de référence ACTIF `id` du compte `acc`, NULL s'il est sans
 * date (ou inactif, ou d'un autre compte). `OFFSET 0` : les faits ne sont
 * évalués qu'une fois (la sous-requête n'est pas développée par le planificateur).
 */
export function presentationScalarSql(id: string, acc = '$1'): string {
  const f = presentationFactsSql('pdo', acc);
  const cols = (Object.keys(COLONNE) as PresentationDateBasis[]).map((b) => `${f[b]} AS ${COLONNE[b]}`).join(', ');
  const lus = Object.fromEntries((Object.keys(COLONNE) as PresentationDateBasis[]).map((b) => [b, `pdx.${COLONNE[b]}`])) as Record<PresentationDateBasis, string>;
  const e = presentationDateSql('pdx.pd_type', lus);
  return `(SELECT to_char(${e.date}, 'YYYY-MM-DD') || '|' || ${e.basis}
     FROM (SELECT pdo.type_code AS pd_type, ${cols}
             FROM business_operations pdo
            WHERE pdo.id = ${id} AND pdo.account_id = ${acc} AND pdo.invalidated_at IS NULL AND pdo.merged_into_operation_id IS NULL
           OFFSET 0) pdx)`;
}

async function defaultQuery(): Promise<PresentationQuery> {
  const { pgClient } = await import('@/db');
  return async (sql, params = []) => (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];
}

/**
 * Dates de présentation de plusieurs événements de référence ACTIFS du compte
 * (une requête, quel que soit leur nombre). Un identifiant absent du résultat
 * n'existe pas (ou plus) dans ce compte.
 */
export async function readPresentationDates(accountId: number, operationIds: readonly number[], q?: PresentationQuery): Promise<Map<number, PresentationDate>> {
  const out = new Map<number, PresentationDate>();
  const ids = [...new Set(operationIds.filter((x) => Number.isSafeInteger(x) && x > 0))];
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !ids.length) return out;
  const run = q ?? await defaultQuery();
  const rows = await run(
    `SELECT o.id, ${presentationFactColumnsSql('o')}
       FROM business_operations o
      WHERE o.account_id = $1 AND o.id = ANY($2::bigint[]) AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`,
    [accountId, ids],
  );
  for (const r of rows) out.set(Number(r.id), presentationDateOfRow(r));
  return out;
}
