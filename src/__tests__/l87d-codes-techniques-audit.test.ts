/**
 * Lot 87D — ticket PO « Supprimer type en anglais / technique sur les
 * documents » (capture : pastille « BUILDING_PERMIT » dans l'en-tête du tiroir
 * document).
 *
 * Cause de la capture : l'en-tête du tiroir affichait `getTypeLabel(document_type)`,
 * qui se repliait sur le CODE BRUT quand la colonne V1 portait un code inconnu
 * de la liste V1 (« BUILDING_PERMIT », code V2 recopié). Le 86E a branché le
 * tiroir sur `documentTypeDisplayLabel` ; d'autres vues gardaient le même
 * repli « libellé ?? code ». La règle est désormais unique
 * (`src/lib/referential/user-facing-labels.ts`) : libellé français du Type V2
 * enregistré, sinon masqué (ou « Type à compléter » dans la pastille).
 *
 * Ce fichier ÉCHOUE si un code technique de document redevient visible :
 *   1. audit STATIQUE des vues utilisateur (desktop ET mobile : mêmes
 *      composants responsives ; services qui produisent les libellés de la
 *      recherche, de la Timeline / Agenda, des cartes « À traiter », de
 *      l'accueil / mascotte, de l'assistant, des exports, des notifications et
 *      e-mails) — aucun repli « libellé ?? code » ;
 *   2. RENDU de la pastille du tiroir (composant réel) ;
 *   3. sorties des fonctions de libellé partagées (référentiel complet).
 *
 * Exceptions motivées (le BO peut garder les codes) : `src/app/admin`,
 * `src/app/api/admin`, `src/components/admin`, `src/services/admin`
 * (back-office) ; `src/app/api/cron` (routes de diagnostic protégées par
 * CRON_SECRET, jamais montrées à l'utilisateur) ; journaux techniques
 * (`console.*`), SQL et clés internes (non rendus).
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  containsTechnicalCode, documentTypeLabelOrNull, rubricLabelOrNull, userFacingLabel,
} from '@/lib/referential/user-facing-labels';
import { DOCUMENT_TYPES, RUBRICS, documentTypeDisplayLabel, MISSING_TYPE_LABEL } from '@/lib/referential/v2';
import { documentCodeLabel } from '@/lib/referential/document-codes';
import { documentSearchSublabel } from '@/services/search/global-search.service';
import { documentTypeLabel as conflictSourceLabel, fieldLabel as conflictFieldLabel } from '@/services/ai/reconciliation/to-process-conflicts';

(globalThis as { React?: typeof React }).React = React;
const { DocumentTypeBadge, documentTypeBadgeLabel } = await import('@/components/documents/DocumentTypeBadge');

const ROOT = join(process.cwd(), 'src');
const EXCEPTIONS = [
  /^app\/admin\//, /^app\/api\/admin\//, /^components\/admin\//, /^services\/admin\//, /^app\/api\/cron\//,
  /__tests__\//, /\.test\.tsx?$/, /\.e2e\.ts$/, /^test\//,
];

function fichiers(dir: string): string[] {
  const out: string[] = [];
  for (const nom of readdirSync(dir)) {
    const p = join(dir, nom);
    if (statSync(p).isDirectory()) out.push(...fichiers(p));
    else if (/\.(ts|tsx)$/.test(nom)) out.push(p);
  }
  return out;
}
const SOURCES = fichiers(ROOT)
  .map((p) => ({ rel: relative(ROOT, p).split('\\').join('/'), p }))
  .filter(({ rel }) => !EXCEPTIONS.some((r) => r.test(rel)));

/** Champs qui portent un code documentaire (Type V1 / V2, Rubrique, nature, fonction). */
const CODE = '(documentType|documentTypeCode|rubricCode|catalogCode|retainedFunctionCode|document_type|document_type_code|rubric_code)';
const REGLES: Array<{ id: string; motif: RegExp; pourquoi: string }> = [
  {
    id: 'REFERENTIEL_REPLI_CODE',
    motif: /get(?:DocumentType|Rubric)\([^()]*\)\?\.label\s*\?\?\s*(?!null\b|undefined\b|['"`]|MISSING)[\w.]+/,
    pourquoi: 'libellé du référentiel avec repli sur le code (« getDocumentType(c)?.label ?? c »)',
  },
  {
    id: 'LISTE_REPLI_CODE',
    motif: /\b[A-Z_]*(?:DOC|DOCUMENT|RUBRIC)[A-Z_]*_LABELS\[([^\]]+)\]\s*\?\?\s*(?!null\b|undefined\b|['"`])[\w.]+/,
    pourquoi: 'liste locale de libellés documentaires avec repli sur une valeur brute',
  },
  {
    id: 'LIBELLE_REPLI_CHAMP_CODE',
    motif: new RegExp(`(?:[lL]abel\\b|\\.label|_LABELS\\[[^\\]]*\\])\\s*\\?\\?\\s*[\\w.?]*\\.${CODE}\\b`),
    pourquoi: 'libellé avec repli sur un champ de code documentaire',
  },
  {
    id: 'JSX_CODE_BRUT',
    motif: new RegExp(`>\\s*\\{\\s*[\\w.?]+\\.${CODE}\\s*\\}\\s*<`),
    pourquoi: 'code documentaire rendu tel quel dans le JSX',
  },
];

describe('L87D-U-CODES — audit statique des vues utilisateur : aucun repli sur un code documentaire', () => {
  it('le périmètre audité couvre les vues du ticket (tiroirs, Mes documents, recherche, Agenda / Timeline, À traiter, accueil / mascotte, assistant, exports, notifications, e-mails)', () => {
    const rels = new Set(SOURCES.map((s) => s.rel));
    for (const f of [
      'components/assets/DocumentDrawer.tsx', 'components/assets/EquipmentDrawer.tsx', 'components/documents/v2/DocumentsByRubric.tsx',
      'services/search/global-search.service.ts', 'components/agenda/AgendaItemDrawer.tsx', 'components/assets/timeline/AssetTimeline.tsx',
      'services/to-process/operation-cards.ts', 'services/home/HomeSummaryService.ts', 'services/home/mascot/collector.ts',
      'services/verebona-assistant/core/target-answer.ts', 'services/exports/v12/data/documents.ts', 'services/documents/upload-notification.service.ts',
    ]) expect(rels.has(f), f).toBe(true);
    expect(SOURCES.some((s) => s.rel.startsWith('lib/email/'))).toBe(true);
    expect(SOURCES.some((s) => s.rel.startsWith('components/mobile/'))).toBe(true);
  });

  it('aucune règle violée (hors BO et routes de diagnostic, exceptions motivées en tête de fichier)', () => {
    const violations: string[] = [];
    for (const { rel, p } of SOURCES) {
      readFileSync(p, 'utf8').split('\n').forEach((ligne, i) => {
        if (/^\s*(\*|\/\/)/.test(ligne) || /console\.(info|warn|error|log)/.test(ligne)) return;
        for (const r of REGLES) if (r.motif.test(ligne)) violations.push(`${rel}:${i + 1} [${r.id}] ${r.pourquoi} — ${ligne.trim().slice(0, 140)}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('les règles détectent bien les formes interdites (garde-fou de l’audit lui-même)', () => {
    const exemples = [
      'const typeLabel = getDocumentType(code)?.label ?? code;',
      'meta: [DOCUMENT_TYPE_LABELS[f.documentType ?? ""] ?? f.documentType]',
      'const lib = d.documentTypeLabel ?? d.catalogCode;',
      '<span>{doc.documentType}</span>',
    ];
    for (const e of exemples) expect(REGLES.some((r) => r.motif.test(e)), e).toBe(true);
    for (const ok of ['getDocumentType(c)?.label ?? null', "getRubric(c)?.label ?? 'Sans rubrique'", 'documentTypeLabelOrNull(d.documentTypeCode)']) {
      expect(REGLES.some((r) => r.motif.test(ok)), ok).toBe(false);
    }
  });

  it('tiroir document (desktop ET mobile : même composant) : plus de pastille de type (lot 89B), plus aucun libellé de type local', () => {
    const src = readFileSync(join(ROOT, 'components/assets/DocumentDrawer.tsx'), 'utf8');
    // Lot 89B (demande PO 25/10) : pastille retirée de l'en-tête ; le Type reste dans « Informations ».
    expect(src).not.toMatch(/<DocumentTypeBadge/);
    expect(src).not.toMatch(/getTypeLabel\(|DOCUMENT_TYPE_LABELS/);
  });
});

describe('L87D-U-BADGE — rendu de la pastille du Type (en-tête du tiroir)', () => {
  const rendre = (typeCode: string | null | undefined) => renderToStaticMarkup(h(DocumentTypeBadge, { typeCode }));

  it('cas de la capture : « BUILDING_PERMIT » → libellé français du référentiel, jamais le code', () => {
    const html = rendre('BUILDING_PERMIT');
    expect(html).toContain(documentTypeDisplayLabel('BUILDING_PERMIT'));
    expect(html).not.toContain('BUILDING_PERMIT');
    expect(html).not.toMatch(/[A-Z]{2,}_[A-Z]{2,}/);
  });
  it('code inconnu (V1 « PERMIS_CONSTRUIRE », anglais « XYZ_UNKNOWN ») → « Type à compléter », jamais le code', () => {
    for (const code of ['PERMIS_CONSTRUIRE', 'XYZ_UNKNOWN', 'building_permit']) {
      const html = rendre(code);
      expect(html).toContain(MISSING_TYPE_LABEL);
      expect(html).not.toContain(code);
    }
  });
  it('Type absent → « Type à compléter » ; document non chargé (undefined) → aucune pastille', () => {
    expect(rendre(null)).toContain(MISSING_TYPE_LABEL);
    expect(rendre(undefined)).toBe('');
    expect(documentTypeBadgeLabel(undefined)).toBeNull();
  });
});

describe('L87D-U-LABELS — fonctions de libellé partagées : jamais un code', () => {
  it('tout le référentiel V2 (Types et Rubriques) a un libellé français sans code technique', () => {
    for (const t of DOCUMENT_TYPES) {
      expect(containsTechnicalCode(t.label), `${t.code} → ${t.label}`).toBe(false);
      expect(documentTypeDisplayLabel(t.code)).toBe(t.label);
      expect(documentTypeLabelOrNull(t.code)).toBe(t.label);
    }
    for (const r of RUBRICS) {
      expect(containsTechnicalCode(r.label), `${r.code} → ${r.label}`).toBe(false);
      expect(rubricLabelOrNull(r.code)).toBe(r.label);
    }
  });
  it('code inconnu : masqué (null / chaîne vide), jamais rendu', () => {
    expect(documentTypeLabelOrNull('XYZ_INCONNU')).toBeNull();
    expect(rubricLabelOrNull('XYZ_INCONNU')).toBeNull();
    expect(documentCodeLabel('XYZ_INCONNU')).toBe('');
    expect(documentTypeDisplayLabel('XYZ_INCONNU')).toBe(MISSING_TYPE_LABEL);
  });
  it('containsTechnicalCode : codes détectés ; sigles et références métier (n° de facture) non', () => {
    for (const c of ['BUILDING_PERMIT', 'PERMIS_CONSTRUIRE', 'Type : DATA_CONTRACT_END', 'DOC-INTERVENTION', 'COH-DOC-CLASSIFICATION:X']) expect(containsTechnicalCode(c), c).toBe(true);
    for (const c of ['DPE', 'Facture EDF — Février 2026', 'Facture n° FA-2026-03', 'Permis de construire', '']) expect(containsTechnicalCode(c), c).toBe(false);
    expect(userFacingLabel('BUILDING_PERMIT')).toBeNull();
    expect(userFacingLabel('BUILDING_PERMIT', 'Document')).toBe('Document');
    expect(userFacingLabel('Permis de construire')).toBe('Permis de construire');
  });
  it('recherche globale : sous-titre d’un document = bien, sinon libellé du Type V2 ; jamais un code', () => {
    expect(documentSearchSublabel({ assetName: 'Maison', documentTypeCode: 'BUILDING_PERMIT' })).toBe('Maison');
    expect(documentSearchSublabel({ assetName: null, documentTypeCode: 'BUILDING_PERMIT' })).toBe(documentTypeDisplayLabel('BUILDING_PERMIT'));
    expect(documentSearchSublabel({ assetName: null, documentTypeCode: 'XYZ_INCONNU' })).toBeUndefined();
  });
  it('cartes « À traiter » (conflits) : source et champ en libellé français, jamais le code ni la clé', () => {
    expect(conflictSourceLabel('XYZ_INCONNU')).toBe('Document');
    expect(conflictSourceLabel('FACTURE')).toBe('Facture');
    expect(conflictFieldLabel('cleTechniqueInconnue')).toBe('Information');
  });
});
