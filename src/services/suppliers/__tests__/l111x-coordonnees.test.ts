/**
 * Lot 111X — coordonnées des fournisseurs (unitaires, purs).
 *
 * L111X-U-READ      lecture par format (e-mail, téléphone, fax écarté, TVA à clé, IBAN à clé, site, adresse) ;
 * L111X-U-DECIDE    décision par champ sur une copie SYNTHÉTIQUE du devis Raynard : émetteur ≠ destinataire,
 *                   UNCERTAIN seule ≠ preuve, contradiction = abstention, aucun site ni IBAN inventé ;
 * L111X-U-PLAN      plan par champ (remplir, conflit, effacement volontaire respecté) ;
 * L111X-U-PATCH     décisions de l'utilisateur par champ (seule une valeur qui CHANGE est une décision) ;
 * L111X-U-AI        constats IA validés (monde fermé, valeur recopiée, format) ;
 * L111X-U-COVERAGE  T1 : unité « couverte » par un seul champ → non résolue (AC11).
 */
import { describe, expect, it } from 'vitest';
import {
  anchoredToSupplier, compactPhone, ibanValid, markedAsRecipient, parseFrVat, readContactValues, readPostalAddresses,
} from '../supplier-contact-reading';
import { userFieldDecisionsAfterPatch } from '../supplier-service';
import { decideSupplierCoordinates, supplierContextFingerprint } from '@/services/ai/reconciliation/missing-properties/supplier';
import { planSupplierFields, validateSupplierFindings } from '@/services/ai/reconciliation/missing-properties/supplier-service';
import type { SupplierKnowledgeItem, SupplierRow } from '@/services/ai/reconciliation/missing-properties/collect';
import { computeCoverage, unstructuredContactValues } from '@/services/ai/source-analysis/source-units/coverage';
import type { SourceUnit } from '@/services/ai/source-analysis/source-units/types';

const RAYNARD: SupplierRow = {
  id: 7, accountId: 1, status: 'active', source: 'document_extraction', name: 'RAYNARD TRAITEMENT DU BOIS',
  siren: '832724322', siret: '83272432200017', email: null, phone: null, website: null, addressLine1: null, postalCode: null,
  city: null, country: null, vatNumber: null, iban: null, userFieldDecisions: {},
};
const item = (ref: string, text: string, o: Partial<SupplierKnowledgeItem> = {}): SupplierKnowledgeItem => ({
  ref, fileId: 380, layer: 'SOURCE_UNIT', sourceId: Number(ref.replace(/\D/g, '')) || 1, unitId: ref, page: 1, kind: 'TEXT_BLOCK', label: null,
  text, coverage: 'COVERED', confidence: 'certain', extractionId: 286, ...o,
});
const destinataire = { names: ['Martin'], emails: ['client@example.org'], addresses: [{ postalCode: '69005', line: 'quai Fulchiron' }] };
/** Copie SYNTHÉTIQUE du devis (aucune donnée réelle du compte 13). */
const devis = (): SupplierKnowledgeItem[] => [
  item('F-3421', '04 78 44 65 25', { layer: 'FACT', kind: 'supplierPhone', coverage: null, targetEntityId: null, targetLabel: 'RAYNARD TRAITEMENT DU BOIS' }),
  item('U-1', 'RAYNARD TRAITEMENT DU BOIS\n32 rue du Vorlat\n69290 Saint-Genis-les-Ollières', { unitId: 'page:1:block:1' }),
  item('U-3', 'Email : raynard-bois@orange.fr  TVA : FR58832724322', { unitId: 'page:1:field:3', kind: 'FORM_FIELD' }),
  item('U-4', 'SIRET 832 724 322 00017', { unitId: 'page:1:field:4', kind: 'FORM_FIELD' }),
  item('U-5', 'Client : M. Martin\n12 quai Fulchiron\n69005 Lyon', { unitId: 'page:1:block:2' }),
  item('U-6', 'Devis n° 261104488 du 03/11/2026 — Total TTC 1 980,00 €', { unitId: 'page:1:block:3' }),
];
const champ = (f: ReturnType<typeof decideSupplierCoordinates>, k: string) => f.find((x) => x.field === k)!;

