/**
 * Carte #744, travaux D (« Fiche et parcours », CDC « Opérations / Agenda
 * V2.0 » §14 ; AC01, AC22, AC41) — LECTURE de la PAGE ENTIÈRE d'un événement
 * de référence.
 *
 * Aucune lecture parallèle : la page ASSEMBLE les lecteurs existants —
 *   · `readReferenceEvent` (lot 113AB / travaux C) : identité canonique,
 *     périodes de couverture, justificatifs, événements de l'Agenda (graphe) ;
 *   · `readOperationGraph` (lot B) : événements de référence associés, lus
 *     dans les deux sens, événements partagés, ancien identifiant redirigé ;
 * et ajoute ce que la page seule montre : dates PROPRES qualifiées par leur
 * rôle, biens, équipements, fournisseurs reliés, déclarations de
 * l'utilisateur (source durable d'un événement fondé sur une déclaration).
 *
 * Règles :
 *   · bornée au compte dans CHAQUE requête (un événement de référence d'un
 *     autre compte n'existe pas : null → 404) ;
 *   · consultable SANS événement de l'Agenda, SANS bien, SANS document et
 *     SANS date : aucune date n'est inventée (`undated`), aucun élément n'est
 *     créé ; événement invalidé sans regroupement : null ;
 *   · aucun état (envisagé / réalisé / annulé) n'est rendu : il reste interne ;
 *   · aucune IA, aucune écriture, aucune limite silencieuse sur les relations
 *     (les justificatifs gardent la borne existante de `readReferenceEvent`).
 */
import type postgres from 'postgres';
import { documentTitleJsonSql, documentTitleOf, type DocumentTitleColumns } from '@/lib/documents/document-title-source';
import {
  REFERENCE_EVENT_DATE_ROLES, referenceEventPageTitle,
  type ReferenceEventDateRole, type ReferenceEventRelationDirection, type ReferenceEventRelationNature,
} from '@/lib/reference-events/reference-event-page';
import { PRESENTATION_BASIS_LABELS, type PresentationDate } from '@/lib/reference-events/presentation-date';
import { referenceEventPeriodOf, type ReferenceEventNotes, type ReferenceEventSummary } from '@/lib/reference-events/reference-event-summary';
import type { CoverageEntry } from '@/services/documents/business-periods/service';
import {
  OPERATION_FACT_OF_PROVENANCE, operationAmountsOf,
  type OperationAmount, type OperationFactConflict, type OperationFactSource,
} from '@/lib/reference-events/operation-facts';
import {
  dedupeOperationDocuments, type OperationEventDocument, type OperationRef, type OperationRelatedDocument,
} from '@/lib/reference-events/operation-links';
import type { FinancialComponentKind } from '../model';
import { presentationDateOfRow, presentationFactColumnsSql } from './presentation-date';

/**
 * Texte fixe de la source de protection posée par `correctOperation` (façade d'écriture). Il est défini ici
 * pour que la lecture de la page puisse l'écarter de l'affichage sans dépendre de la façade (décision PO du
 * 16/11/2026 : masquer ce texte à l'utilisateur). La façade le réexporte.
 */
export const PAGE_CORRECTION_DECLARATION_TEXT = 'Correction faite depuis la fiche (dates ou type).';

/**
 * Texte fixe de la source posée par `splitOperation` (façade d'écriture) de chaque côté d'une SCISSION :
 * elle fonde le nouvel événement de référence et protège celui d'origine (sa composition est désormais
 * décidée par l'utilisateur). Technique : masqué à l'écran comme celui de la correction (même décision du
 * PO du 16/11/2026), conservé en base et au journal. La façade le réexporte.
 */
export const PAGE_SPLIT_DECLARATION_TEXT = 'Scission faite depuis la fiche d’un événement de référence.';

/**
 * Lot 115 (#791, décision du PO du 16/11/2026) — texte fixe de la source posée quand l'utilisateur répond à la
 * carte « lequel est le bon ? » entre DEUX événements de référence associés qui désignent deux PRESTATAIRES
 * différents. Le prestataire ne se corrige pas par `correctOperation` (règle de la carte #744) : la réponse est
 * écrite par la commande W22, qui exige une déclaration. Celle-ci est TECHNIQUE (texte fixe, jamais saisi par
 * l'utilisateur, jamais montré à l'écran) et protège la valeur choisie d'une réécriture par T3. **À valider par
 * le PO.** La façade le réexporte.
 */
