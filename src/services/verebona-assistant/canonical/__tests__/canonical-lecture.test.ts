/**
 * Couche de lecture canonique de l'assistant (CDC 15 §9, lot 15) — règles
 * pures : champ et source de niveau champ, statut d'agenda,
 * dépenses qualifiées, complétude, fournisseurs, règles d'offre, synthèse,
 * détection des questions.
 */
import { describe, it, expect } from 'vitest';
import {
  formatCanonicalValue, assetFieldSource, assetFieldSourceId, parseAssetFieldSourceId, type CanonicalFieldReading,
} from '../field-reader';
import { agendaStatus4, HISTORICAL_FIELD_KEYS } from '../agenda';
import { classifyExpenseDocument, aggregateExpenses, expenseThemeOf } from '../expenses';
import { requiredFieldsFor, missingRequiredFields } from '../completeness';
import { dedupeSuppliers } from '../suppliers';
import { productRuleSources, type ProductRuleData } from '../product-rules';
import { boundedExcerpt, synthesisSourceContent } from '../synthesis-content';
import { findReadableField, isFieldQuestion, upcomingAgendaRequest, fieldAnswer } from '../structured-answers';
import { unchangedSinceConfirmation } from '../commands';
import { attachCanonical } from '../repository';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

describe('lecture canonique seule (lot 16b-2)', () => {
  it('commutateurs retirés : plus aucun module de déploiement progressif (lot 16b-3)', () => {
    expect(existsSync(join(process.cwd(), 'src/services/canonical/rollout.ts'))).toBe(false);
  });
});

const lecture = (over: Partial<CanonicalFieldReading> = {}): CanonicalFieldReading => ({
  assetId: 42, assetName: 'Clio', key: 'acquisitionDate', label: 'Date d’achat', value: '2021-05-25', display: '25 mai 2021',
  origin: 'USER', originLabel: 'saisie par vous', updatedAt: '2026-01-02T10:00:00Z', from: 'key',
  evidence: { evidenceId: 7, fileId: 9, documentTitle: 'Facture', documentDate: '2021-05-25', excerpt: 'Date : 25/05/2021', confidence: 'certain' },
  openConflict: null, sensitive: false, ...over,
});

describe('T2-22 / T2-32 — champ canonique et source de niveau champ', () => {
  it('mise en forme selon le registre', () => {
    expect(formatCanonicalValue({ valueType: 'date' }, '2021-05-25')).toBe('25 mai 2021');
    expect(formatCanonicalValue({ valueType: 'money_eur', unit: 'EUR' }, 12500)).toMatch(/^12\s500 €$/);
    expect(formatCanonicalValue({ valueType: 'number', unit: 'km' }, 45000)).toMatch(/^45\s000 km$/);
    expect(formatCanonicalValue({ valueType: 'enum', enumLabels: { A: 'Classe A' } }, 'A')).toBe('Classe A');
    expect(formatCanonicalValue({ valueType: 'string' }, null)).toBeNull();
  });
  it('identifiant `asset_field:<id>:<clé>` : aller-retour, clé hors registre refusée', () => {
    expect(assetFieldSourceId(42, 'acquisitionDate')).toBe('asset_field:42:acquisitionDate');
    expect(parseAssetFieldSourceId('asset_field:42:acquisitionDate')).toEqual({ assetId: 42, key: 'acquisitionDate' });
    expect(parseAssetFieldSourceId('asset_field:42:passwordHash')).toBeNull();
    expect(parseAssetFieldSourceId('asset_42')).toBeNull();
  });
  it('la source porte valeur, origine, preuve et conflit ; une donnée sensible n’est pas écrite', () => {
    const s = assetFieldSource(lecture({ openConflict: { publicId: 'p', ruleCode: 'R', question: 'Quelle date ?', proposals: [] } }));
    expect(s).toMatchObject({ id: 'asset_field:42:acquisitionDate', type: 'asset_field', meta: { value: '2021-05-25', origin: 'USER', evidenceId: 7, openConflict: true } });
    expect(s.content).toContain('25 mai 2021');
    expect(s.content).toContain('saisie par vous');
    expect(s.content).toContain('Date : 25/05/2021');
    expect(s.content).toContain('conflit ouvert');
    const sensible = assetFieldSource(lecture({ sensitive: true, display: '12 rue X' }));
    expect(sensible.content).not.toContain('12 rue X');
    expect(sensible.meta?.value).toBeNull();
  });
  it('réponse : valeur, origine, preuve (hors saisie), conflit', () => {
    expect(fieldAnswer(lecture())).toBe('Vous avez acheté Clio le 25 mai 2021.');
    expect(fieldAnswer(lecture({ key: 'mileage', label: 'Kilométrage', display: '45 000 km', origin: 'RECONCILIATION', originLabel: 'retenue après rapprochement de vos documents' })))
      .toBe('Kilométrage de Clio : 45 000 km.');
    expect(fieldAnswer(lecture({ openConflict: { publicId: 'p', ruleCode: 'R', question: 'Quelle est la date ?', proposals: [] } })))
      .toContain('à arbitrer dans « À traiter »');
  });
  it('T2-02 : un fait T1 de clé du registre reçoit la valeur canonique du bien', () => {
    const fait = { id: 1, fileId: 9, factKey: 'kilometrage', subject: null, attribute: null, label: null, valueText: '44 000', valueNumber: 44000, valueUnit: 'km', confidence: 'certain', excerpt: '', documentTitle: 'CT', matchedTerms: 1 };
    const [enrichi, autre] = attachCanonical([fait, { ...fait, factKey: 'hors_registre' }],
      new Map([['mileage', lecture({ key: 'mileage', label: 'Kilométrage', display: '45 000 km', origin: 'USER' })]]));
    expect(enrichi.canonical).toMatchObject({ key: 'mileage', value: '45 000 km', origin: 'USER' });
    expect(autre.canonical).toBeUndefined();
  });
});