describe('L111X-U-READ — lecture par format', () => {
  it('e-mail, téléphone (forme compacte), TVA à clé vérifiée, fax écarté, IBAN à clé, site explicite', () => {
    const v = readContactValues('Tél : 04 78 44 65 25 — Fax : 04 78 44 65 26 — Email : raynard-bois@orange.fr — TVA : FR58832724322 — www.exemple-bois.fr');
    expect(v.filter((x) => !x.excluded).map((x) => [x.field, x.value])).toEqual([
      ['email', 'raynard-bois@orange.fr'], ['phone', '0478446525'], ['vatNumber', 'FR58832724322'], ['website', 'www.exemple-bois.fr'],
    ]);
    expect(v.find((x) => x.value === '0478446526')?.excluded).toBe('FAX');
    expect(parseFrVat('FR 59 832724322')?.valid).toBe(false);
    expect(parseFrVat('FR58832724322')).toEqual({ value: 'FR58832724322', siren: '832724322', valid: true });
    expect(ibanValid('FR7630006000011234567890189')).toBe(true);
    expect(ibanValid('FR7630006000011234567890188')).toBe(false);
    expect(compactPhone('+33 4 78 44 65 25')).toBe('+33478446525');
    // Domaine d'un e-mail : jamais un site.
    expect(readContactValues('contact : raynard-bois@orange.fr').some((x) => x.field === 'website')).toBe(false);
  });
  it('adresse postale « voie, code postal, ville » ; une adresse par unité', () => {
    expect(readPostalAddresses('RAYNARD\n32 rue du Vorlat\n69290 Saint-Genis-les-Ollières')).toEqual([
      { addressLine1: '32 rue du Vorlat', postalCode: '69290', city: 'Saint-Genis-les-Ollières', raw: expect.any(String) },
    ]);
    expect(readPostalAddresses('Total 1 980,00 € — 69290')).toEqual([]);
  });
  it('ancre de l’émetteur et marque du destinataire', () => {
    const a = { name: RAYNARD.name, siren: RAYNARD.siren, siret: RAYNARD.siret };
    expect(anchoredToSupplier('Email : x@y.fr TVA : FR58832724322', a)).toBe(true);
    expect(anchoredToSupplier('SIRET 832 724 322 00017', a)).toBe(true);
    expect(anchoredToSupplier('Client : M. Martin', a)).toBe(false);
    expect(markedAsRecipient('Client : M. Martin\n12 quai Fulchiron\n69005 Lyon', destinataire)).toBe(true);
  });
});