export const CARD_FACT_ARBITRATION_DECLARATION_TEXT = 'Prestataire choisi dans « À traiter », entre deux événements de référence associés.';

/** Textes de déclaration TECHNIQUES, jamais montrés dans « Votre déclaration » (décision PO du 16/11/2026). */
export const PAGE_TECHNICAL_DECLARATION_TEXTS: ReadonlySet<string> = new Set([
  PAGE_CORRECTION_DECLARATION_TEXT, PAGE_SPLIT_DECLARATION_TEXT, CARD_FACT_ARBITRATION_DECLARATION_TEXT,
]);

type Sql = postgres.Sql;
type Row = Record<string, unknown>;
const sqlClient = async (): Promise<Sql> => (await import('@/db')).pgClient;
const txt = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const day = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

export type ReferenceEventDeclarationChannel = 'UI' | 'TO_PROCESS' | 'ASSISTANT';

export interface ReferenceEventPageView {
  /** Identifiant COURANT (après regroupement) ; jamais affiché. */
  id: number;
  /** Ancien identifiant demandé, quand il a été regroupé dans celui-ci (la page corrige son adresse). */
  redirectedFrom: number | null;
  /** Version de l'événement de référence (gestes d'écriture : version attendue). */
  version: number;
  /** Titre affiché (jamais « Opération ») — voir `referenceEventPageTitle`. */
  title: string;
  /** Intitulé propre enregistré (null : aucun) — celui que l'utilisateur peut corriger. */
  ownLabel: string | null;
  typeCode: string | null;
  /** Carte #806 (volet B §8) : nom utilisateur du type (« Intervention », « Contrat »…) ; null : type non qualifié. */
  typeLabel?: string | null;
  provider: string | null;
  /** Dates PROPRES, chacune avec son rôle ; jamais une date d'événement de l'Agenda ou de document. */
  dates: Array<{ role: ReferenceEventDateRole; date: string }>;
  /**
   * Carte #744, point F (CDC §11) : DATE DE PRÉSENTATION (repère) et son fondement — même règle que la
   * Timeline et la recherche. `label` : d'où vient le repère quand ce n'est pas une date propre déjà
   * affichée (« Premier devis », « Première couverture connue ») ; null sinon.
   */
  presentation?: PresentationDate & { label: string | null };
  /** Ni date propre ni date de présentation : la page dit « Sans date » (rien n'est inventé). */
  undated: boolean;
  /** Déclarations de l'utilisateur (source durable), de la plus ancienne à la plus récente. */
  declarations: Array<{ id: number; text: string; declaredOn: string | null; channel: ReferenceEventDeclarationChannel; purpose: 'CREATE' | 'UPDATE' }>;
  assets: Array<{ id: number; name: string }>;
  equipments: Array<{ id: number; name: string; assetId: number; assetName: string | null }>;
  /** Carte #806 (volet B §8) : pièces concernées (lien existant `business_operation_room_links`), avec leur bien. */
  rooms?: Array<{ id: number; name: string; assetId: number; assetName: string | null }>;
  suppliers: Array<{ id: number; name: string }>;
  coverages: CoverageEntry[];
  /**
   * Justificatifs qui APPARTIENNENT à l'opération. Carte #806 (volet B §7, AC43) : `sharedWith` — autres opérations
   * actives qui portent aussi ce justificatif (« justificatif partagé ») ; `directEvents` — événements de CETTE
   * opération auxquels il est aussi lié directement. Absents : rien de tel (ou lecture d'un appelant antérieur).
   */
  documents: Array<{ fileId: number; title: string; date: string | null; sharedWith?: OperationRef[]; directEvents?: Array<{ id: number; title: string }> }>;
  /**
   * Carte #806 (volet B §7, AC43) : documents liés DIRECTEMENT à un événement de l'opération, sans lui appartenir.
   * Jamais un doublon d'un justificatif ; jamais un document que l'utilisateur a retiré de cette opération (AC44).
   */
  eventDocuments?: OperationEventDocument[];
  /**
   * Carte #806 (volet B §7) : pièces du contrat d'assurance ASSOCIÉ à un sinistre, lues par la relation — ni
   * copiées, ni rattachées, ni comptées.
   */
  relatedDocuments?: OperationRelatedDocument[];
  /** Événements RÉELS de l'Agenda (graphe N↔N), chacun à SA date ; `shared` : relié aussi à un autre événement de référence. */
  agendaItems: Array<{ id: number; title: string; date: string | null; shared: boolean }>;
  /** Événements de référence associés (jamais une fusion), lus dans les deux sens. */
  relations: Array<{ operationId: number; label: string; nature: ReferenceEventRelationNature; direction: ReferenceEventRelationDirection }>;
  /**
   * Carte #744, travaux D — contenu (CDC §14, §18 ; AC42, AC52 à AC55) :
   * SYNTHÈSE FACTUELLE et MONTANTS, lus dans ce qui est déjà enregistré —
   * aucun agrégat nouveau, aucun montant inventé, aucun double compte.
   * Absente : lecture d'un appelant qui ne la demande pas (aperçu, test).
   */
  summary?: ReferenceEventSummary;
  /**
   * Carte #744, travaux D — contenu : NOTE LIBRE de l'utilisateur
   * (« Notes / Description », migration 1722) ; null : aucune note.
   */
  notes?: ReferenceEventNotes | null;
  /**
   * Carte #806 (volet B §8) — MONTANTS PAR NATURE : les composantes actives du moteur financier existant de CETTE
   * opération, regroupées (jamais additionnées entre natures). Vide ou absent : la rubrique n'apparaît pas.
   */
  amounts?: OperationAmount[];
  /** Carte #806 (volet B §8) — SOURCE de chaque fait affiché (date, prestataire), quand la consolidation l'a tracée. */
  factSources?: OperationFactSource[];
  /** Carte #806 (volet B §8) — VALEURS DIFFÉRENTES relevées pour un même fait, avec leurs justificatifs. */
  conflicts?: OperationFactConflict[];
}