describe('T2-26 — statut d’agenda à 4 états ; D-14', () => {
  it('réalisé, annulé ; à venir → unknown ; passé : carte en attente → unknown, sinon not_proven', () => {
    const auj = '2026-09-30';
    expect(agendaStatus4('realise', false, '2026-01-01', auj)).toBe('completed');
    expect(agendaStatus4('annule', true, '2027-01-01', auj)).toBe('not_completed');
    // Date à venir, sans statut : rien ne peut être établi (arbitrage lot 15).
    expect(agendaStatus4(null, false, '2026-12-01', auj)).toBe('unknown');
    expect(agendaStatus4(null, false, auj, auj)).toBe('unknown');
    expect(agendaStatus4(null, false, null, auj)).toBe('unknown');
    // Date passée : not_proven réservé à ce cas, sauf carte en attente.
    expect(agendaStatus4(null, false, '2026-09-29', auj)).toBe('not_proven');
    expect(agendaStatus4(null, true, '2026-09-29', auj)).toBe('unknown');
  });
  it('champs historiques du registre (exclus des échéances)', () => {
    expect(HISTORICAL_FIELD_KEYS).toContain('acquisitionDate');
    expect(HISTORICAL_FIELD_KEYS).not.toContain('nextInspection');
  });
});

describe('T2-24 — dépenses qualifiées par thème', () => {
  it('thème d’une question', () => {
    expect(expenseThemeOf('Combien ai-je dépensé en entretien pour la Clio ?')).toBe('maintenance');
    expect(expenseThemeOf('total des travaux de la maison')).toBe('works');
    expect(expenseThemeOf('combien ai-je dépensé en 2025 ?')).toBeNull();
  });
  it('classe d’un document : thème, exclu (devis, annonce, bon de commande), non qualifié', () => {
    expect(classifyExpenseDocument('MAINTENANCE_INVOICE', null)).toEqual({ kind: 'theme', theme: 'maintenance' });
    expect(classifyExpenseDocument('REPAIR_QUOTE', null)).toMatchObject({ kind: 'excluded' });
    expect(classifyExpenseDocument(null, 'DEVIS')).toMatchObject({ kind: 'excluded' });
    expect(classifyExpenseDocument(null, 'ANNONCE_COMMERCIALE')).toMatchObject({ kind: 'excluded' });
    expect(classifyExpenseDocument(null, 'BON_COMMANDE')).toMatchObject({ kind: 'excluded' });
    expect(classifyExpenseDocument(null, 'AVIS_ECHEANCE')).toEqual({ kind: 'theme', theme: 'insurance' });
    expect(classifyExpenseDocument(null, 'FACTURE')).toEqual({ kind: 'unqualified' });
    expect(classifyExpenseDocument(null, null)).toEqual({ kind: 'unqualified' });
  });
  it('jamais de somme brute : thème, non qualifiés à part (couverture incomplète), exclus comptés', () => {
    const q = aggregateExpenses([
      { fileId: 1, amountCents: 10000, cls: { kind: 'theme', theme: 'maintenance' } },
      { fileId: 2, amountCents: 5000, cls: { kind: 'theme', theme: 'maintenance' } },
      { fileId: 3, amountCents: 90000, cls: { kind: 'theme', theme: 'insurance' } },
      { fileId: 4, amountCents: 7000, cls: { kind: 'unqualified' } },
      { fileId: 5, amountCents: 300000, cls: { kind: 'excluded', reason: 'DEVIS' } },
    ], 'maintenance');
    expect(q).toMatchObject({ qualifiedSumCents: 15000, qualifiedCount: 2, complete: false, unqualified: { count: 1, sumCents: 7000 }, excluded: { count: 1, byType: { DEVIS: 1 } } });
    expect(q.byTheme.map((t) => t.theme)).toEqual(['maintenance']);
    const tous = aggregateExpenses([{ fileId: 1, amountCents: 100, cls: { kind: 'theme', theme: 'maintenance' } }, { fileId: 3, amountCents: 900, cls: { kind: 'theme', theme: 'insurance' } }], null);
    expect(tous).toMatchObject({ qualifiedSumCents: 1000, complete: true });
  });
});

