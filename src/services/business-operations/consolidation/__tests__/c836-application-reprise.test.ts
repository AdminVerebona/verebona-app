/**
 * Carte #836 (Trello, écarts E09 et E07) — MÉMOIRE et REPRISE de l'application
 * d'un arbitrage T3 : ce que la consolidation lit de la table 1690 / 1785 /
 * 1960, et ce que le passage T3 écrit.
 *
 * Les lectures et écritures sont jouées sur un exécuteur SIMULÉ (aucune base :
 * l'environnement de ces tests n'en a pas, et la recette PostgreSQL vit dans
 * `src/test/e2e/scenarios/c836-t3-arbitrage.e2e.ts`). Les INSTRUCTIONS qui ne
 * peuvent être prouvées que par une base réelle (verrou entre deux workers,
 * reprise après crash, erreur SQL après décision) sont vérifiées ici sur leur
 * FORME — la propriété tient à la requête elle-même (réservation atomique
 * `FOR UPDATE SKIP LOCKED`, gardes `applied_at IS NULL`, état durable écrit
 * dans la MÊME instruction que la décision) : c'est ce qui rend la recette
 * réelle reproductible, pas ce qui la remplace.
 *
 *   C836-U-E09-MEM  état d'application lu avec chaque décision ;
 *   C836-U-E09-SQL  réservation atomique, escalade, contrôle en base ;
 *   C836-U-E07-REG  régularisation des empreintes historiques (une fois).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS, arbitrationFingerprint, loadAttributeReviews, regularizeEvidenceKeys,
  __resetArbitrationTableProbeForTests,
} from '../attribute-arbitration/review';
import type { QualifiedAttributeConflict } from '../attribute-conflicts';

const SOURCE = readFileSync('src/services/business-operations/consolidation/attribute-arbitration/review.ts', 'utf8');

/** Texte littéral d'une requête Drizzle (paramètres exclus) — pour router l'exécuteur simulé. */
function texteSql(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.map((c) => {
    const v = (c as { value?: unknown }).value;
    return Array.isArray(v) ? v.join(' ') : '';
  }).join(' ').replace(/\s+/g, ' ');
}

interface Ligne {
  id: number; field: string; role: string; fingerprint: string; presented_values: Array<{ normalized: string }>;
  status: string; outcome: string | null; retained_normalized: string | null; confidence: string | null; attempts: number;
  foreign_file_id: number | null; evidence_key: string | null; application_state: string | null; applied: boolean; fresh: boolean;
}
const ligne = (over: Partial<Ligne> = {}): Ligne => ({
  id: 5, field: 'provider', role: 'SUPPLIER', fingerprint: 'fp-1',
  presented_values: [{ normalized: 'a' }, { normalized: 'b' }], status: 'DECIDED', outcome: 'RESOLVED',
  retained_normalized: 'b', confidence: 'certain', attempts: 1, foreign_file_id: null,
  evidence_key: 'l115:abcdabcd:120', application_state: 'APPLIED', applied: true, fresh: true, ...over,
});

/** Exécuteur simulé : répond aux sondes de migration et à la lecture des arbitrages ; trace toute écriture. */
function faux(lignes: Ligne[], opts: { colonnes1785?: boolean } = {}) {
  const ecritures: string[] = [];
  const x = {
    async execute(q: unknown): Promise<unknown> {
      const t = texteSql(q);
      if (t.includes('to_regclass')) return [{ ok: true }];
      if (t.includes('information_schema.columns')) return [{ ok: opts.colonnes1785 !== false }];
      if (t.startsWith('UPDATE') || t.includes('UPDATE business_operation_attribute_arbitrations')) { ecritures.push(t); return []; }
      return lignes;
    },
  };
  return { x, ecritures };
}

beforeEach(() => { __resetArbitrationTableProbeForTests(); });