/** Colonnes d'un événement de référence qui portent ses dates propres, par rôle. */
const DATE_COLUMNS: Readonly<Record<ReferenceEventDateRole, string>> = {
  PLANNED: 'planned_date', START: 'start_date', REALIZED: 'realized_date', END: 'end_date',
};

/** Objet JSON lu en base (jsonb déjà décodé, ou texte selon le pilote). */
function jsonObject(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v !== 'string') return null;
  try {
    const o = JSON.parse(v) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const textList = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map(txt).filter((x): x is string => x !== null) : []);

/**
 * Titre d'un événement de référence à partir de ses faits (page ET recherche :
 * une seule règle). `firstDocument` : colonnes de titre du premier
 * justificatif (JSON), `assetNames` triés par nom, `firstDeclaration` : déclaration
 * FONDATRICE (création) seulement — jamais le texte d'une correction.
 */
export async function referenceEventTitleFromFacts(f: {
  typeCode: string | null; technicalLabel: string | null; provider: string | null;
  firstDocumentTitle: string | null; assetNames: readonly string[]; firstDeclaration: string | null;
}): Promise<string> {
  const { referenceEventLabel } = await import('@/services/documents/business-period-surfaces');
  const baseLabel = referenceEventLabel({
    typeCode: f.typeCode, technicalLabel: f.technicalLabel, provider: f.provider, firstDocumentTitle: f.firstDocumentTitle,
  });
  const hasComplement = !!(f.technicalLabel?.trim() || f.firstDocumentTitle?.trim() || f.provider?.trim());
  return referenceEventPageTitle({ baseLabel, hasComplement, typeCode: f.typeCode, assetNames: f.assetNames, declaration: f.firstDeclaration });
}

/**
 * Faits de recherche des événements de référence ACTIFS du compte désignés
 * par `whereSql` (fragment portant sur l'alias `o`, paramètres `$2…`), en UNE
 * requête. Utilisé par la recherche globale ; borné au compte par `$1`.
 */
export interface ReferenceEventSearchFacts {
  id: number;
  title: string;
  typeCode: string | null;
  technicalLabel: string | null;
  provider: string | null;
  firstDocumentTitle: string | null;
  assetNames: string[];
  supplierNames: string[];
  declarations: string[];
  references: string[];
  /**
   * Date de repère ; null : sans date. RÈGLE REMPLACÉE (carte #744, point F) : c'est la DATE DE
   * PRÉSENTATION du CDC §11 (`presentationDateOf`), et non plus « réalisation, sinon début, sinon date
   * prévue ». Le nom du champ est conservé (appelants existants).
   */
  ownDate: string | null;
  /** Fondement de la date de repère (null : sans date). */
  presentationBasis: PresentationDate['basis'];
}