describe('T2-04 — complétude depuis le registre', () => {
  it('champs requis par famille', () => {
    expect(requiredFieldsFor('VEHICULE').map((d) => d.key)).toEqual(expect.arrayContaining(['acquisitionDate', 'registrationNumber']));
    expect(requiredFieldsFor('IMMOBILIER').map((d) => d.key)).toEqual(expect.arrayContaining(['acquisitionDate', 'city']));
    expect(requiredFieldsFor('OBJECT').map((d) => d.key)).not.toContain('registrationNumber');
  });
  it('manquants : valeur canonique vide (clé, alias ou colonne historique)', () => {
    const row = { id: 1, account_id: 1, category: 'VEHICULE', key_characteristics: JSON.stringify({ registrationNumber: 'AB-123-CD' }), purchase_date: null };
    expect(missingRequiredFields(row).map((m) => m.key)).toEqual(['acquisitionDate']);
    const rempli = { ...row, purchase_date: '2020-01-02' };
    expect(missingRequiredFields(rempli).map((m) => m.key)).toEqual([]);
  });
});

describe('T2-05 — fournisseurs dédoublonnés', () => {
  it('fiche + documents liés + nom normalisé ; non enregistré à part ; interventions comptées', () => {
    const list = dedupeSuppliers({
      structured: [{ id: 1, name: 'Garage Martin SARL', normalizedName: null, city: 'Lyon', equipmentCount: 1 }],
      documents: [
        { fileId: 10, supplierText: 'Garage Martin', supplierId: null, typeCode: 'MAINTENANCE_INVOICE', date: '2025-03-01' },
        { fileId: 11, supplierText: null, supplierId: 1, typeCode: 'FACTURE', date: '2025-05-01' },
        { fileId: 12, supplierText: 'EDF', supplierId: null, typeCode: null, date: null },
        { fileId: 13, supplierText: 'E.D.F', supplierId: null, typeCode: null, date: '2024-01-01' },
      ],
    });
    const martin = list.find((e) => e.supplierId === 1)!;
    expect(martin).toMatchObject({ documentCount: 2, interventionCount: 1, equipmentCount: 1, lastDocumentDate: '2025-05-01' });
    expect(martin.origins).toEqual(['structured', 'document', 'intervention']);
    const edf = list.filter((e) => e.supplierId === null);
    expect(edf.length).toBeGreaterThanOrEqual(1);
    expect(list.filter((e) => e.supplierId === 1)).toHaveLength(1);
  });
});

