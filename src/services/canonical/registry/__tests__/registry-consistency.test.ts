/**
 * Cohérence du registre canonique avec le code existant (lecture seule).
 *
 * Chaque clé employée aujourd'hui par la fiche, l'assistant, T1, T3 et T4
 * doit être canonique, alias déclaré ou exclusion déclarée. Les listes non
 * exportées par leurs modules sont relues dans le texte source.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { assets } from '@/db/schema';
import { ASSISTANT_ASSET_FIELDS } from '@/services/verebona-assistant/commands/asset-fields';
import { DATE_DETAIL_FIELDS, FUTURE_ONLY_DETAIL_FIELDS } from '@/lib/asset-detail-rules';
import { CRITICAL_FIELDS } from '@/services/ai/reconciliation/decision/critical-fields';
import { STRUCTURAL_ASSET_FIELDS } from '@/services/ai/reconciliation/coherence-impact';
import { AUTHORIZED_CREATION_TYPES } from '@/services/ai/agenda/agenda-intelligence.service';
import { getBaseAuthorityTable } from '@/services/ai/evidence/authority-score';
import { CORPUS_CASES } from '@/services/ai/governance/corpus/corpus-cases';
import {
  ASSET_FAMILY_CODES,
  CANONICAL_FIELDS,
  CONTEXTUAL_ALIASES,
  DOCUMENT_CATALOG,
  EVENT_CATALOG,
  EXCLUDED_KEYS,
  aliasToken,
  columnToProperty,
  getEventEntry,
  getField,
  isContextualAlias,
  isExcludedKey,
  resolveAlias,
  resolveDocumentType,
  type AssetFamily,
} from '..';

const ROOT = resolve(__dirname, '../../../../..');
const src = (p: string) => readFileSync(resolve(ROOT, 'src', p), 'utf8');

/** Clé connue : canonique ou alias dans au moins une famille, ou exclusion déclarée. */
function classee(k: string): boolean {
  if (isExcludedKey(k)) return true;
  // Alias contextuel (D-C / D-D, lot 20) : classé, sa clé dépend du document.
  if (isContextualAlias(k)) return true;
  if (resolveAlias(k)) return true;
  return ASSET_FAMILY_CODES.some((f) => resolveAlias(k, f) !== undefined);
}
const nonClassees = (keys: Iterable<string>) => [...new Set(keys)].filter((k) => !classee(k));