/** Sous-requêtes (alias `o`) des faits de recherche : toutes bornées au compte `$1`. */
export const REFERENCE_EVENT_SEARCH_SQL = {
  assetNames: `(SELECT array_agg(a.name ORDER BY a.name, a.id) FROM business_operation_asset_links l
                  JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
                 WHERE l.account_id = $1 AND l.operation_id = o.id AND l.active)`,
  supplierNames: `(SELECT array_agg(s.name ORDER BY s.name, s.id) FROM business_operation_suppliers bs
                     JOIN suppliers s ON s.id = bs.supplier_id AND s.account_id = $1 AND s.status <> 'deleted'
                    WHERE bs.account_id = $1 AND bs.operation_id = o.id AND bs.status = 'ACTIVE')`,
  declarations: `(SELECT array_agg(d.declaration_text ORDER BY d.declared_at, d.id) FROM business_operation_declarations d
                   WHERE d.account_id = $1 AND d.operation_id = o.id)`,
  /** Déclaration FONDATRICE (création) la plus ancienne : seule déclaration qui peut servir de titre. */
  foundingDeclaration: `(SELECT d.declaration_text FROM business_operation_declarations d
                          WHERE d.account_id = $1 AND d.operation_id = o.id AND d.purpose = 'CREATE'
                          ORDER BY d.declared_at, d.id LIMIT 1)`,
  references: `(SELECT array_agg(DISTINCT r.reference_value) FROM business_operation_references r
                 WHERE r.account_id = $1 AND r.operation_id = o.id AND r.active)`,
  firstDocument: `(SELECT ${documentTitleJsonSql('f')}
                     FROM business_operation_documents bd
                     JOIN asset_files f ON f.id = bd.file_id AND f.account_id = bd.account_id AND f.deleted_at IS NULL
                    WHERE bd.account_id = $1 AND bd.operation_id = o.id AND bd.active
                    ORDER BY f.document_date NULLS LAST, f.id LIMIT 1)`,
  /** Carte #744, point F : colonnes `pd_*` (faits de la date de présentation), à ajouter telles quelles au SELECT. */
  presentationFacts: presentationFactColumnsSql('o'),
} as const;

/** Ligne SQL (colonnes ci-dessus) → faits de recherche, titre compris. */
export async function referenceEventSearchFactsOf(r: Row): Promise<ReferenceEventSearchFacts> {
  const doc = jsonObject(r.first_document);
  const firstDocumentTitle = doc ? txt(documentTitleOf(doc as DocumentTitleColumns)) : null;
  const assetNames = textList(r.asset_names);
  const declarations = textList(r.declarations);
  const typeCode = txt(r.type_code);
  const technicalLabel = txt(r.technical_label);
  const provider = txt(r.provider);
  const presentation = presentationDateOfRow(r);
  return {
    id: Number(r.id), typeCode, technicalLabel, provider, firstDocumentTitle, assetNames, declarations,
    supplierNames: textList(r.supplier_names), references: textList(r.reference_values),
    ownDate: presentation.date, presentationBasis: presentation.basis,
    title: await referenceEventTitleFromFacts({ typeCode, technicalLabel, provider, firstDocumentTitle, assetNames, firstDeclaration: txt(r.founding_declaration) }),
  };
}

/**
 * Carte #806 (volet B §8) — SOURCE de chaque fait et VALEURS DIFFÉRENTES, lues dans `attribute_provenance` (écrit
 * par la consolidation T3). Deux formes sont lues : le relevé qualifié (lot 113AQ, `{ fields: { <champ>: { sourceId,
 * value } }, conflicts: [...], divergences: [...] }`) et le relevé brut antérieur (`{ <champ>: { sourceId, value },
 * conflicts: [...] }`). `conflicts` : écarts à confirmer (ils peuvent donner une question « À traiter ») ;
 * `divergences` : différences déjà qualifiées (révision, même jour économique, valeur choisie) — consultables.
 * Chaque source est résolue DANS le compte et DANS l'opération ; un justificatif supprimé n'est pas rendu. Forme
 * inattendue : rien (jamais une erreur de la fiche).
 */