describe('T2-06 — règles d’offre', () => {
  const d: ProductRuleData = {
    plan: 'trial', status: 'trialing', quotas: { maxAssets: 2, maxDocuments: 30, maxUsers: 1 }, premiumFeatures: true,
    canWrite: true, isRestricted: false, trial: { status: 'active', endsAt: '2026-10-05T00:00:00Z', daysRemaining: 5 },
    usage: { assets: 2, documents: 12, users: 1 },
  };
  it('offre, quotas (limite atteinte), fonctions, essai', () => {
    const s = productRuleSources(d);
    expect(s.map((x) => x.id)).toEqual(['product_rule:plan', 'product_rule:quota_assets', 'product_rule:quota_documents', 'product_rule:quota_users', 'product_rule:premium_features', 'product_rule:trial']);
    expect(s.every((x) => x.type === 'product_rule')).toBe(true);
    expect(s[1].content).toContain('limite atteinte');
    expect(s[5].content).toContain('5 jours restants');
  });
  it('compte restreint, sans offre', () => {
    const s = productRuleSources({ ...d, plan: 'none', isRestricted: true, premiumFeatures: false, trial: { status: 'expired', endsAt: '2026-09-01T00:00:00Z', daysRemaining: null } });
    expect(s[0].content).toContain('mode restreint');
    expect(s.some((x) => x.id === 'product_rule:quota_assets')).toBe(false);
  });
});

describe('T2-11 — contenu de synthèse borné', () => {
  it('extrait autour du terme, borné', () => {
    const t = `${'a '.repeat(400)} la garantie couvre 5 ans ${'b '.repeat(400)}`;
    const e = boundedExcerpt(t, ['garantie'], 120)!;
    expect(e.length).toBeLessThanOrEqual(122);
    expect(e).toContain('garantie');
    expect(boundedExcerpt('court', [], 100)).toBe('court');
  });
  it('contenu structuré : type, date, montant, fournisseur, biens, faits, extrait', () => {
    const c = synthesisSourceContent({
      fileId: 1, title: 'Garantie', documentDate: '2025-01-01', documentTypeCode: 'WARRANTY_CERTIFICATE', documentTypeLabel: 'Certificat de garantie',
      catalogCode: 'CERTIFICAT_GARANTIE', rubricCode: null, rubricLabel: null, amountCents: 12000, supplier: 'Darty', analysisStatus: 'ANALYZED',
      assets: [{ assetId: 1, name: 'Chaudière', role: 'PRIMARY', origin: 'USER' }],
      facts: [{ id: 1, key: 'warrantyEndDate', canonicalKey: 'warrantyEndDate', label: 'Fin de garantie', value: '2030-01-01', unit: null, confidence: 'certain', excerpt: null }],
    }, 'couvre 5 ans', 10);
    expect(c).toContain('Certificat de garantie');
    expect(c).toContain('fournisseur Darty');
    expect(c).toContain('- Fin de garantie : 2030-01-01');
    expect(c).toContain('Extrait : couvre 5 ans');
  });
});

describe('détection des questions', () => {
  it('champ lisible désigné, question de lecture (pas une commande)', () => {
    expect(findReadableField('Quel est le kilométrage de la Clio ?')?.def.key).toBe('mileage');
    expect(findReadableField('Quelle est l’immatriculation de ma voiture ?')?.def.key).toBe('registrationNumber');
    expect(findReadableField('Quand ai-je acheté la maison ?')).toBeNull();
    expect(findReadableField('Quelle est la date d’achat de la maison ?')?.def.key).toBe('acquisitionDate');
    expect(isFieldQuestion('Quel est le kilométrage de la Clio ?')).toBe(true);
    expect(isFieldQuestion('mets le kilométrage de la Clio à 45 000 km')).toBe(false);
    expect(isFieldQuestion('combien de documents pour la Clio ?')).toBe(false);
  });
  it('échéances à venir, fenêtre', () => {
    expect(upcomingAgendaRequest('Quelles échéances arrivent bientôt ?')).toEqual({ windowDays: 30 });
    expect(upcomingAgendaRequest('mes échéances des 3 prochains mois')).toEqual({ windowDays: 93 });
    expect(upcomingAgendaRequest('mes rendez-vous de cette semaine à venir')).toEqual({ windowDays: 7 });
    expect(upcomingAgendaRequest('quelle est ma prochaine échéance ?')).toBeNull();
  });
});

describe('T2-40 — valeur inchangée depuis la confirmation', () => {
  it('égale à la valeur canonique, ou à celle du lecteur historique (transition)', () => {
    expect(unchangedSinceConfirmation('2021-05-25', '2021-05-25', null)).toBe(true);
    expect(unchangedSinceConfirmation(null, null, '')).toBe(true);
    expect(unchangedSinceConfirmation('A', 'B', 'A')).toBe(true);
    expect(unchangedSinceConfirmation('A', 'B', 'C')).toBe(false);
  });
});