describe('C836-U-E09-MEM — l’état d’APPLICATION voyage avec chaque décision (E09)', () => {
  const charger = async (over: Partial<Ligne>, opts: { colonnes1785?: boolean } = {}) => {
    const { x } = faux([ligne(over)], opts);
    return loadAttributeReviews(x, 11, 8);
  };

  it('décision REÇUE ou EN COURS : la valeur est proposée à l’écriture, mais l’application est « en attente »', async () => {
    for (const etat of ['RECEIVED', 'APPLYING']) {
      const r = await charger({ application_state: etat, applied: false });
      expect(r.choices.map((c) => [c.by, c.normalized, c.application]), etat).toEqual([['T3', 'b', 'PENDING']]);
      expect(r.fingerprints.get('fp-1'), etat).toMatchObject({ resolved: true, applicationPending: true });
      __resetArbitrationTableProbeForTests();
    }
  });

  it('ÉCHEC d’application, puis ESCALADE après épuisement des reprises (trois tentatives)', async () => {
    expect(ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS).toBe(3);
    expect((await charger({ application_state: 'APPLY_FAILED', applied: false })).choices[0].application).toBe('FAILED');
    __resetArbitrationTableProbeForTests();
    expect((await charger({ application_state: 'ESCALATED', applied: false })).choices[0].application).toBe('ESCALATED');
  });

  it('application VÉRIFIÉE : état APPLIED ; ligne antérieure à la migration 1785 : état INCONNU (le contrôle en base décide)', async () => {
    expect((await charger({ application_state: 'APPLIED' })).choices[0].application).toBe('APPLIED');
    __resetArbitrationTableProbeForTests();
    expect((await charger({ application_state: null, applied: true })).choices[0].application).toBe('APPLIED');
    __resetArbitrationTableProbeForTests();
    const ancienne = await charger({ application_state: null, applied: false });
    expect(ancienne.choices[0].application).toBe('UNTRACKED');
    expect(ancienne.fingerprints.get('fp-1')).toMatchObject({ applicationPending: false });
  });

  it('migration 1785 NON PASSÉE : rien n’échoue, aucune empreinte à régulariser, l’état reste inconnu', async () => {
    const r = await charger({ application_state: null, applied: false, evidence_key: null }, { colonnes1785: false });
    expect(r.ready).toBe(true);
    expect(r.choices[0].application).toBe('UNTRACKED');
    expect([...r.unkeyed]).toEqual([]);
  });

  it('verdict « document étranger » : le document désigné est porté par l’examen (chaîne de réparation, E08)', async () => {
    const r = await charger({ outcome: 'LINK_ERROR', retained_normalized: null, foreign_file_id: 77 });
    expect([...r.reviews.values()].map((v) => [v.outcome, v.foreignFileId])).toEqual([['LINK_ERROR', 77]]);
  });
});

describe('C836-U-E07-REG — régularisation des empreintes historiques, une seule fois (E07)', () => {
  const conflit = (evidenceKey?: string): QualifiedAttributeConflict => ({
    field: 'provider', role: 'SUPPLIER',
    values: [{ value: 'A', normalized: 'a', sourceIds: [1], sources: [] }, { value: 'B', normalized: 'b', sourceIds: [2], sources: [] }],
    retained: 'A', qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'SAME_REFERENCE', impact: ['OPERATION'],
    ...(evidenceKey ? { evidenceKey } : {}),
  });

  it('CONTRE-EXEMPLE — une empreinte `evidence_key = NULL` est RÉGULARISÉE (avant : tolérée, donc jamais réexaminée)', async () => {
    const fp = arbitrationFingerprint(8, 'provider', 'SUPPLIER', ['a', 'b']);
    const { x, ecritures } = faux([ligne({ fingerprint: fp, evidence_key: null, status: 'DECIDED' })]);
    const charge = await loadAttributeReviews(x, 11, 8);
    expect([...charge.unkeyed]).toEqual([fp]);
    expect(await regularizeEvidenceKeys(x, 11, 8, [conflit('l115:deadbeef:200')], charge)).toBe(1);
    expect(ecritures.join(' ')).toMatch(/SET evidence_key = .*WHERE account_id = .*AND fingerprint = .*AND evidence_key IS NULL/);
    // Idempotente : rien de plus au rejeu (le périmètre est désormais mémorisé).
    const avant = ecritures.length;
    expect(await regularizeEvidenceKeys(x, 11, 8, [conflit('l115:deadbeef:200')], charge)).toBe(0);
    expect(ecritures).toHaveLength(avant);
  });

  it('aucune empreinte calculable, ou ligne encore en attente d’examen : rien n’est écrit', async () => {
    const fp = arbitrationFingerprint(8, 'provider', 'SUPPLIER', ['a', 'b']);
    const sansCle = faux([ligne({ fingerprint: fp, evidence_key: null })]);
    const charge1 = await loadAttributeReviews(sansCle.x, 11, 8);
    expect(await regularizeEvidenceKeys(sansCle.x, 11, 8, [conflit()], charge1)).toBe(0);
    __resetArbitrationTableProbeForTests();
    const enAttente = faux([ligne({ fingerprint: fp, evidence_key: null, status: 'PENDING', outcome: null, retained_normalized: null })]);
    const charge2 = await loadAttributeReviews(enAttente.x, 11, 8);
    expect([...charge2.unkeyed]).toEqual([]);
    expect(await regularizeEvidenceKeys(enAttente.x, 11, 8, [conflit('l115:deadbeef:200')], charge2)).toBe(0);
  });

  it('une décision dont l’APPLICATION reste à faire n’est jamais renvoyée à l’IA (c’est l’application qui manque, pas l’avis)', () => {
    expect(SOURCE).toMatch(/if \(deja\.applicationPending \|\| c\.evidenceKey === undefined\) return false;/);
    expect(SOURCE).toMatch(/if \(deja\.evidenceKey === null\) return loaded\.unkeyed\.has\(lineFingerprint\(operationId, c\)\);/);
    expect(SOURCE).toMatch(/return deja\.evidenceKey !== c\.evidenceKey;/);
  });

  it('la réouverture d’un examen EXIGE une évolution matérielle (jamais un rejeu), et laisse l’application en cours tranquille', () => {
    expect(SOURCE).toMatch(/evidence_key IS DISTINCT FROM EXCLUDED\.evidence_key/);
    expect(SOURCE).toMatch(/AND business_operation_attribute_arbitrations\.status NOT IN \('PENDING'\)/);
    expect(SOURCE).toMatch(/AND COALESCE\(business_operation_attribute_arbitrations\.application_state, 'APPLIED'\) <> 'APPLIED'\)\)/);
  });
});