async function readFactProvenance(
  sql: Sql, accountId: number, operationId: number, brut: unknown,
  /** Valeur AFFICHÉE de chaque fait : une source n'est dite que si elle porte exactement cette valeur. */
  courant: Readonly<Partial<Record<OperationFactSource['field'], string | null>>>,
): Promise<{ sources: OperationFactSource[]; conflicts: OperationFactConflict[] }> {
  const prov = jsonObject(brut);
  if (!prov) return { sources: [], conflicts: [] };
  const entier = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
  const voulus = new Set<number>();
  const parChamp: Array<{ field: OperationFactSource['field']; sourceId: number }> = [];
  const champs = jsonObject(prov.fields) ?? prov;
  for (const [cle, field] of Object.entries(OPERATION_FACT_OF_PROVENANCE)) {
    const trace = jsonObject(champs[cle]);
    const sourceId = entier(trace?.sourceId);
    // La valeur affichée a pu être corrigée depuis (par l'utilisateur) : la trace d'une AUTRE valeur ne la justifie
    // pas — rien n'est dit plutôt qu'une source fausse.
    if (sourceId !== null && txt(trace?.value) !== null && txt(trace?.value) === (courant[field] ?? null)) { parChamp.push({ field, sourceId }); voulus.add(sourceId); }
  }
  const releves: Array<{ field: OperationFactConflict['field']; retained: string | null; pending: boolean; values: Array<{ value: string; sourceIds: number[] }> }> = [];
  const liste = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
  const vus = new Set<string>();
  for (const [c, pending] of [...liste(prov.conflicts).map((x) => [x, true] as const), ...liste(prov.divergences).map((x) => [x, false] as const)]) {
    const o = jsonObject(c);
    const field = o && typeof o.field === 'string' ? OPERATION_FACT_OF_PROVENANCE[o.field] : undefined;
    if (!o || !field || !Array.isArray(o.values)) continue;
    const values: Array<{ value: string; sourceIds: number[] }> = [];
    for (const v of o.values as unknown[]) {
      const x = jsonObject(v);
      const value = txt(x?.value);
      if (!value) continue;
      const sourceIds = (Array.isArray(x?.sourceIds) ? (x?.sourceIds as unknown[]) : []).map(entier).filter((n): n is number => n !== null);
      for (const n of sourceIds) voulus.add(n);
      values.push({ value, sourceIds });
    }
    // Une seule valeur n'est pas une différence ; le même écart n'est relevé qu'une fois.
    const cleEcart = `${field}|${values.map((v) => v.value).sort().join('|')}`;
    if (new Set(values.map((v) => v.value)).size >= 2 && !vus.has(cleEcart)) {
      vus.add(cleEcart);
      // « Valeur affichée » : celle que la fiche montre réellement (jamais une valeur retenue autrefois puis corrigée).
      const affichee = courant[field] ?? null;
      releves.push({ field, retained: affichee !== null && values.some((v) => v.value === affichee) ? affichee : null, pending, values });
    }
  }
  if (!voulus.size) return { sources: [], conflicts: [] };
  const rows = (await sql.unsafe(
    `SELECT s.id, s.source_kind, s.authority, f.id AS file_id, ${documentTitleJsonSql('f')} AS titre
       FROM business_operation_sources s
       LEFT JOIN asset_files f ON s.source_kind = 'DOCUMENT' AND f.account_id = s.account_id AND f.deleted_at IS NULL
            AND f.id = CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END
      WHERE s.account_id = $1 AND s.operation_id = $2 AND s.id = ANY($3::bigint[])`,
    [accountId, operationId, `{${[...voulus].join(',')}}`] as never[],
  ).catch(() => [])) as unknown as Row[];
  const parId = new Map(rows.map((r) => [Number(r.id), r]));
  const fichier = (r: Row | undefined): { fileId: number; title: string } | null => {
    if (!r || r.file_id === null || r.file_id === undefined) return null;
    const t = jsonObject(r.titre);
    return { fileId: Number(r.file_id), title: t ? documentTitleOf(t as DocumentTitleColumns) : 'Document' };
  };
  const sources: OperationFactSource[] = [];
  for (const p of parChamp) {
    const r = parId.get(p.sourceId);
    const f = fichier(r);
    if (f) sources.push({ field: p.field, origin: 'DOCUMENT', fileId: f.fileId, title: f.title });
    else if (r && (r.source_kind === 'USER_DECLARATION' || r.authority === 'USER')) sources.push({ field: p.field, origin: 'USER', fileId: null, title: null });
  }
  const conflicts: OperationFactConflict[] = releves.map((c) => ({
    field: c.field, retained: c.retained, pending: c.pending,
    values: c.values.map((v) => {
      const vus = new Set<number>();
      const srcs: Array<{ fileId: number; title: string }> = [];
      for (const n of v.sourceIds) {
        const f = fichier(parId.get(n));
        if (f && !vus.has(f.fileId)) { vus.add(f.fileId); srcs.push(f); }
      }
      return { value: v.value, sources: srcs };
    }),
  }));
  return { sources, conflicts };
}

