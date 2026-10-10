/**
 * Lot 34E — ticket « Documents : refondre le moteur de titre et assurer la
 * repasse T3 sur l'existant » : critères TITLE2-AC1 à AC8 (règles pures).
 * Chaîne complète sur base réelle : `l34e-titre-v2.e2e.ts`.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_TITLE_RULE_VERSION, evaluateBusinessTitle, shouldReplaceSystemTitle,
} from '@/lib/documents/document-title-rules';
import { formatBusinessPeriod, planBusinessTitle, refineDocumentTitle, titleContextFingerprint } from '@/services/ai/source-analysis/document-title';
import { withPersistedGaps } from '../document-title.service';
import { TITLE_SWEEP_SQL } from '@/services/ai/reconciliation/document-title-sweep';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const fibre = { typeCode: 'FACTURE', subjects: ['fibre'], supplier: 'Orange', documentDate: '2026-09-05' };

describe('TITLE2-AC1 — nouveau document : nature + sujet + discriminants utiles', () => {
  it('Facture + fibre + Orange + septembre 2026 → « Facture fibre Orange _ Septembre 2026 », jamais « Facture fibre internet »', () => {
    expect(planBusinessTitle('Facture fibre internet', fibre).title).toBe('Facture fibre Orange _ Septembre 2026');
    expect(refineDocumentTitle('Facture fibre internet', fibre)).toBe('Facture fibre Orange _ Septembre 2026');
  });
  it('période MÉTIER des faits avant la date documentaire', () => {
    expect(planBusinessTitle('Facture électricité', { typeCode: 'FACTURE', supplier: 'EDF', documentDate: '2026-09-02', period: { start: '2026-08-01', end: '2026-08-31' } }).title)
      .toBe('Facture électricité EDF _ Août 2026');
    expect(formatBusinessPeriod('2026-07-01', '2026-09-30')).toBe('Juillet à septembre 2026');
    expect(formatBusinessPeriod('2025-12-01', '2026-02-28')).toBe('Décembre 2025 à février 2026');
  });
  it('événement ponctuel : date du jour', () => {
    expect(planBusinessTitle('Contrôle technique', { typeCode: 'CONTROLE_TECHNIQUE', documentDate: '2026-09-18', asset: { id: 1, name: 'Polo' }, accountAssetCount: 2 }).title)
      .toBe('Contrôle technique Polo _ 18 septembre 2026');
  });
  it('pas de nomenclature rigide : jamais tous les discriminants', () => {
    const t = planBusinessTitle('Facture fibre', { ...fibre, asset: { id: 1, name: 'Maison' }, accountAssetCount: 3, reference: 'FAC-456' }).title!;
    expect(t).toBe('Facture fibre Orange _ Septembre 2026');
    expect(t).not.toMatch(/FAC-456|Maison|05\/09/);
  });
  it('T1 ne fait pas confiance aveuglément au titre du modèle : données durables complétées (type, sujets…)', () => {
    const r = withPersistedGaps({ modelTitle: 'Facture fibre internet', ctx: { supplier: null } }, { modelTitle: null, ctx: fibre });
    expect(planBusinessTitle(r.modelTitle, r.ctx).title).toBe('Facture fibre Orange _ Septembre 2026');
    expect(src('src/services/ai/source-analysis/pipeline.ts')).toMatch(/ensureBusinessTitle\(\{[\s\S]{0,200}origin: 'T1'/);
  });
});

describe('TITLE2-AC2 — titre valide mais médiocre : évalué améliorable, remplacé', () => {
  const plan = planBusinessTitle('Facture fibre internet', fibre);
  it('evaluateBusinessTitle : valid = true, sufficient = false, raisons explicites', () => {
    const e = evaluateBusinessTitle('Facture fibre internet', plan.expectations);
    expect(e).toMatchObject({ valid: true, sufficient: false, improvable: true });
    expect(e.reasons).toEqual(expect.arrayContaining(['MISSING_SUPPLIER', 'MISSING_PERIOD']));
    expect(evaluateBusinessTitle('5be5a3ca-38cf-47fc-942c-3386ea8e846b.pdf', plan.expectations).reasons).toEqual(['TECHNICAL_TITLE']);
    expect(evaluateBusinessTitle('Facture', plan.expectations).reasons).toContain('GENERIC_TITLE');
  });
  it('shouldReplaceSystemTitle autorise le remplacement (fournisseur ajouté)', () => {
    expect(shouldReplaceSystemTitle('Facture fibre internet', plan.title, plan.expectations)).toEqual({ replace: true, reason: 'SUPPLIER_ADDED' });
  });
});

describe('TITLE2-AC3 / AC4 — nouvelle connaissance T3 (bien, équipement)', () => {
  it('Polo identifiée : « Facture entretien Polo _ Octobre 2026 » (le compte a plusieurs biens)', () => {
    const p = planBusinessTitle('Facture entretien', { typeCode: 'FACTURE', documentDate: '2026-10-03', asset: { id: 1, name: 'Polo' }, accountAssetCount: 2 });
    expect(p.title).toBe('Facture entretien Polo _ Octobre 2026');
    expect(shouldReplaceSystemTitle('Facture entretien _ Octobre 2026', p.title, p.expectations)).toEqual({ replace: true, reason: 'TARGET_ADDED' });
  });
  it('un seul bien dans le compte : le nom du bien n’améliore pas l’identification', () => {
    expect(planBusinessTitle('Facture entretien', { typeCode: 'FACTURE', documentDate: '2026-10-03', asset: { id: 1, name: 'Polo' }, accountAssetCount: 1 }).title)
      .toBe('Facture entretien _ Octobre 2026');
  });
  it('équipement identifié : mots déjà présents non répétés', () => {
    const p = planBusinessTitle('Facture entretien chaudière', { typeCode: 'FACTURE', documentDate: '2026-10-03', equipment: { id: 7, name: 'Chaudière Saunier Duval' } });
    expect(p.title).toBe('Facture entretien chaudière Saunier Duval _ Octobre 2026');
    expect(shouldReplaceSystemTitle('Facture entretien chaudière _ Octobre 2026', p.title, p.expectations)).toEqual({ replace: true, reason: 'EQUIPMENT_ADDED' });
  });
});

describe('TITLE2-AC5 — titre utilisateur : jamais touché (compare-and-set conservé)', () => {
  it('le service lit la source au départ ET la revérifie dans l’écriture', () => {
    const s = src('src/services/documents/document-title.service.ts');
    expect(s).toContain("if (row.title_source === 'USER') return fin('SKIP_USER_TITLE', 'USER_TITLE_PROTECTED'");
    expect(s).toMatch(/AND title_source = 'SYSTEM'\s+AND retained_title IS NOT DISTINCT FROM \$4::text/);
  });
});

describe('TITLE2-AC6 / AC7 — pas de nouvelle connaissance, pas de variation stylistique', () => {
  const p = planBusinessTitle('Facture fibre internet', fibre);
  it('même contexte → même empreinte ; contexte utile modifié → empreinte différente', () => {
    expect(titleContextFingerprint(planBusinessTitle('Facture fibre internet', fibre))).toBe(titleContextFingerprint(p));
    expect(titleContextFingerprint(planBusinessTitle('Facture fibre internet', { ...fibre, supplier: 'SFR' }))).not.toBe(titleContextFingerprint(p));
  });
  it('« Facture fibre Orange _ Septembre 2026 » reste identique ; une reformulation n’est jamais un remplacement', () => {
    expect(shouldReplaceSystemTitle('Facture fibre Orange _ Septembre 2026', p.title, p.expectations)).toEqual({ replace: false, reason: 'NO_BETTER_TITLE' });
    expect(shouldReplaceSystemTitle('Facture fibre Orange _ Septembre 2026', 'Facture Orange fibre _ Septembre 2026', p.expectations).replace).toBe(false);
    expect(shouldReplaceSystemTitle('Facture fibre Orange _ Septembre 2026', 'Facture internet Orange _ Septembre 2026', p.expectations).replace).toBe(false);
    // Un candidat qui perdrait une information n'est jamais retenu.
    expect(shouldReplaceSystemTitle('Facture fibre Orange _ Septembre 2026', 'Facture fibre Orange', p.expectations).replace).toBe(false);
  });
});

describe('titres similaires du compte : discriminant métier, jamais « (2) »', () => {
  it('trois « Contrat d’assurance Polo » → la date les distingue', () => {
    const ctx = { typeCode: 'CONTRAT_ASSURANCE', documentDate: '2026-03-10', subjects: [], equipment: null };
    const seul = planBusinessTitle('Contrat d’assurance Polo', ctx);
    expect(seul.title).toBe('Contrat d’assurance Polo');
    const p = planBusinessTitle('Contrat d’assurance Polo', { ...ctx, similarTitles: ['Contrat d’assurance Polo'] });
    expect(p.title).toBe('Contrat d’assurance Polo _ 10 mars 2026');
    expect(p.duplicateResolved).toBe(true);
    expect(p.title).not.toMatch(/\(2\)/);
  });
});

describe('TITLE2-AC8 — reprise du stock : version des règles', () => {
  it('DOCUMENT_TITLE_RULE_VERSION = 2 ; le balayage reprend tout titre SYSTEM d’une version antérieure, plus seulement les titres techniques', () => {
    expect(DOCUMENT_TITLE_RULE_VERSION).toBe(2);
    const sql = TITLE_SWEEP_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain('f.title_rule_version IS DISTINCT FROM $4::int');
    expect(sql).toContain("f.title_source = 'SYSTEM'");
    expect(sql).not.toMatch(/regexp_replace|unaccent/); // le préfiltre technique n'est plus le critère d'éligibilité
    // Contexte du titre modifié (rattachement, cible renommée, nouvelle analyse) → réévaluable.
    expect(sql).toContain('l.updated_at > f.title_checked_at');
    expect(sql).toContain('a.updated_at > f.title_checked_at');
  });
  it('migration 0293 : colonnes de suivi et journal étendu, idempotente', () => {
    const m = src('src/db/migrations/0293_document_title_context.sql');
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS title_rule_version INTEGER/);
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS title_context_fingerprint TEXT/);
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS context_fingerprint TEXT/);
    expect(m).toMatch(/'NO_CHANGE', 'SKIP_USER_TITLE', 'INSUFFICIENT_DATA'/);
    expect(m).not.toMatch(/CONCURRENTLY/);
  });
});

describe('TITLE2 — déclenchement événementiel par l’orchestration T3 existante (pas de second système)', () => {
  it('rattachement DOCUMENT_ASSET, fait → équipement, réconciliation compte : contrôle ciblé du titre (origine T3)', () => {
    expect(src('src/services/ai/reconciliation/document-asset/resolve-document-asset.service.ts')).toMatch(/await refreshDocumentTitle\(p\.accountId, p\.fileId\)/);
    expect(src('src/services/ai/reconciliation/continuous/fact-target-reconciler.ts')).toMatch(/refreshDocumentTitle\(p\.accountId, fileId\)/);
    expect(src('src/services/ai/reconciliation/continuous/open-knowledge.service.ts')).toMatch(/sweepDocumentTitles\(\{ accountId, limit: OPEN_KNOWLEDGE_TITLE_LIMIT/);
  });
});