describe('L111X-U-DECIDE — devis synthétique Raynard', () => {
  it('AC01 / AC03 / AC04 : téléphone (fait), e-mail et TVA (même unité), adresse de l’émetteur seule ; ni site ni IBAN', () => {
    const f = decideSupplierCoordinates({ supplier: RAYNARD, items: devis(), recipient: destinataire });
    expect(champ(f, 'phone')).toMatchObject({ status: 'ESTABLISHED', value: '0478446525' });
    expect(champ(f, 'email')).toMatchObject({ status: 'ESTABLISHED', value: 'raynard-bois@orange.fr' });
    expect(champ(f, 'vatNumber')).toMatchObject({ status: 'ESTABLISHED', value: 'FR58832724322' });
    expect(champ(f, 'addressLine1')).toMatchObject({ status: 'ESTABLISHED', value: '32 rue du Vorlat' });
    expect(champ(f, 'postalCode')).toMatchObject({ status: 'ESTABLISHED', value: '69290' });
    expect(champ(f, 'city')).toMatchObject({ status: 'ESTABLISHED', value: 'Saint-Genis-les-Ollières' });
    expect(champ(f, 'website').status).toBe('NO_EVIDENCE');
    expect(champ(f, 'iban').status).toBe('NO_EVIDENCE');
    // Jamais l'adresse du client.
    expect(champ(f, 'addressLine1').candidates).not.toContain('12 quai Fulchiron');
    expect(champ(f, 'email').evidence[0]).toMatchObject({ ref: 'U-3', unitId: 'page:1:field:3', extractionId: 286 });
  });
  it('AC08 : UNCERTAIN seule ≠ preuve ; deux valeurs distinctes = abstention ; aucune preuve = rien', () => {
    const incertain = devis().map((i) => (i.ref === 'U-3' ? { ...i, coverage: 'UNCERTAIN', confidence: 'conflictual' as const } : i));
    expect(champ(decideSupplierCoordinates({ supplier: RAYNARD, items: incertain, recipient: destinataire }), 'email').status).toBe('UNCERTAIN_ONLY');
    const deux = [...devis(), item('U-9', 'RAYNARD TRAITEMENT DU BOIS — Email : contact@raynard-bois.fr')];
    expect(champ(decideSupplierCoordinates({ supplier: RAYNARD, items: deux, recipient: destinataire }), 'email')).toMatchObject({ status: 'EVIDENCE_CONFLICT', value: null });
    expect(champ(decideSupplierCoordinates({ supplier: RAYNARD, items: [], recipient: destinataire }), 'phone').status).toBe('NO_EVIDENCE');
  });
  it('unité de l’émetteur qui ANNONCE un champ sans valeur lisible : découpage nécessaire (jamais une valeur inventée)', () => {
    const items = [item('U-7', 'RAYNARD TRAITEMENT DU BOIS — Site web : voir au verso')];
    expect(champ(decideSupplierCoordinates({ supplier: RAYNARD, items, recipient: destinataire }), 'website')).toMatchObject({ status: 'NEEDS_SPLIT', splitRefs: ['U-7'] });
  });
  it('empreinte : stable à l’identique, change avec une preuve ou une décision de l’utilisateur', () => {
    const k = { supplier: RAYNARD, items: devis(), recipient: destinataire };
    expect(supplierContextFingerprint(k)).toBe(supplierContextFingerprint({ ...k, items: [...devis()].reverse() }));
    expect(supplierContextFingerprint(k)).not.toBe(supplierContextFingerprint({ ...k, items: devis().slice(1) }));
    expect(supplierContextFingerprint(k)).not.toBe(supplierContextFingerprint({ ...k, supplier: { ...RAYNARD, userFieldDecisions: { phone: { action: 'CLEARED' } } } }));
  });
});

describe('L111X-U-PLAN — protection par champ, conflits', () => {
  it('AC06 / AC07 : champ vide complété ; effacement volontaire respecté ; valeur différente = conflit ; même valeur = rien', () => {
    const findings = decideSupplierCoordinates({ supplier: RAYNARD, items: devis(), recipient: destinataire });
    const s: SupplierRow = { ...RAYNARD, source: 'manual', email: 'autre@exemple.fr', vatNumber: 'FR 58 832724322', userFieldDecisions: { phone: { action: 'CLEARED' } } };
    const p = Object.fromEntries(planSupplierFields(s, findings).map((x) => [x.field, [x.action, x.cause]]));
    expect(p.phone).toEqual(['ABSTAIN', 'USER_CLEARED']);
    expect(p.email).toEqual(['CONFLICT', 'VALUE_CONFLICT_REVIEW']);
    expect(p.vatNumber).toEqual(['ABSTAIN', 'ALREADY_CONSISTENT']);
    expect(p.addressLine1).toEqual(['FILL', null]);
    expect(p.website).toEqual(['ABSTAIN', 'NO_EVIDENCE']);
  });
});

