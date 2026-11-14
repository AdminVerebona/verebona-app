/**
 * Lot 114O (Trello #744, CDC « Opérations / Agenda V2.0 », lot B) — graphe
 * canonique des événements de référence : règles PURES (`graph/model.ts`) et
 * gardes statiques (migrations 1715 à 1717, écrivains, façade). Sans base de
 * données. Les scénarios sur PostgreSQL réel sont dans
 * `src/test/e2e/scenarios/l114o-graphe-canonique.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENDA_LINK_STATES, GRAPH_HISTORY_ACTIONS, GRAPH_ORIGINS, GRAPH_RELATION_KINDS, OPERATION_RELATION_NATURES, OPERATION_RELATION_STATES,
  RELATION_SOURCE_TYPE, applied, decideAssociate, decideDissociate, evidenceFingerprint, isIdempotencyKey, mergedRelationState,
  normalizeEvidence, orientRelation, pairKey, refused,
  commandInputHash, declarationFingerprint, isIsoDay, normalizeDeclarationText, normalizeOperationPatch, DECLARATION_TEXT_MAX,
  type AssociateRequest, type GraphEvidence, type OperationFacts, type RelationSnapshot,
} from '../model';

const ROOT = process.cwd();
const lire = (f: string): string => readFileSync(join(ROOT, f), 'utf8');
const sqlSansCommentaires = (f: string): string => lire(`src/db/migrations/${f}`).replace(/--.*$/gm, '');
const M1715 = sqlSansCommentaires('1715_l114o_relations_evenements_reference.sql');
const M1716 = sqlSansCommentaires('1716_l114o_liens_evenement_reference_agenda.sql');
const M1717 = sqlSansCommentaires('1717_l114o_journal_graphe_evenements_reference.sql');
const M1718 = sqlSansCommentaires('1718_l114o_declarations_evenements_reference.sql');
const liste = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(', ');

const op = (id: number, typeCode: OperationFacts['typeCode'] = null, active = true): OperationFacts => ({ id, typeCode, active });
const doc = (ref: string): GraphEvidence => ({ kind: 'DOCUMENT', ref });
const rel = (over: Partial<RelationSnapshot> = {}): RelationSnapshot => ({
  id: 7, fromOperationId: 1, toOperationId: 2, nature: 'FINANCING', state: 'ACTIVE', origin: 'AI', version: 3, evidenceFingerprint: evidenceFingerprint([doc('10')]), ...over,
});
const demande = (over: Partial<AssociateRequest> = {}): AssociateRequest => ({
  from: op(1, 'FINANCING'), to: op(2, 'ACQUISITION'), nature: 'FINANCING', origin: 'USER', evidence: [], ...over,
});

describe('L114O-01 vocabulaire fermé : code = contraintes CHECK des migrations 1715 à 1717', () => {
  it('natures, états et origines des relations entre événements de référence', () => {
    expect(M1715).toContain(`CHECK (nature IN (${liste(OPERATION_RELATION_NATURES)}))`);
    expect(M1715).toContain(`CHECK (state IN (${liste(OPERATION_RELATION_STATES)}))`);
    expect(M1715).toContain(`CHECK (origin IN (${liste(GRAPH_ORIGINS)}))`);
  });
  it('états et origines des liens d’Agenda ; aucun état « refusé » (le refus reste dans la mémoire existante des décisions)', () => {
    expect(M1716).toContain(`CHECK (state IN (${liste(AGENDA_LINK_STATES)}))`);
    expect(M1716).toContain(`CHECK (origin IN (${liste(GRAPH_ORIGINS)}))`);
    expect(AGENDA_LINK_STATES).not.toContain('REJECTED');
  });
  it('objets et actions du journal', () => {
    expect(M1717).toContain(`CHECK (relation_kind IN (${liste(GRAPH_RELATION_KINDS)}))`);
    expect(M1717).toContain(`CHECK (action IN (${liste(GRAPH_HISTORY_ACTIONS)}))`);
  });
  it('relation orientée : origine typée (financement, sinistre) ; association : aucune contrainte de type', () => {
    expect(RELATION_SOURCE_TYPE).toEqual({ FINANCING: 'FINANCING', CLAIM_REPAIR: 'CLAIM', ASSOCIATED: null });
  });
});

describe('L114O-02 migrations 1715 à 1717 : additives, idempotentes, rejouables, sans « principal » ni parent', () => {
  const toutes: Array<[string, string]> = [['1715', M1715], ['1716', M1716], ['1717', M1717]];
  it('aucune instruction destructrice ; tables, index et contraintes gardés', () => {
    for (const [nom, sql] of toutes) {
      expect(sql, nom).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|ALTER TABLE \w+ (DROP|RENAME)/i);
      for (const m of sql.matchAll(/CREATE TABLE\s+(?!IF NOT EXISTS)/g)) throw new Error(`${nom} : CREATE TABLE sans IF NOT EXISTS (${m[0]})`);
      for (const m of sql.matchAll(/CREATE (UNIQUE )?INDEX\s+(?!IF NOT EXISTS)/g)) throw new Error(`${nom} : CREATE INDEX sans IF NOT EXISTS (${m[0]})`);
      for (const m of sql.matchAll(/ADD CONSTRAINT (\w+)/g)) expect(sql, `${nom} ${m[1]}`).toContain(`conname = '${m[1]}'`);
      for (const m of sql.matchAll(/CREATE TRIGGER (\w+)/g)) expect(sql, `${nom} ${m[1]}`).toContain(`DROP TRIGGER IF EXISTS ${m[1]}`);
      expect(sql, nom).not.toMatch(/CREATE FUNCTION/);
    }
  });
  it('aucune colonne de rôle, de principal ni de parent ; aucune écriture d’un rôle', () => {
    for (const [nom, sql] of toutes) {
      expect(sql, nom).not.toMatch(/parent_operation_id|parent_id|PRINCIPAL|is_main|is_principal/);
      expect(sql, nom).not.toMatch(/SET[^;]*operation_role\s*=/);
    }
    expect(M1716).not.toMatch(/\brole\b\s+TEXT/);
  });
  it('1716 : reprise déterministe bornée au même compte, rejouable (ON CONFLICT DO NOTHING), sans toucher aux éléments d’Agenda', () => {
    expect(M1716).toMatch(/JOIN business_operations o ON o\.id = ai\.business_operation_id AND o\.account_id = ai\.account_id/);
    expect(M1716).toMatch(/ON CONFLICT \(operation_id, agenda_item_id\) DO NOTHING;/);
    expect(M1716).not.toMatch(/UPDATE agenda_items|INSERT INTO agenda_items|notification|reminder/i);
  });
  it('1715 et 1717 : aucune reprise de données (aucune relation, aucun prêt ni achat fictifs)', () => {
    expect(M1715).not.toMatch(/INSERT INTO/);
    expect(M1717).not.toMatch(/INSERT INTO/);
  });
  it('intégrité de base : paire unique, non réflexive, cycle de vie, garde entre comptes sur les liens ACTIFS', () => {
    expect(M1715).toMatch(/CHECK \(from_operation_id <> to_operation_id\)/);
    expect(M1715).toMatch(/UNIQUE INDEX IF NOT EXISTS business_operation_relations_pair_uidx/);
    expect(M1715).toMatch(/CHECK \(\(state = 'ACTIVE'\) = \(ended_at IS NULL\)\)/);
    expect(M1716).toMatch(/UNIQUE INDEX IF NOT EXISTS business_operation_agenda_links_pair_uidx\s+ON business_operation_agenda_links \(operation_id, agenda_item_id\)/);
    for (const sql of [M1715, M1716]) expect(sql).toMatch(/IF NEW\.state = 'ACTIVE' AND \([\s\S]*RAISE EXCEPTION/);
  });
  it('1716 : le déclencheur de compatibilité ne lève jamais et ne reflète qu’un couple du même compte', () => {
    const fn = M1716.slice(M1716.indexOf('FUNCTION agenda_items_operation_link_sync'), M1716.indexOf('DROP TRIGGER IF EXISTS agenda_items_operation_link_sync'));
    expect(fn).not.toMatch(/RAISE/);
    expect(fn).toMatch(/o\.id = NEW\.business_operation_id AND o\.account_id = NEW\.account_id/);
    expect(M1716).toMatch(/AFTER INSERT OR UPDATE OF business_operation_id ON agenda_items/);
  });
});

describe('L114O-03 preuves : normalisation et empreinte', () => {
  it('bornées, dédoublonnées, ordre stable ; entrée invalide refusée', () => {
    expect(normalizeEvidence(undefined)).toEqual([]);
    expect(normalizeEvidence([doc('12'), doc('3'), doc('12')])).toEqual([doc('12'), doc('3')]);
    expect(normalizeEvidence([{ kind: 'INCONNU', ref: '1' }])).toBeNull();
    expect(normalizeEvidence([{ kind: 'DOCUMENT', ref: '' }])).toBeNull();
    expect(normalizeEvidence('x')).toBeNull();
    expect(normalizeEvidence(Array.from({ length: 21 }, (_, i) => doc(String(i))))).toBeNull();
  });
  it('empreinte : indépendante de l’ordre et de l’extrait cité ; nulle sans preuve', () => {
    expect(evidenceFingerprint([])).toBeNull();
    expect(evidenceFingerprint([doc('1'), doc('2')])).toBe(evidenceFingerprint([doc('2'), { ...doc('1'), locator: 'page 3' }]));
    expect(evidenceFingerprint([doc('1')])).not.toBe(evidenceFingerprint([doc('2')]));
  });
});

describe('L114O-04 paire et orientation', () => {
  it('une seule clé par paire non ordonnée', () => {
    expect(pairKey(5, 2)).toBe(pairKey(2, 5));
  });
  it('relation orientée : sens conservé ; association : ordre des identifiants', () => {
    expect(orientRelation('FINANCING', 9, 4)).toEqual({ fromOperationId: 9, toOperationId: 4 });
    expect(orientRelation('ASSOCIATED', 9, 4)).toEqual({ fromOperationId: 4, toOperationId: 9 });
  });
});

describe('L114O-05 associer deux événements de référence (CDC §4, §7, §9 ; AC12 à AC15, AC18)', () => {
  it('création : jamais réflexive, jamais sur un événement invalidé ou fusionné, origine typée', () => {
    expect(decideAssociate(demande(), null)).toEqual({ outcome: 'CREATE', ends: { fromOperationId: 1, toOperationId: 2 } });
    expect(decideAssociate(demande({ to: op(1, 'ACQUISITION') }), null)).toEqual({ outcome: 'FORBIDDEN', code: 'REFLEXIVE' });
    expect(decideAssociate(demande({ to: op(2, 'ACQUISITION', false) }), null)).toEqual({ outcome: 'FORBIDDEN', code: 'OPERATION_INACTIVE' });
    expect(decideAssociate(demande({ from: op(1, 'ACQUISITION') }), null)).toEqual({ outcome: 'FORBIDDEN', code: 'NATURE_TYPE_MISMATCH' });
    expect(decideAssociate(demande({ from: op(1, null) }), null)).toEqual({ outcome: 'FORBIDDEN', code: 'NATURE_TYPE_MISMATCH' });
    expect(decideAssociate(demande({ from: op(1, null), nature: 'ASSOCIATED' }), null).outcome).toBe('CREATE');
  });
  it('un financement peut viser plusieurs événements, de tout type (aucune contrainte sur la cible)', () => {
    for (const t of ['ACQUISITION', 'INTERVENTION', null] as const) expect(decideAssociate(demande({ to: op(2, t) }), null).outcome).toBe('CREATE');
  });
  it('une inférence cite au moins une preuve ; le geste de l’utilisateur est sa propre preuve', () => {
    expect(decideAssociate(demande({ origin: 'AI' }), null)).toEqual({ outcome: 'FORBIDDEN', code: 'EVIDENCE_REQUIRED' });
    expect(decideAssociate(demande({ origin: 'MIGRATION' }), null)).toEqual({ outcome: 'FORBIDDEN', code: 'EVIDENCE_REQUIRED' });
    expect(decideAssociate(demande({ origin: 'AI', evidence: [doc('10')] }), null).outcome).toBe('CREATE');
  });
  it('idempotence : même relation active → aucun changement (aucun doublon)', () => {
    expect(decideAssociate(demande(), rel())).toEqual({ outcome: 'NO_CHANGE', relationId: 7 });
    expect(decideAssociate(demande({ origin: 'AI', evidence: [doc('10')] }), rel())).toEqual({ outcome: 'NO_CHANGE', relationId: 7 });
  });
  it('REFUS de l’utilisateur : une inférence ne le lève jamais ; mêmes preuves → refus muet ; preuve nouvelle → arbitrage requis', () => {
    const refus = rel({ state: 'REJECTED', origin: 'USER' });
    expect(decideAssociate(demande({ origin: 'AI', evidence: [doc('10')] }), refus)).toEqual({ outcome: 'FORBIDDEN', code: 'USER_REJECTED' });
    expect(decideAssociate(demande({ origin: 'SYSTEM', evidence: [doc('10')] }), refus)).toEqual({ outcome: 'FORBIDDEN', code: 'USER_REJECTED' });
    expect(decideAssociate(demande({ origin: 'AI', evidence: [doc('10'), doc('11')] }), refus)).toEqual({ outcome: 'ARBITRATION_REQUIRED', code: 'NEW_EVIDENCE_AFTER_REFUSAL', relationId: 7 });
    // Refus posé sans preuve connue : toute preuve citée ensuite est nouvelle → arbitrage, jamais une réactivation.
    expect(decideAssociate(demande({ origin: 'AI', evidence: [doc('10')] }), rel({ state: 'REJECTED', evidenceFingerprint: null })).outcome).toBe('ARBITRATION_REQUIRED');
  });
  it('seul l’utilisateur lève son refus (nouvelle décision explicite)', () => {
    expect(decideAssociate(demande(), rel({ state: 'REJECTED', origin: 'USER' }))).toEqual({ outcome: 'REACTIVATE', ends: { fromOperationId: 1, toOperationId: 2 }, relationId: 7, liftsRefusal: true });
  });
  it('relation retirée sans refus : réactivable par une inférence sur preuve', () => {
    expect(decideAssociate(demande({ origin: 'AI', evidence: [doc('10')] }), rel({ state: 'REMOVED' }))).toMatchObject({ outcome: 'REACTIVATE', liftsRefusal: false });
  });
  it('requalification : par l’utilisateur ; jamais par une inférence sur une relation posée par l’utilisateur', () => {
    const associee = rel({ nature: 'ASSOCIATED', origin: 'USER' });
    expect(decideAssociate(demande(), associee)).toMatchObject({ outcome: 'UPDATE_NATURE', relationId: 7 });
    expect(decideAssociate(demande({ origin: 'AI', evidence: [doc('10')] }), associee)).toEqual({ outcome: 'FORBIDDEN', code: 'USER_RELATION_PROTECTED' });
    expect(decideAssociate(demande({ origin: 'AI', evidence: [doc('10')] }), rel({ nature: 'ASSOCIATED', origin: 'AI' })).outcome).toBe('UPDATE_NATURE');
  });
  it('version attendue périmée (carte obsolète, écran ancien) : conflit, aucune écriture', () => {
    expect(decideAssociate(demande({ expectedVersion: 2 }), rel())).toEqual({ outcome: 'CONFLICT', code: 'VERSION_MISMATCH', currentVersion: 3 });
    expect(decideAssociate(demande({ expectedVersion: 3 }), rel()).outcome).toBe('NO_CHANGE');
  });
});

describe('L114O-06 dissocier (CDC §4, §19 ; AC13, AC17)', () => {
  it('utilisateur : refus durable, y compris posé d’avance sur une paire jamais associée', () => {
    expect(decideDissociate({ aId: 1, bId: 2, origin: 'USER' }, rel())).toEqual({ outcome: 'REJECT', relationId: 7 });
    expect(decideDissociate({ aId: 1, bId: 2, origin: 'USER' }, null)).toEqual({ outcome: 'REJECT', relationId: null });
    expect(decideDissociate({ aId: 1, bId: 2, origin: 'USER' }, rel({ state: 'REMOVED' }))).toEqual({ outcome: 'REJECT', relationId: 7 });
    expect(decideDissociate({ aId: 1, bId: 2, origin: 'USER' }, rel({ state: 'REJECTED' }))).toEqual({ outcome: 'NO_CHANGE', relationId: 7 });
  });
  it('inférence : retrait simple, jamais d’une relation posée par l’utilisateur, jamais d’un refus', () => {
    expect(decideDissociate({ aId: 1, bId: 2, origin: 'AI' }, rel())).toEqual({ outcome: 'REMOVE', relationId: 7 });
    expect(decideDissociate({ aId: 1, bId: 2, origin: 'AI' }, rel({ origin: 'USER' }))).toEqual({ outcome: 'FORBIDDEN', code: 'USER_RELATION_PROTECTED' });
    expect(decideDissociate({ aId: 1, bId: 2, origin: 'AI' }, rel({ state: 'REJECTED', origin: 'USER' }))).toEqual({ outcome: 'NO_CHANGE', relationId: 7 });
    expect(decideDissociate({ aId: 1, bId: 2, origin: 'SYSTEM' }, null)).toEqual({ outcome: 'NO_CHANGE', relationId: null });
  });
  it('réflexive refusée ; version périmée → conflit', () => {
    expect(decideDissociate({ aId: 1, bId: 1, origin: 'USER' }, null)).toEqual({ outcome: 'FORBIDDEN', code: 'REFLEXIVE' });
    expect(decideDissociate({ aId: 1, bId: 2, origin: 'USER', expectedVersion: 1 }, rel())).toEqual({ outcome: 'CONFLICT', code: 'VERSION_MISMATCH', currentVersion: 3 });
  });
});

describe('L114O-07 fusion : le refus de l’utilisateur n’est jamais contourné', () => {
  it('refus > relation active > retrait', () => {
    expect(mergedRelationState('ACTIVE', 'REJECTED')).toBe('REJECTED');
    expect(mergedRelationState('REJECTED', 'ACTIVE')).toBe('REJECTED');
    expect(mergedRelationState('REMOVED', 'ACTIVE')).toBe('ACTIVE');
    expect(mergedRelationState('ACTIVE', 'REMOVED')).toBe('ACTIVE');
    expect(mergedRelationState('REMOVED', 'REMOVED')).toBe('REMOVED');
  });
});

describe('L114O-08 résultat des commandes (CDC §20)', () => {
  it('appliqué avec ou sans écriture ; refus sans écriture', () => {
    expect(applied(true, { a: 1 })).toEqual({ status: 'APPLIED', code: 'OK', changed: true, replayed: false, data: { a: 1 } });
    expect(applied(false)).toEqual({ status: 'APPLIED', code: 'NO_CHANGE', changed: false, replayed: false });
    expect(refused('CONFLICT', 'VERSION_MISMATCH')).toEqual({ status: 'CONFLICT', code: 'VERSION_MISMATCH', changed: false, replayed: false });
  });
  it('clé d’idempotence : texte court sans espace', () => {
    expect(isIdempotencyKey('w21:8f2c1e90-aa')).toBe(true);
    expect(isIdempotencyKey('court')).toBe(false);
    expect(isIdempotencyKey('avec espace 123')).toBe(false);
    expect(isIdempotencyKey(12345678)).toBe(false);
  });
});

describe('L114O-09 gardes d’architecture : un seul écrivain, compte toujours borné, aucun effet dérivé, aucun « principal »', () => {
  const store = lire('src/services/business-operations/graph/store.ts');
  const facade = lire('src/services/business-operations/operation-write.facade.ts');
  const read = lire('src/services/business-operations/graph/read.ts');
  const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('seul `graph/store.ts` écrit les trois tables du graphe', () => {
    expect(code(facade)).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+business_operation/);
    expect(code(read)).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM)\b/);
    expect(code(store)).not.toMatch(/DELETE FROM/);
  });
  it('chaque requête du magasin et du lecteur porte le compte (ou la liste de comptes du transfert)', () => {
    for (const [nom, src] of [['store', store], ['read', read]] as const) {
      const requetes = [...code(src).matchAll(/`((?:SELECT|INSERT INTO|UPDATE)[\s\S]*?)`/g)].map((m) => m[1]);
      expect(requetes.length, nom).toBeGreaterThanOrEqual(5);
      for (const q of requetes) expect(q, `${nom} : ${q.slice(0, 90)}`).toMatch(/account_id\b/);
    }
  });
  it('la façade et le magasin ne posent jamais un rôle, ne créent ni élément d’Agenda, ni composante, ni notification, et n’appellent aucune IA', () => {
    for (const src of [code(store), code(facade)]) {
      expect(src).not.toMatch(/designatePrincipal|operation_role\s*=|role:\s*'PRINCIPAL'|'PRINCIPAL'/);
      expect(src).not.toMatch(/INSERT INTO agenda_items|business_operation_financial_components|notification_outbox|addFinancialComponent/);
      expect(src).not.toMatch(/services\/ai\/|gateway|gemini|callModel|emitBusinessEvent/i);
      expect(src).not.toMatch(/parent_operation_id|parentOperationId/);
    }
  });
  it('la façade ne lève jamais : toute erreur devient un résultat ; les commandes livrées sont celles du lot B', () => {
    expect(code(facade)).toMatch(/return refused\('FAILED', 'TECHNICAL_FAILURE'\);/);
    const commandes = [...code(facade).matchAll(/^export function (\w+)\(ctx: OperationWriteContext/gm)].map((m) => m[1]).sort();
    expect(commandes).toEqual([
      'associateOperations', 'createOperation', 'dissociateOperations', 'invalidateOperation', 'linkAgendaItem', 'linkDocument', 'linkSupplier',
      'moveDocument', 'restoreOperation', 'unlinkAgendaItem', 'unlinkDocument', 'unlinkSupplier', 'updateOperation']);
    // Chaque commande livrée est documentée en tête de fichier ; chacune passe par l'exécution commune (droits, verrou, rejeu, journal).
    const entete = facade.slice(0, facade.indexOf('*/'));
    for (const c of commandes) expect(entete, c).toMatch(new RegExp(`\\b${c}\\b`));
    const corps = code(facade);
    expect((corps.match(/runCommand<[^>]+>\(ctx, /g) ?? []).length).toBe(12);
    expect(corps).toMatch(/return supplierCommand\(ctx, 'linkSupplier', input\);/);
    expect(corps).toMatch(/return supplierCommand\(ctx, 'unlinkSupplier', input\);/);
    // Commandes réservées à l'utilisateur : refus explicite d'une inférence, avant toute lecture.
    for (const c of ['createOperation', 'updateOperation', 'invalidateOperation', 'restoreOperation', 'linkDocument', 'unlinkDocument', 'moveDocument']) {
      const debut = corps.indexOf(`'${c}', input, async`);
      expect(corps.slice(debut, debut + 200), c).toMatch(/ctx\.actor\.kind !== 'USER'\) return stop\(refused\('FORBIDDEN', 'USER_ONLY'\)\)/);
    }
    // Jamais une suppression physique d'un événement de référence, d'un document ou d'un élément d'Agenda.
    expect(corps).not.toMatch(/DELETE FROM/);
  });
  it('droits de l’utilisateur : adhésion active ET compte non restreint, avant toute écriture', () => {
    const f = code(facade);
    expect(f).toMatch(/account_memberships[\s\S]*status = 'active'/);
    expect(f).toMatch(/getEntitlements\(accountId\)[\s\S]*\.canWrite/);
    expect(f.indexOf('checkOperationWriteAccess(accountId, actor.userId)')).toBeLessThan(f.indexOf('withGroupingWrite(accountId'));
  });
  it('la fusion existante et le transfert de bien appellent la part « graphe »', () => {
    expect(lire('src/services/business-operations/repository.ts')).toMatch(/await reassignGroupingOnMerge\([^\n]*\n[\s\S]{0,400}await reassignGraphOnMerge\(drizzleRunner\(this\.tx\), acct, A, C/);
    expect(lire('src/services/business-operations/grouping/service.ts')).toMatch(/detachCrossAccountGraphInTx\(r, accountIds\)/);
  });
  it('nouvelles tables déclarées : diagnostic, export de recette, transfert de bien, périmètre de reconstruction', () => {
    const tables = ['business_operation_relations', 'business_operation_agenda_links', 'business_operation_graph_history', 'business_operation_declarations'];
    const cov = lire('src/services/admin/diagnostics-export/coverage.ts');
    const cat = lire('src/services/admin/diagnostics-export/recette-catalog.ts');
    const tr = lire('src/services/assets/asset-account-transfer.service.ts');
    for (const t of tables) {
      expect(cov, t).toMatch(new RegExp(`\\b${t}: C\\(`));
      expect(cat, t).toMatch(new RegExp(`\\b${t}: \\{ domain: 'operations'`));
      expect(tr, t).toMatch(new RegExp(`\\b${t}: '`));
    }
    const scope = lire('src/services/business-operations/rebuild/model.ts');
    expect(scope).toMatch(/table: 'business_operation_relations', filter: ACC/);
    expect(scope).toMatch(/table: 'business_operation_declarations', filter: ACC/);
    // Un événement fondé sur une déclaration est une saisie de l'utilisateur : jamais purgé par la reconstruction.
    expect(lire('src/services/business-operations/rebuild/purge.ts')).toMatch(/source_kind IN \('CLAIM_FORM', 'USER_ARBITRATION', 'MIGRATION', 'USER_DECLARATION'\)/);
    expect(scope.indexOf("table: 'agenda_items'")).toBeLessThan(scope.indexOf("table: 'business_operation_agenda_links'"));
  });
  it('aucun texte d’écran nouveau : le mot « Opération » n’est rendu par aucune commande (codes seulement)', () => {
    const f = code(facade);
    for (const m of f.matchAll(/refused\('[A-Z_]+', '([A-Z_]+)'/g)) expect(m[1]).toMatch(/^[A-Z_]+$/);
    expect(code(read)).toMatch(/referenceEventLabel/);
  });
});

describe('L114O-10 migration 1718 : déclaration de l’utilisateur, source durable (CDC §5, §6, AC01)', () => {
  it('additive et rejouable : table gardée, contrainte ÉLARGIE sans retirer une valeur, aucune reprise de données', () => {
    expect(M1718).toMatch(/CREATE TABLE IF NOT EXISTS business_operation_declarations \(/);
    expect(M1718).not.toMatch(/\b(DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM)\b|\bUPDATE \w+\s+SET\b/);
    expect(M1718).not.toMatch(/INSERT INTO/);
    // La seule contrainte retirée est celle qui est reposée aussitôt, élargie, et seulement si elle ne l'est pas déjà.
    expect(M1718.match(/DROP CONSTRAINT/g)).toHaveLength(1);
    expect(M1718).toMatch(/pg_get_constraintdef\(oid\) NOT LIKE '%USER_DECLARATION%'[\s\S]*DROP CONSTRAINT business_operation_sources_kind_chk;[\s\S]*ADD CONSTRAINT business_operation_sources_kind_chk/);
    for (const v of ['DOCUMENT', 'ASSET_DATA', 'EQUIPMENT_DATA', 'AGENDA', 'CLAIM_FORM', 'USER_ARBITRATION', 'MIGRATION', 'USER_DECLARATION']) expect(M1718).toContain(`'${v}'`);
  });
  it('la déclaration suit son événement de référence (clé composée) et s’efface avec le compte', () => {
    expect(M1718).toMatch(/FOREIGN KEY \(operation_id, account_id\) REFERENCES business_operations\(id, account_id\) ON DELETE CASCADE ON UPDATE CASCADE/);
    expect(M1718).toMatch(/account_id\s+INTEGER\s+NOT NULL REFERENCES accounts\(id\) ON DELETE CASCADE/);
    expect(M1718).toContain(`char_length(btrim(declaration_text)) BETWEEN 1 AND ${DECLARATION_TEXT_MAX}`);
  });
});

describe('L114O-11 déclaration, correction et empreinte d’entrée (règles pures)', () => {
  it('texte utile : espaces normalisés, jamais vide, jamais tronqué en silence', () => {
    expect(normalizeDeclarationText('  Je vais   faire\nremplacer la chaudière ')).toBe('Je vais faire remplacer la chaudière');
    for (const v of ['', '   ', null, undefined, 12, 'x'.repeat(DECLARATION_TEXT_MAX + 1)]) expect(normalizeDeclarationText(v)).toBeNull();
    expect(normalizeDeclarationText('x'.repeat(DECLARATION_TEXT_MAX))).toHaveLength(DECLARATION_TEXT_MAX);
  });
  it('empreinte : même déclaration malgré la casse, les accents, la ponctuation ; différente pour un autre texte', () => {
    const a = declarationFingerprint('Je vais faire remplacer la chaudière.');
    expect(declarationFingerprint('je vais faire REMPLACER la chaudiere')).toBe(a);
    expect(declarationFingerprint('Je vais faire remplacer la chaudière de la maison')).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
  it('date civile réelle seulement (aucune heure, aucun fuseau, aucun jour impossible)', () => {
    for (const v of ['2024-02-29', '2030-03-15', '1999-12-31']) expect(isIsoDay(v), v).toBe(true);
    for (const v of ['2023-02-29', '2024-02-30', '2024-13-01', '2024-1-5', '2024-01-05T00:00:00Z', '15/03/2030', '', null, 20240105]) expect(isIsoDay(v), String(v)).toBe(false);
  });
  it('correction : champs connus seulement, une valeur par champ, jamais un effacement, jamais un champ inventé', () => {
    expect(normalizeOperationPatch(undefined)).toEqual({});
    expect(normalizeOperationPatch({})).toEqual({});
    expect(normalizeOperationPatch({ realizedDate: '2024-04-15', provider: '  Thermo   Services ' })).toEqual({ realizedDate: '2024-04-15', provider: 'Thermo Services' });
    expect(normalizeOperationPatch({ startDate: undefined, endDate: '2026-12-31' })).toEqual({ endDate: '2026-12-31' });
    for (const v of [{ realizedDate: null }, { realizedDate: '2024-02-30' }, { provider: '' }, { provider: 'x'.repeat(201) }, { amount: 12 }, { status: 'REALIZED' }, { technicalLabel: 'x' }, [], 'x', null]) {
      expect(normalizeOperationPatch(v), JSON.stringify(v)).toBeNull();
    }
  });
  it('empreinte de l’entrée d’une commande : stable quel que soit l’ordre des champs, sensible à la commande et aux valeurs', () => {
    const h = commandInputHash('associateOperations', { fromOperationId: 1, toOperationId: 2, nature: 'FINANCING', evidence: [{ kind: 'DOCUMENT', ref: '7' }] });
    expect(commandInputHash('associateOperations', { nature: 'FINANCING', evidence: [{ ref: '7', kind: 'DOCUMENT' }], toOperationId: 2, fromOperationId: 1, validFrom: undefined })).toBe(h);
    expect(commandInputHash('dissociateOperations', { fromOperationId: 1, toOperationId: 2, nature: 'FINANCING', evidence: [{ kind: 'DOCUMENT', ref: '7' }] })).not.toBe(h);
    expect(commandInputHash('associateOperations', { fromOperationId: 1, toOperationId: 3, nature: 'FINANCING', evidence: [{ kind: 'DOCUMENT', ref: '7' }] })).not.toBe(h);
    expect(commandInputHash('associateOperations', { fromOperationId: 1, toOperationId: 2, nature: 'FINANCING', evidence: [] })).not.toBe(h);
  });
  it('T3 ne réactive pas un événement de référence invalidé par l’utilisateur (garde placée avant toute lecture de sources)', () => {
    const c = lire('src/services/business-operations/consolidation/consolidator.ts');
    const debut = c.indexOf('export async function reconsolidateOperation(');
    const garde = c.indexOf('if (op.invalidatedAt !== null && op.invalidationReason === USER_INVALIDATION_REASON) return;', debut);
    expect(garde).toBeGreaterThan(debut);
    expect(garde).toBeLessThan(c.indexOf('FROM business_operation_sources WHERE operation_id', debut));
  });
});