describe('registre — structure', () => {
  it('clés canoniques uniques', () => {
    const keys = CANONICAL_FIELDS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('chaque clé canonique se résout vers elle-même dans chacune de ses familles', () => {
    for (const d of CANONICAL_FIELDS) {
      for (const f of d.families) expect(resolveAlias(d.key, f)).toBe(d.key);
    }
  });

  it('aucun alias ne désigne deux clés dans une même famille', () => {
    for (const f of ASSET_FAMILY_CODES) {
      const vu = new Map<string, string>();
      for (const d of CANONICAL_FIELDS.filter((x) => x.families.includes(f))) {
        for (const raw of [d.key, ...d.aliases]) {
          const t = aliasToken(raw);
          const deja = vu.get(t);
          if (deja && deja !== d.key) throw new Error(`${f} : « ${raw} » désigne ${deja} et ${d.key}`);
          vu.set(t, d.key);
        }
      }
    }
  });

  it('alias contextuels (D-C, D-D) : branches vers des clés canoniques, jamais exclus ni clés canoniques', () => {
    for (const [raw, regle] of Object.entries(CONTEXTUAL_ALIASES)) {
      expect(getField(raw), raw).toBeUndefined();
      expect(isExcludedKey(raw), raw).toBeUndefined();
      for (const k of Object.values(regle)) if (k !== null) expect(getField(k), `${raw} → ${k}`).toBeDefined();
      // Branche générale déclarée comme alias : résolution SANS contexte inchangée.
      if (regle.otherwise) expect(resolveAlias(raw), raw).toBe(regle.otherwise);
      else expect(resolveAlias(raw), raw).toBeUndefined();
    }
  });

  it('aucun alias ni clé ne recoupe une exclusion', () => {
    const exclus = new Set(EXCLUDED_KEYS.map((e) => aliasToken(e.key)));
    for (const d of CANONICAL_FIELDS) {
      for (const raw of [d.key, ...d.aliases]) expect(exclus.has(aliasToken(raw)), raw).toBe(false);
    }
  });

  it('valeurs d’enum et libellés cohérents, unités monétaires conformes à D-09', () => {
    for (const d of CANONICAL_FIELDS) {
      if (d.valueType === 'enum') expect(d.enumValues?.length, d.key).toBeGreaterThan(0);
      if (d.enumLabels) for (const k of Object.keys(d.enumLabels)) expect(d.enumValues).toContain(k);
      if (d.valueType === 'money_eur') expect(d.unit, d.key).toBe('EUR');
      // Centimes seulement pour une clé *Cents (D-09).
      if (d.valueType === 'money_cents') expect(d.key).toMatch(/Cents$/);
      if (/Cents$/.test(d.key)) expect(d.valueType).toBe('money_cents');
      for (const a of Object.keys(d.aliasUnits ?? {})) expect(d.aliases).toContain(a);
    }
  });
});

describe('registre — miroirs (D-10)', () => {
  const colonnes = new Map(Object.entries(getTableColumns(assets)).map(([prop, c]) => [c.name, prop]));

  it('chaque colonne miroir existe dans assets, avec la propriété Drizzle attendue', () => {
    for (const d of CANONICAL_FIELDS) {
      for (const m of d.mirrorColumns ?? []) {
        expect(colonnes.has(m.column), `${d.key} → ${m.column}`).toBe(true);
        expect(colonnes.get(m.column)).toBe(columnToProperty(m.column));
      }
    }
  });

  it('une colonne n’a qu’une clé source par famille', () => {
    for (const f of ASSET_FAMILY_CODES) {
      const vu = new Map<string, string>();
      for (const d of CANONICAL_FIELDS.filter((x) => x.families.includes(f))) {
        for (const m of d.mirrorColumns ?? []) {
          expect(vu.get(m.column) ?? d.key, `${f} ${m.column}`).toBe(d.key);
          vu.set(m.column, d.key);
        }
      }
    }
  });

  it('colonnes historiques attendues couvertes', () => {
    const couvertes = new Set(CANONICAL_FIELDS.flatMap((d) => (d.mirrorColumns ?? []).map((m) => m.column)));
    for (const c of ['purchase_date', 'purchase_price_cents', 'registration_number', 'address', 'city', 'postal_code',
      'warranty_end_date', 'mileage_or_hours', 'estimated_value_cents', 'last_maintenance_date']) {
      expect(couvertes.has(c), c).toBe(true);
    }
  });

  it('montant ↔ centimes : transformation eur_to_cents pour un money_eur uniquement', () => {
    for (const d of CANONICAL_FIELDS) {
      for (const m of d.mirrorColumns ?? []) {
        if (m.column.endsWith('_cents')) expect(m.transform, d.key).toBe('eur_to_cents');
        if (m.transform === 'eur_to_cents') expect(d.valueType).toBe('money_eur');
        if (d.valueType === 'date') expect(m.transform).toBe('date');
      }
    }
  });
});

describe('registre — clés employées aujourd’hui', () => {
  it('CDC §5 : table d’alias', () => {
    const table: Array<[string, string, AssetFamily?]> = [
      ['dateAchat', 'acquisitionDate'], ['purchaseDate', 'acquisitionDate'],
      ['prixAchat', 'acquisitionPrice'], ['purchasePrice', 'acquisitionPrice'],
      ['immatriculation', 'registrationNumber'], ['kilométrage', 'mileage'],
      ['dateIntervention', 'lastRevision'], ['lastMaintenanceDate', 'lastRevision'],
      ['prochaineEcheance', 'maintenanceDueDate'], ['dateEcheance', 'insuranceExpiry'],
      ['finGarantie', 'warrantyEndDate'], ['dateFinContrat', 'contractEndDate'],
      ['classeEnergie', 'dpeClass'], ['surfaceHabitable', 'livingArea'], ['numeroSerie', 'serialNumber'],
    ];
    for (const [raw, key, f] of table) expect(resolveAlias(raw, f), raw).toBe(key);
  });

  it('assistant : champs modifiables = assistantWritable, mêmes formulations et familles', () => {
    const writable = CANONICAL_FIELDS.filter((d) => d.assistantWritable).map((d) => d.key).sort();
    expect(writable).toEqual(ASSISTANT_ASSET_FIELDS.map((d) => d.key).sort());
    for (const a of ASSISTANT_ASSET_FIELDS) {
      const d = getField(a.key)!;
      expect(d.assistantPhrases).toEqual(a.aliases);
      const familles = Object.keys(a.sections).map((f) => (f === 'OBJET' ? 'OBJECT' : f)).sort();
      expect([...d.families].sort()).toEqual(familles);
    }
  });

  it('fiche bien : clés des sections (AssetDetailsTab) et de la route details', () => {
    // Jusqu'aux libellés de sections : la checklist CIL qui suit porte des codes de rubriques.
    const tab = src('components/assets/AssetDetailsTab.tsx').split('const SECTION_LABELS')[0];
    const route = src('app/api/assets/[id]/details/route.ts');
    const cles = [
      ...[...tab.matchAll(/\{\s*key:\s*'([A-Za-z0-9]+)'/g)].map((m) => m[1]),
      ...[...route.matchAll(/\bkc\.([A-Za-z0-9]+)/g)].map((m) => m[1]),
    ];
    expect(cles.length).toBeGreaterThan(60);
    expect(nonClassees(cles)).toEqual([]);
  });

  it('écriture fiche : sections d’enrichissement (enrich-and-coherence, apply-ai-suggestions)', () => {
    const cles: string[] = [];
    for (const p of ['services/document-ai/enrich-and-coherence.service.ts', 'services/document-ai/apply-ai-suggestions.ts']) {
      for (const m of src(p).matchAll(/^\s+[a-z_]+:\s+\[([^\]]+)\]/gm)) {
        // Clés de champs (camelCase) ; les listes de types documentaires (MAJUSCULES) sont ignorées.
        for (const k of m[1].matchAll(/'([a-z][A-Za-z0-9]*)'/g)) cles.push(k[1]);
      }
    }
    expect(cles.length).toBeGreaterThan(20);
    expect(nonClassees(cles)).toEqual([]);
  });

  it('règles de saisie, T3 (champs critiques et structurants)', () => {
    expect(nonClassees([...DATE_DETAIL_FIELDS, ...Object.keys(FUTURE_ONLY_DETAIL_FIELDS)])).toEqual([]);
    expect(nonClassees([...CRITICAL_FIELDS, ...STRUCTURAL_ASSET_FIELDS])).toEqual([]);
  });

  it('T4 : DEADLINE_FIELDS portent tous un effet agenda (dpeDate devient HISTORICAL, T4-03)', () => {
    const txt = src('services/ai/source-analysis/steps/build-agenda-candidates.step.ts');
    const bloc = /DEADLINE_FIELDS[^{]*\{([\s\S]*?)\};/.exec(txt)![1];
    const cles = [...bloc.matchAll(/^\s+([A-Za-z0-9]+):/gm)].map((m) => m[1]);
    expect(cles.length).toBe(8);
    for (const k of cles) {
      const d = getField(k);
      expect(d?.agendaEffect, k).toBeDefined();
      expect(d!.agendaEffect!.nature).toBe(k === 'dpeDate' ? 'HISTORICAL' : 'DEADLINE');
    }
  });

  it('corpus T1 : clés françaises d’extraction classées', () => {
    // Clés d'évaluation du harnais, pas des faits.
    const META = new Set(['ibanTransmisAuModele', 'surfaceRetenueSurLeBien', 'conflitDetecte', 'primeRetenue', 'regroupementAttendu']);
    const cles = (CORPUS_CASES as Array<{ expected?: { fields?: Record<string, unknown> } }>)
      .flatMap((c) => Object.keys(c.expected?.fields ?? {}))
      .filter((k) => !META.has(k));
    expect(nonClassees(cles)).toEqual([]);
  });

  it('D-12 : informations complémentaires jamais résolues', () => {
    for (const e of EXCLUDED_KEYS.filter((x) => x.kind === 'ADDITIONAL_INFO')) {
      for (const f of ASSET_FAMILY_CODES) expect(resolveAlias(e.key, f), e.key).toBeUndefined();
    }
    expect(resolveAlias('monthlyRentCents', 'IMMOBILIER')).toBeUndefined();
  });
});

describe('catalogues — événements (T4-01) et documents (T4-04, T4-13)', () => {
  it('chaque effet agenda est déclaré dans l’événement correspondant, et inversement', () => {
    for (const d of CANONICAL_FIELDS.filter((x) => x.agendaEffect)) {
      const e = getEventEntry(d.agendaEffect!.businessType)!;
      expect(e.fieldKeys, d.key).toContain(d.key);
      expect(e.natures).toContain(d.agendaEffect!.nature);
    }
    for (const e of EVENT_CATALOG) {
      for (const k of e.fieldKeys) {
        expect(getField(k)?.agendaEffect?.businessType, k).toBe(e.businessType);
      }
      for (const n of e.natures) expect(e.homeCategory[n], `${e.businessType} ${n}`).toBeDefined();
      // D-14 : un événement historique n'est jamais notifié.
      if (e.natures.includes('HISTORICAL')) expect(e.notifiable.HISTORICAL).toBe(false);
    }
  });

  it('matrice §13 : achat, DPE, sinistre et vente', () => {
    expect(getField('acquisitionDate')!.agendaEffect).toMatchObject({ nature: 'HISTORICAL', businessType: 'purchase' });
    expect(getField('dpeDate')!.agendaEffect).toMatchObject({ nature: 'HISTORICAL', businessType: 'dpe' });
    expect(getField('dpeExpiryDate')!.agendaEffect).toMatchObject({ nature: 'DEADLINE', businessType: 'dpe' });
    expect(getField('nextInspection')!.agendaEffect!.nature).toBe('DEADLINE');
    expect(getField('maintenanceDueDate')!.agendaEffect!.nature).toBe('DEADLINE');
    expect(getField('lastRevision')!.agendaEffect!.nature).toBe('HISTORICAL');
    expect(getEventEntry('SINISTRE')!.natures).toEqual(['HISTORICAL']);
    expect(getEventEntry('sale')!.natures).toEqual(['HISTORICAL']);
    expect(getEventEntry('ENTRETIEN')!.businessType).toBe('maintenance');
  });

  it('T4-04 : types autorisés du lot 10 conservés ; inconnu = non autoritaire', () => {
    for (const t of AUTHORIZED_CREATION_TYPES) {
      expect(resolveDocumentType(t)?.mayCreateAgenda, t).toBe(true);
    }
    expect(resolveDocumentType('TYPE_INCONNU')).toBeUndefined();
    expect(resolveDocumentType(null)).toBeUndefined();
    expect(resolveDocumentType('DEVIS')!.mayCreateAgenda).toBe(false);
    expect(resolveDocumentType('MAINTENANCE_QUOTE')!.code).toBe('DEVIS');
  });

  it('types de la table d’autorité de base tous catalogués', () => {
    for (const t of Object.keys(getBaseAuthorityTable())) expect(resolveDocumentType(t), t).toBeDefined();
  });

  it('types de preuve historiques (status-reconciler) catalogués avec une preuve « completed »', () => {
    const txt = src('services/ai/agenda/status-reconciler.ts');
    const bloc = /COMPLETION_DOCUMENT_TYPES = new Set\(\[([\s\S]*?)\]\)/.exec(txt)![1];
    for (const m of bloc.matchAll(/'([A-Z_]+)'/g)) {
      const e = resolveDocumentType(m[1]);
      expect(e, m[1]).toBeDefined();
      // CERTIFICAT_GARANTIE : ne prouve pas une exécution (aucune forme de preuve).
      if (m[1] !== 'CERTIFICAT_GARANTIE') {
        expect(e!.completionProofs.some((p) => p.establishes === 'completed'), m[1]).toBe(true);
      }
    }
  });

  it('T4-13 : PV favorable et facture simple produisent des statuts différents', () => {
    const pv = resolveDocumentType('VEHICLE_TECHNICAL_INSPECTION')!;
    expect(pv.completionProofs.find((p) => p.code === 'PV_CONTROLE_FAVORABLE')!.establishes).toBe('completed');
    const facture = resolveDocumentType('FACTURE')!;
    expect(facture.completionProofs.find((p) => p.code === 'FACTURE_SIMPLE')!.establishes).toBe('not_proven');
  });

  it('portée de création (creationScope) : sous-ensemble des types du document, natures du catalogue', () => {
    for (const d of DOCUMENT_CATALOG.filter((x) => x.creationScope)) {
      expect(d.mayCreateAgenda, d.code).toBe(true);
      for (const b of d.creationScope!.businessTypes) {
        expect(d.businessTypes, d.code).toContain(b);
        for (const n of d.creationScope!.natures) expect(getEventEntry(b)!.natures, `${d.code} ${b}`).toContain(n);
      }
    }
  });

  it('codes et alias documentaires uniques ; types d’événement connus', () => {
    const vus = new Set<string>();
    for (const d of DOCUMENT_CATALOG) {
      for (const c of [d.code, ...(d.aliases ?? [])]) {
        expect(vus.has(c), c).toBe(false);
        vus.add(c);
      }
      for (const b of d.businessTypes) expect(getEventEntry(b), `${d.code} ${b}`).toBeDefined();
      for (const p of d.completionProofs) for (const b of p.businessTypes ?? []) expect(d.businessTypes).toContain(b);
    }
  });
});