describe('L111X-U-PATCH — décisions de l’utilisateur', () => {
  it('seule une valeur qui CHANGE est une décision ; vidée → CLEARED ; saisie → SET', () => {
    const at = new Date('2026-11-05T10:00:00Z');
    const d = userFieldDecisionsAfterPatch({ phone: '0478446525', email: null, city: 'Lyon' }, { phone: null, email: null, city: 'Lyon', website: 'www.x.fr', name: 'X' }, {}, 3, at);
    expect(d).toEqual({ phone: { action: 'CLEARED', at: at.toISOString(), userId: 3 }, website: { action: 'SET', at: at.toISOString(), userId: 3 } });
  });
});

describe('L111X-U-AI — constats du découpage T3 validés', () => {
  it('monde fermé, confiance certaine, valeur recopiée, format du champ', () => {
    const items = [item('U-7', 'RAYNARD — Tél. 04-78-44-65-25 (standard)')];
    const out = (findings: unknown[]) => ({ task: 'KNOWLEDGE_QUERY' as const, outcome: 'FOUND' as const, reason: 'x', findings: findings as never });
    const base = { target: 'phone', rawValue: '04-78-44-65-25', evidenceRefs: ['U-7'], excerpt: 'Tél.', confidence: 'certain', meaning: 'téléphone' };
    expect(validateSupplierFindings(out([base]), ['phone'], items).accepted).toEqual([{ field: 'phone', value: '0478446525', refs: ['U-7'] }]);
    expect(validateSupplierFindings(out([{ ...base, rawValue: '04 99 99 99 99' }]), ['phone'], items).rejected[0].reason).toBe('VALUE_NOT_IN_EVIDENCE');
    expect(validateSupplierFindings(out([{ ...base, evidenceRefs: ['U-404'] }]), ['phone'], items).rejected[0].reason).toBe('UNKNOWN_REF');
    expect(validateSupplierFindings(out([{ ...base, confidence: 'probable' }]), ['phone'], items).rejected[0].reason).toBe('NOT_CERTAIN');
    expect(validateSupplierFindings(out([{ ...base, target: 'iban' }]), ['phone'], items).rejected[0].reason).toBe('TARGET_NOT_REQUESTED');
  });
});

describe('L111X-U-COVERAGE — T1 : unité à plusieurs valeurs (AC11)', () => {
  const u = (id: string, text: string, kind: SourceUnit['kind'] = 'FORM_FIELD'): SourceUnit => ({
    sourceUnitId: id, kind, page: 1, ordinal: 1, parentUnitId: null, text, label: null, value: null, payload: {}, location: {}, origin: 'PASS_1', salient: true,
  } as unknown as SourceUnit);
  it('couverte par le seul SIRET (métadonnée) : e-mail et TVA non structurés → non résolue, réparable', () => {
    const units = [u('page:1:field:3', 'SIRET 83272432200017 Email : raynard-bois@orange.fr TVA : FR58832724322')];
    const [c] = computeCoverage(units, { facts: [], metadataUnitIds: new Set(['page:1:field:3']), structuredValues: ['83272432200017'] });
    expect(c).toMatchObject({ status: 'UNRESOLVED', reason: 'values_not_structured' });
    expect(unstructuredContactValues(units[0].text as string, ['83272432200017'])).toEqual(['raynard-bois@orange.fr', 'FR58832724322']);
  });
  it('toutes les valeurs structurées (faits) ou écartées avec motif (fax) : couverte', () => {
    const units = [u('page:1:field:3', 'Email : raynard-bois@orange.fr TVA : FR58832724322 Fax : 04 78 44 65 26')];
    const [c] = computeCoverage(units, {
      facts: [
        { unitIds: ['page:1:field:3'], confidence: 'certain', values: ['raynard-bois@orange.fr'] },
        { unitIds: ['page:1:field:3'], confidence: 'certain', values: ['FR58832724322'] },
      ],
    });
    expect(c).toMatchObject({ status: 'COVERED', reason: 'fact' });
  });
});
