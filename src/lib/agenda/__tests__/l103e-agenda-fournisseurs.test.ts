/**
 * Lot 103E — fournisseurs / intervenants des éléments d'Agenda : règles pures,
 * ICS, contrôle de cohérence déclaré, interface (sources).
 *
 *  L103E-U-RULES   mentions explicites, plan de synchronisation (USER intouchable, retrait respecté, idempotence)
 *  L103E-U-PAYLOAD validation de la sélection reçue par l'API
 *  L103E-U-ICS     noms seulement, échappement, repli à 75 octets, aucun participant
 *  L103E-U-COH     COH-AGENDA-SUPPLIERS en fin de registre, couvert (agenda), jamais destructeur
 *  L103E-U-UI      composant dédié, rubrique masquée si vide, jamais dans les cartes, aucun « Opération »
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agendaTimeBucket, findSupplierMentions, isDistinctiveName, isEmptySyncPlan, parseAgendaSuppliersPayload, planAgendaSupplierSync, supplierNamesLine,
} from '../agenda-suppliers-rules';
import { computeICSContent, escapeICS, foldLine } from '@/services/agenda/AgendaCalendarExportService';
import type { AgendaItemFull } from '@/services/agenda/AgendaQueryService';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('L103E-U-RULES — identification automatique (preuves propres à l’élément)', () => {
  const S = [
    { id: 1, normalizedName: 'durand expertise' },
    { id: 2, normalizedName: 'plomberie martin' },
    { id: 3, normalizedName: 'orange' },
    { id: 4, normalizedName: 'durand expertise conseil' },
    { id: 5, normalizedName: 'atelier bois' },
    { id: 6, normalizedName: 'atelier bois' },
  ];
  it('mention explicite en mots entiers, insensible à la casse et aux accents', () => {
    expect(findSupplierMentions('Visite de l’expert — PLOMBERIE MARTIN', S).matched).toEqual([2]);
    expect(findSupplierMentions('Plomberie Martinez', S).matched).toEqual([]);
  });
  it('nom d’un seul mot (marque, mot courant) : jamais une preuve', () => {
    expect(isDistinctiveName('orange')).toBe(false);
    expect(findSupplierMentions('Repeindre le portail en orange', S).matched).toEqual([]);
  });
  it('nom inclus dans un nom plus long mentionné : seul le plus long', () => {
    expect(findSupplierMentions('Rapport Durand Expertise Conseil', S).matched).toEqual([4]);
  });
  it('deux fiches de même nom : ambiguïté, aucun lien inventé', () => {
    const r = findSupplierMentions('Devis Atelier Bois', S);
    expect(r.matched).toEqual([]);
    expect(r.ambiguous).toEqual(['atelier bois']);
  });

  it('plan : preuve fiable → ajout ; lien USER jamais retiré ; retrait manuel jamais recréé (AC09)', () => {
    const p = planAgendaSupplierSync(
      [{ supplierId: 1, provenance: 'USER' }, { supplierId: 2, provenance: 'DOCUMENT' }],
      [{ supplierId: 3, provenance: 'DOCUMENT', documentId: 9 }, { supplierId: 4, provenance: 'AUTO', field: 'title' }],
      [4],
    );
    expect(p.add.map((a) => a.supplierId)).toEqual([3]);
    expect(p.suppressed).toEqual([4]);
    expect(p.remove).toEqual([{ supplierId: 2, provenance: 'DOCUMENT' }]);
    expect(p.remove.some((r) => r.supplierId === 1)).toBe(false);
  });
  it('plan : montée et descente de provenance automatique ; USER intouché', () => {
    const p = planAgendaSupplierSync(
      [{ supplierId: 1, provenance: 'AUTO' }, { supplierId: 2, provenance: 'DOCUMENT' }, { supplierId: 3, provenance: 'USER' }],
      [{ supplierId: 1, provenance: 'DOCUMENT', documentId: 5 }, { supplierId: 2, provenance: 'AUTO', field: 'description' }, { supplierId: 3, provenance: 'DOCUMENT', documentId: 6 }],
      [],
    );
    expect(p.upgrade.map((u) => [u.supplierId, u.provenance])).toEqual([[1, 'DOCUMENT'], [2, 'AUTO']]);
    expect(p.add).toEqual([]);
    expect(p.remove).toEqual([]);
  });
  it('plan idempotent : rejoué sur son résultat, il est vide (AC10)', () => {
    const preuves = [{ supplierId: 7, provenance: 'DOCUMENT' as const, documentId: 1 }, { supplierId: 8, provenance: 'AUTO' as const, field: 'title' as const }];
    const p1 = planAgendaSupplierSync([], preuves, []);
    const apres = p1.add.map((a) => ({ supplierId: a.supplierId, provenance: a.provenance }));
    expect(isEmptySyncPlan(planAgendaSupplierSync(apres, preuves, []))).toBe(true);
  });
  it('plusieurs preuves pour un même fournisseur : la plus forte, un seul lien', () => {
    const p = planAgendaSupplierSync([], [
      { supplierId: 1, provenance: 'AUTO', field: 'title' }, { supplierId: 1, provenance: 'DOCUMENT', documentId: 12 }, { supplierId: 1, provenance: 'DOCUMENT', documentId: 3 },
    ], []);
    expect(p.add).toEqual([{ supplierId: 1, provenance: 'DOCUMENT', documentId: 3 }]);
  });
  it('rubriques temporelles de la fiche fournisseur', () => {
    expect(agendaTimeBucket(null, '2026-11-02')).toBe('undated');
    expect(agendaTimeBucket('2026-11-01', '2026-11-02')).toBe('past');
    expect(agendaTimeBucket('2026-11-02', '2026-11-02')).toBe('future');
  });
});

describe('L103E-U-PAYLOAD — sélection reçue par l’API', () => {
  it('absent : rien ne change ; vide : retrait de tout', () => {
    expect(parseAgendaSuppliersPayload(undefined)).toBeUndefined();
    expect(parseAgendaSuppliersPayload({})).toEqual({ supplierIds: [], newSuppliers: [] });
  });
  it('identifiants dédoublonnés, noms nettoyés et dédoublonnés (casse, accents)', () => {
    expect(parseAgendaSuppliersPayload({ supplierIds: [3, '3', 4], newSuppliers: ['  Éco  Toit ', { name: 'eco toit' }, { name: 'Sud Élec', confirmNew: true }] }))
      .toEqual({ supplierIds: [3, 4], newSuppliers: [{ name: 'Éco Toit', confirmNew: false }, { name: 'Sud Élec', confirmNew: true }] });
  });
  it('refus avant toute écriture', () => {
    for (const bad of [[], 'x', { supplierIds: [0] }, { supplierIds: ['a'] }, { newSuppliers: [{ name: '' }] }, { newSuppliers: [{ name: 'x'.repeat(201) }] }, { supplierIds: Array.from({ length: 31 }, (_, i) => i + 1) }]) {
      expect(parseAgendaSuppliersPayload(bad)).toHaveProperty('error');
    }
  });
});

describe('L103E-U-ICS — export calendrier (AC12)', () => {
  const item = (over: Partial<AgendaItemFull> = {}): AgendaItemFull => ({
    id: 1, publicId: 'p-1', accountId: 1, createdByUserId: null, title: 'Visite expert', description: 'Constat dégât des eaux',
    startDate: '2026-11-20', startTime: '10:00:00', endDate: null, endTime: null,
    isAutomatic: false, isAutomaticModified: false, requiresQualification: false, originType: 'manual', originRefType: null, originRefId: null,
    originFieldKey: null, occurrenceNature: 'CONFIRMED', forecastInitialDate: null, confirmedAt: null, confirmationMode: null, recurrenceRule: null,
    createdAt: new Date(), updatedAt: new Date(), assetLinks: [], fileLinks: [], roomLinks: [], equipmentLinks: [], attentionFlags: [], ...over,
  });
  it('plusieurs fournisseurs : noms présents, échappés ; aucune coordonnée ni participant', () => {
    const ics = computeICSContent([item({ supplierNames: ['Durand, Expertise; SARL', 'Électricité Côte d’Azur', 'Durand, Expertise; SARL'] })], 'Compte');
    const deplie = ics.replace(/\r\n /g, '');
    expect(deplie).toContain('Fournisseurs / intervenants : Durand\\, Expertise\\; SARL\\, Électricité Côte d’Azur');
    expect(deplie.match(/Durand/g)).toHaveLength(1);
    expect(ics).not.toMatch(/ATTENDEE|ORGANIZER|MAILTO|tel:/i);
    for (const ligne of ics.split('\r\n')) expect(new TextEncoder().encode(ligne).length).toBeLessThanOrEqual(75);
  });
  it('sans fournisseur : aucune ligne ajoutée', () => {
    expect(computeICSContent([item()], 'Compte')).not.toContain('Fournisseurs');
  });
  it('repli RFC 5545 : jamais au milieu d’un caractère multi-octets', () => {
    const l = `DESCRIPTION:${'é'.repeat(100)}`;
    const plie = foldLine(l);
    expect(plie.split('\r\n').every((x) => new TextEncoder().encode(x).length <= 75)).toBe(true);
    expect(plie.replace(/\r\n /g, '')).toBe(l);
    expect(escapeICS('a\r\nb\rc')).toBe('a\\nb\\nc');
  });
  it('libellé de ligne : noms seulement, vide → null', () => {
    expect(supplierNamesLine([])).toBeNull();
    expect(supplierNamesLine([' A ', 'B', 'A'])).toBe('Fournisseurs / intervenants : A, B');
  });
});

describe('L103E-U-COH — contrôle de cohérence existant étendu (sans nouveau planificateur)', () => {
  it('COH-AGENDA-SUPPLIERS : fin de registre, actif, couvert par le domaine agenda, réparations interdites déclarées', async () => {
    const { COHERENCE_REGISTRY } = await import('@/services/coherence/registry');
    const { COVERAGE_INVENTORY } = await import('@/services/coherence/registry/coverage');
    const { COHERENCE_BUSINESS_EVENTS } = await import('@/services/coherence/events');
    // Fin de registre : après COH-EQUIPMENT-IDENTITY, suivi seulement des contrôles 103D.
    const ids = COHERENCE_REGISTRY.map((x) => x.id);
    expect(ids.slice(ids.indexOf('COH-EQUIPMENT-IDENTITY') + 1)[0]).toBe('COH-AGENDA-SUPPLIERS');
    const c = COHERENCE_REGISTRY.find((x) => x.id === 'COH-AGENDA-SUPPLIERS')!;
    expect(c.id).toBe('COH-AGENDA-SUPPLIERS');
    expect(c.status).toBe('ACTIVE');
    expect(COVERAGE_INVENTORY.find((d) => d.domain === 'agenda')!.checks).toContain('COH-AGENDA-SUPPLIERS');
    expect(c.forbiddenRepairs.join(' ')).toMatch(/utilisateur/);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/même événement de référence/);
    for (const t of c.triggers) expect(t === 'SOURCE_ANALYZED' || COHERENCE_BUSINESS_EVENTS.has(t)).toBe(true);
  });
  it('aucun planificateur ni tâche ajoutés par le lot', () => {
    const svc = src('src/services/agenda/agenda-suppliers.ts');
    expect(svc).not.toMatch(/setInterval|cron|registerJobHandler|scheduler/i);
  });
});

describe('L103E-U-UI — tiroir, fiche fournisseur, listes', () => {
  const section = src('src/components/agenda/AgendaSuppliersSection.tsx');
  const drawer = src('src/components/agenda/AgendaItemDrawer.tsx');
  const creation = src('src/components/agenda/CreateAgendaItemDrawer.tsx');
  const fiche = src('src/components/suppliers/SupplierAgendaSection.tsx');
  it('libellé « Fournisseur / intervenant », création ET modification, consultation masquée si vide', () => {
    expect(section).toContain('Fournisseur / intervenant');
    expect(section).toMatch(/if \(list\.length === 0\) return null;/);
    expect(drawer).toContain('<AgendaSuppliersView');
    expect(drawer).toContain('<AgendaSuppliersField');
    expect(creation).toContain('<AgendaSuppliersField');
  });
  it('aucune coordonnée dans la fiche d’événement ; liens vers la fiche du référentiel', () => {
    expect(section).not.toMatch(/phone|email|iban|address/i);
    expect(section).toContain('supplierHref(s.id)');
  });
  it('jamais dans les cartes et vues compactes de l’Agenda', () => {
    for (const f of ['src/components/agenda/AgendaPeriodViews.tsx']) expect(src(f)).not.toMatch(/fournisseur|supplier/i);
  });
  it('aucun mot « Opération » visible', () => {
    for (const t of [section, fiche]) expect(t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')).not.toMatch(/Op[ée]ration/);
  });
});