describe('C836-U-E09-SQL — réservation atomique, escalade, contrôle en base (E09)', () => {
  it('DEUX WORKERS : la reprise RÉSERVE ses lignes en une instruction atomique et compte la tentative (avant : un simple SELECT)', () => {
    expect(SOURCE).toMatch(/UPDATE business_operation_attribute_arbitrations a\s+SET application_state = 'APPLYING', application_attempts = a\.application_attempts \+ 1/);
    expect(SOURCE).toMatch(/FOR UPDATE SKIP LOCKED\)/);
    expect(SOURCE).toMatch(/AND s\.application_attempts < \$\{ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS\}/);
  });

  it('ESCALADE : les lignes dont le plafond est ÉPUISÉ passent à un état durable, avec leur trace et le journal', () => {
    expect(SOURCE).toMatch(/SET application_state = 'ESCALATED'/);
    expect(SOURCE).toMatch(/'APPLICATION_ATTEMPTS_EXHAUSTED'/);
    expect(SOURCE).toMatch(/applicationEscalated/);
    expect(SOURCE).toMatch(/AND s\.application_attempts >= \$\{ATTRIBUTE_ARBITRATION_MAX_ATTEMPTS\}/);
    expect(SOURCE).toMatch(/event: 't3\.attribute_arbitration\.application_escalated'/);
    // Journal : des identifiants, jamais une valeur du client.
    expect(SOURCE).not.toMatch(/application_escalated'[^}]*retained_value/);
  });

  it('CONTRÔLE EN BASE : compte, événement actif, champ, valeur, provenance, même fait et même période', () => {
    expect(SOURCE).toMatch(/async function verifyApplication/);
    expect(SOURCE).toMatch(/invalidated_at IS NULL AND o\.merged_into_operation_id IS NULL\) AS active/);
    expect(SOURCE).toMatch(/'attribute_provenance' -> 'fields' -> \$\{d\.field\} ->> 'value' AS provenance/);
    expect(SOURCE).toMatch(/lineFingerprint\(d\.operationId, c\) === d\.fingerprint\);/);
    expect(SOURCE).toMatch(/return encore \? \{ applied: false, value, reason: 'CONFLICT_STILL_OPEN' \} : \{ applied: true, value \};/);
    // La vérification est faite APRÈS la reconsolidation, ligne par ligne, et elle décide de l'état durable.
    expect(SOURCE).toMatch(/const controle = await verifyApplication\(x, accountId, r, r\.value\);/);
    expect(SOURCE).toMatch(/application_state = \$\{appliquee \? 'APPLIED' : 'APPLY_FAILED'\}/);
  });

  it('CRASH ou ERREUR SQL après la décision : l’état durable est écrit dans la MÊME instruction, et la reprise est idempotente', () => {
    // Décision + état d'application : une seule instruction (deux UPDATE successifs pouvaient être coupés entre eux).
    expect(SOURCE).toMatch(/const etat = r\.applicationState && await arbitrationStateColumnsReady\(x\)/);
    expect(SOURCE).toMatch(/UPDATE business_operation_attribute_arbitrations\s+SET \$\{etat\} status = \$\{r\.status\}/);
    // Une décision REÇUE rouvre son budget de reprises (jamais une escalade héritée d'un verdict précédent).
    expect(SOURCE).toMatch(/application_attempts = CASE WHEN \$\{r\.applicationState === 'RECEIVED'\} THEN 0 ELSE application_attempts END/);
    // Marquage « en cours » : seulement les décisions nouvelles, jamais une application déjà aboutie.
    expect(SOURCE).toMatch(/const aMarquer = resolus\.filter\(\(r\) => !r\.claimed\)\.map\(\(r\) => r\.id\);/);
    expect(SOURCE).toMatch(/AND applied_at IS NULL\s+AND application_state IN \('RECEIVED', 'APPLYING', 'APPLY_FAILED'\)/);
    // L'écriture de la trace reste bornée au compte (isolation).
    expect(SOURCE).toMatch(/WHERE id = \$\{r\.id\} AND account_id = \$\{accountId\}/);
  });

  it('la phase rend ce qu’elle a fait : appliqué, repris, en échec, ESCALADÉ (lisible par le BO et la recette)', () => {
    expect(SOURCE).toMatch(/escalated\?: number;/);
    expect(SOURCE).toMatch(/if \(escalades\.length\) out\.escalated = escalades\.length;/);
  });
});
