/**
 * Présence des colonnes des migrations 0218 (`document_facts`) et 0219
 * (`field_evidence`) — CDC 15 T1-04, T3-03, §14.4, PM-T1-PRE.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN CONTRÔLE, EN PLUS DE LA DÉCLARATION DRIZZLE
 *
 * `ensureMigrations()` poursuit après une migration en échec. Les colonnes
 * sont déclarées dans `ai-schema.ts` (drizzle-kit, typage — le lot 11 avait
 * laissé des colonnes non déclarées), mais l'écriture et la lecture passent
 * en SQL direct, et n'utilisent ces colonnes que si ce contrôle confirme leur
 * présence. Absentes :
 *   · les faits documentaires sont écrits sur les colonnes historiques (le
 *     fait est conservé, sa cible ne l'est pas — signalé) ;
 *   · les preuves CIBLÉES sur un équipement ou une pièce ne sont PAS écrites
 *     dans `field_evidence` : sans `target_type`, elles seraient lues comme
 *     des preuves du bien parent (fuite T1-04) ;
 *   · le supersede à la réanalyse n'a pas lieu (sans `lifecycle_status`,
 *     aucune trace ne pourrait être conservée) : les anciennes preuves
 *     restent lues comme avant ;
 *   · l'indicateur multi-biens de l'extraction (0218) n'est pas écrit : le
 *     rattachement tardif le relit alors dans `metadata`.
 * L'absence est signalée BRUYAMMENT, une fois par processus, en plus de
 * l'échec de migration exposé par `/api/health`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { probeCount } from '@/lib/schema-readiness-log';
import { cachedSchemaProbe } from '../telemetry/trace-schema';

/** Colonnes attendues de la 0218 sur `document_facts`. */
const DOCUMENT_FACTS_CANONICAL_COLUMNS = [
  'canonical_key', 'raw_key', 'raw_value', 'value_type', 'canonical_unit',
  'target_type', 'target_entity_id', 'target_entity_label', 'target_confidence',
  'semantic_event_type', 'semantic_event_nature', 'recurrence', 'projection_origin', 'projection_rule',
] as const;

/** Colonne attendue de la 0218 sur `document_extractions` (indicateur multi-biens, T1-05). */
const DOCUMENT_EXTRACTIONS_CANONICAL_COLUMNS = ['multi_asset'] as const;

/** Colonnes attendues de la 0219 sur `field_evidence`. */
const FIELD_EVIDENCE_CANONICAL_COLUMNS = [
  'canonical_key', 'canonical_unit', 'raw_value',
  'target_type', 'target_entity_id', 'target_entity_label', 'target_confidence',
  'semantic_event_type', 'semantic_event_nature', 'recurrence', 'projection_origin', 'projection_rule',
  'lifecycle_status', 'superseded_at', 'superseded_by_evidence_id', 'analysis_run_id',
] as const;

const sonde = (table: 'document_facts' | 'document_extractions' | 'field_evidence', colonnes: readonly string[], migration: string) =>
  cachedSchemaProbe(async () => {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = ANY($2::text[])`,
      [table, [...colonnes]] as never[],
    )) as unknown as Array<{ n: number }>;
    const found = probeCount(rows); // lot 75A : résultat inexploitable = inconnu, pas 0
    return { ready: found === colonnes.length, found };
  }, {
    scope: '[evidence]', migration, expected: colonnes.map((c) => `${table}.${c}`),
    consequence: `Écriture repliée sur les colonnes historiques ; faits ciblés équipement/pièce non projetés en preuves (CDC 15 T1-04) ; appliquer src/db/migrations/${migration}_*.sql.`,
  });

const sondes = {
  faits: sonde('document_facts', DOCUMENT_FACTS_CANONICAL_COLUMNS, '0218'),
  extractions: sonde('document_extractions', DOCUMENT_EXTRACTIONS_CANONICAL_COLUMNS, '0218'),
  preuves: sonde('field_evidence', FIELD_EVIDENCE_CANONICAL_COLUMNS, '0219'),
};

/**
 * Colonnes 0218 présentes (`document_facts` ET `document_extractions.multi_asset`) ?
 * Ne lève jamais : illisible = absent.
 */
export async function documentFactsCanonicalReady(): Promise<boolean> {
  const faits = await sondes.faits();
  const extractions = await sondes.extractions();
  return faits && extractions;
}

/** Colonnes 0219 présentes sur `field_evidence` ? Ne lève jamais : illisible = absent. */
export function fieldEvidenceCanonicalReady(): Promise<boolean> {
  return sondes.preuves();
}

/** Réservé aux tests : `null` efface l'état, un booléen le fixe pour les trois tables. */
export function __resetCanonicalColumnsForTests(ready: boolean | null = null): void {
  for (const s of Object.values(sondes)) s.reset(ready);
}