/**
 * PAGE d'un événement de référence ACTIF du compte (ancien identifiant
 * regroupé : redirigé). null : introuvable dans ce compte, ou invalidé sans
 * regroupement.
 */
export async function readReferenceEventPage(accountId: number, operationId: number): Promise<ReferenceEventPageView | null> {
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !Number.isSafeInteger(operationId) || operationId <= 0) return null;
  const { readReferenceEvent, referenceEventLabel } = await import('@/services/documents/business-period-surfaces');
  const base = await readReferenceEvent(accountId, operationId);
  if (!base) return null;
  const id = base.id;
  const { readOperationGraph } = await import('./read');
  const graphe = await readOperationGraph(accountId, id);
  if (!graphe) return null;
  const sql = await sqlClient();
  const params = [accountId, id] as never[];
  const [op] = (await sql.unsafe(
    `SELECT o.version, o.type_code, o.technical_label, o.provider,
            to_char(o.planned_date, 'YYYY-MM-DD') AS planned_date, to_char(o.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(o.realized_date, 'YYYY-MM-DD') AS realized_date, to_char(o.end_date, 'YYYY-MM-DD') AS end_date,
            ${presentationFactColumnsSql('o')}
       FROM business_operations o
      WHERE o.account_id = $1 AND o.id = $2 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`,
    params,
  )) as unknown as Row[];
  if (!op) return null;
  const [biens, equipements, fournisseurs, declarations, composantes, nombres, notesRows, pieces, provenanceRows] = (await Promise.all([
    sql.unsafe(
      `SELECT DISTINCT a.id, a.name FROM business_operation_asset_links l
         JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
        WHERE l.account_id = $1 AND l.operation_id = $2 AND l.active
        ORDER BY a.name, a.id`, params),
    sql.unsafe(
      `SELECT DISTINCT e.id, e.name, a.id AS asset_id, a.name AS asset_name FROM business_operation_equipment_links l
         JOIN equipments e ON e.id = l.equipment_id AND e.archived_at IS NULL
         JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
        WHERE l.account_id = $1 AND l.operation_id = $2 AND l.active
        ORDER BY e.name, e.id`, params),
    sql.unsafe(
      `SELECT DISTINCT s.id, s.name FROM business_operation_suppliers bs
         JOIN suppliers s ON s.id = bs.supplier_id AND s.account_id = $1 AND s.status <> 'deleted'
        WHERE bs.account_id = $1 AND bs.operation_id = $2 AND bs.status = 'ACTIVE'
        ORDER BY s.name, s.id`, params),
    sql.unsafe(
      `SELECT d.id, d.declaration_text, d.channel, d.purpose, to_char(d.declared_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS declared_on
         FROM business_operation_declarations d
        WHERE d.account_id = $1 AND d.operation_id = $2
        ORDER BY d.declared_at, d.id`, params),
    // Carte #744, travaux D — contenu : MONTANTS. Les composantes ACTIVES du moteur financier EXISTANT de
    // CET événement de référence, telles quelles : aucun agrégat nouveau, aucune lecture d'un autre événement
    // (un justificatif partagé ne porte donc jamais deux fois le même coût ici).
    sql.unsafe(
      `SELECT c.kind, c.amount_minor, c.currency, c.amount_eur_cents, to_char(c.economic_date, 'YYYY-MM-DD') AS economic_date,
              to_char(c.period_start, 'YYYY-MM-DD') AS period_start, to_char(c.period_end, 'YYYY-MM-DD') AS period_end
         FROM business_operation_financial_components c
        WHERE c.account_id = $1 AND c.operation_id = $2 AND c.active
        ORDER BY c.id`, params),
    // Nombres de la synthèse : `count(DISTINCT …)` — un justificatif ou un événement de l'Agenda PARTAGÉ avec un
    // autre événement de référence n'est compté qu'une fois, et aucun plafond silencieux ne tronque le nombre
    // (la LISTE des justificatifs garde la borne de 200 de la lecture existante, pas le compte).
    sql.unsafe(
      `SELECT (SELECT count(DISTINCT d.file_id) FROM business_operation_documents d
                 JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id AND f.deleted_at IS NULL
                WHERE d.account_id = $1 AND d.operation_id = $2 AND d.active) AS documents,
              (SELECT count(DISTINCT l.agenda_item_id) FROM business_operation_agenda_links l
                 JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = l.account_id
                WHERE l.account_id = $1 AND l.operation_id = $2 AND l.state = 'ACTIVE') AS agenda_items`, params),
    // Note libre (migration 1722) : colonne absente (déploiement en retard) → aucune note, jamais une erreur.
    sql.unsafe(
      `SELECT o.user_notes, to_char(o.user_notes_updated_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS notes_on
         FROM business_operations o WHERE o.account_id = $1 AND o.id = $2`, params).catch(() => []),
    // Carte #806 (volet B §8) : pièces concernées (pièce d'un bien vivant du compte).
    sql.unsafe(
      `SELECT DISTINCT s.id, s.name, a.id AS asset_id, a.name AS asset_name FROM business_operation_room_links l
         JOIN substructures s ON s.id = l.substructure_id
         JOIN assets a ON a.id = s.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
        WHERE l.account_id = $1 AND l.operation_id = $2 AND l.active
        ORDER BY s.name, s.id`, params).catch(() => []),
    // Carte #806 (volet B §8) : provenance et valeurs différentes enregistrées par la consolidation (lecture seule).
    sql.unsafe(
      `SELECT o.attribute_provenance FROM business_operations o WHERE o.account_id = $1 AND o.id = $2`, params).catch(() => []),
  ])) as unknown as [Row[], Row[], Row[], Row[], Row[], Row[], Row[], Row[], Row[]];

  const dates: ReferenceEventPageView['dates'] = [];
  for (const role of REFERENCE_EVENT_DATE_ROLES) {
    const d = day(op[DATE_COLUMNS[role]]);
    if (d) dates.push({ role, date: d });
  }
  const assets = biens.map((b) => ({ id: Number(b.id), name: String(b.name ?? '') }));
  const decls = declarations
    // Décision PO du 16/11/2026 : les sources de PROTECTION posées par une correction de date ou de type et
    // par une scission (textes fixes, techniques) ne sont PAS montrées à l'utilisateur ; elles restent au
    // journal et en base.
    .filter((d) => !PAGE_TECHNICAL_DECLARATION_TEXTS.has(String(d.declaration_text ?? '').trim()))
    .map((d) => ({
      id: Number(d.id), text: String(d.declaration_text ?? ''), declaredOn: day(d.declared_on),
      channel: (d.channel === 'ASSISTANT' || d.channel === 'TO_PROCESS' ? d.channel : 'UI') as ReferenceEventDeclarationChannel,
      purpose: (d.purpose === 'UPDATE' ? 'UPDATE' : 'CREATE') as 'CREATE' | 'UPDATE',
    }))
    .filter((d) => d.text.trim().length > 0);
  const typeCode = txt(op.type_code);
  const agendaItems = base.agendaItems;
  // Carte #806 (volet B §7, AC43, AC44) : nature des liens documentaires — lecture calculée, rien n'est écrit.
  const { readOperationDocumentLinks } = await import('./document-links');
  const liens = await readOperationDocumentLinks(accountId, id, {
    typeCode, related: graphe.relations.map((r) => ({ operationId: r.other.operationId, label: r.other.label, typeCode: r.other.typeCode })),
  });
  const documents: ReferenceEventPageView['documents'] = base.documents.map((d) => {
    const sharedWith = liens.sharedWith.get(d.fileId);
    const directEvents = liens.directEvents.get(d.fileId);
    return { ...d, ...(sharedWith?.length ? { sharedWith } : {}), ...(directEvents?.length ? { directEvents } : {}) };
  });
  // Un document n'est listé qu'une fois : justificatif, sinon lié à un événement, sinon porté par l'opération associée.
  const { events: eventDocuments, related: relatedDocuments } = dedupeOperationDocuments(documents, liens.eventDocuments, liens.relatedDocuments);
  const faits = await readFactProvenance(sql, accountId, id, provenanceRows[0]?.attribute_provenance, {
    PLANNED: day(op.planned_date), START: day(op.start_date), REALIZED: day(op.realized_date), END: day(op.end_date), PROVIDER: txt(op.provider),
  });
  const fournisseursNoms = fournisseurs.map((s) => String(s.name ?? '')).filter((x) => x.length > 0);
  // MONTANT : la règle EXISTANTE du moteur (net indicatif) — coûts réalisés moins remises, remboursements,
  // indemnités et produits ; les devis n'y entrent pas ; une devise sans contre-valeur connue n'est pas convertie.
  const { indicativeNetCents } = await import('../diagnostics/model');
  const comps = composantes.map((c) => ({
    kind: String(c.kind) as FinancialComponentKind,
    amountMinor: Number(c.amount_minor ?? 0),
    currency: String(c.currency ?? ''),
    amountEurCents: c.amount_eur_cents === null || c.amount_eur_cents === undefined ? null : Number(c.amount_eur_cents),
    active: true,
  }));
  const net = indicativeNetCents(comps);
  const nonConvertis = comps.filter((c) => c.kind !== 'FORECAST_COST' && c.currency !== 'EUR' && c.amountEurCents === null).length;
  const summary: ReferenceEventSummary = {
    netCents: net.cents,
    unconvertedCount: nonConvertis,
    documentCount: Number(nombres[0]?.documents ?? documents.length),
    agendaItemCount: Number(nombres[0]?.agenda_items ?? agendaItems.length),
    supplierNames: fournisseursNoms,
    // PÉRIODE : l'étendue des faits DATÉS déjà portés par la fiche. Aucune date n'est inventée ni empruntée
    // à un autre événement de référence, et la date du jour n'intervient pas.
    period: referenceEventPeriodOf([
      ...dates.map((d) => d.date),
      ...base.coverages.flatMap((c) => [c.start, c.end]),
      ...agendaItems.map((a) => a.date),
      ...documents.map((d) => d.date),
      ...composantes.flatMap((c) => [c.economic_date as string | null, c.period_start as string | null, c.period_end as string | null]),
    ]),
  };
  const noteTexte = txt(notesRows[0]?.user_notes);
  const notes: ReferenceEventNotes | null = noteTexte ? { text: noteTexte, updatedOn: day(notesRows[0]?.notes_on) } : null;
  const repere = presentationDateOfRow(op);
  const presentation: NonNullable<ReferenceEventPageView['presentation']> = { ...repere, label: repere.basis ? PRESENTATION_BASIS_LABELS[repere.basis] : null };
  const partages = new Map(graphe.agendaItems.map((a) => [a.agendaItemId, a.sharedWith > 1]));
  return {
    id,
    redirectedFrom: graphe.redirectedFrom ?? (id !== operationId ? operationId : null),
    version: Number(op.version),
    title: await referenceEventTitleFromFacts({
      typeCode, technicalLabel: txt(op.technical_label), provider: txt(op.provider),
      firstDocumentTitle: base.documents[0]?.title ?? null, assetNames: assets.map((a) => a.name),
      firstDeclaration: decls.find((d) => d.purpose === 'CREATE')?.text ?? null,
    }),
    ownLabel: txt(op.technical_label),
    typeCode,
    typeLabel: typeCode ? referenceEventLabel({ typeCode, technicalLabel: null }) : null,
    provider: txt(op.provider),
    dates,
    presentation,
    undated: dates.length === 0 && presentation.date === null,
    declarations: decls,
    assets,
    equipments: equipements.map((e) => ({ id: Number(e.id), name: String(e.name ?? ''), assetId: Number(e.asset_id), assetName: txt(e.asset_name) })),
    rooms: pieces.map((p) => ({ id: Number(p.id), name: String(p.name ?? ''), assetId: Number(p.asset_id), assetName: txt(p.asset_name) })),
    suppliers: fournisseurs.map((s) => ({ id: Number(s.id), name: String(s.name ?? '') })),
    coverages: base.coverages,
    documents,
    eventDocuments,
    relatedDocuments,
    amounts: operationAmountsOf(comps),
    factSources: faits.sources,
    conflicts: faits.conflicts,
    agendaItems: agendaItems.map((a) => ({ ...a, shared: partages.get(a.id) === true })),
    relations: graphe.relations.map((r) => ({ operationId: r.other.operationId, label: r.other.label, nature: r.nature, direction: r.direction })),
    summary,
    notes,
  };
}
