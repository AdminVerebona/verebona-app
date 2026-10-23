/**
 * Lot 48 (O10) — ACC-021 : « Les 200 cas C29 sont automatisés ou couverts
 * par recette tracée selon pertinence » — matrice de traçabilité
 * EXÉCUTABLE (C32), étendue aux 22 critères C31, aux 26 invariants C34 et
 * aux 60 invariants B33.
 *
 * ÉCHOUE dès qu'un cas du périmètre n'est couvert ni par un test existant
 * (identifiant présent dans chaque fichier de test cité) ni par une
 * procédure de recette préprod explicite, ou n'a pas de décision PO (hors
 * périmètre) ou d'écart tracé ; et dès que le rendu Markdown est périmé.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MATRIX_JSON_PATH, MATRIX_MD_PATH, checkMatrix, expectedIds, renderMatrixMarkdown, summarizeMatrix, type MatrixDocument,
} from '../operations-v1-matrix';

const ROOT = process.cwd();
const fs = { exists: (p: string) => existsSync(join(ROOT, p)), read: (p: string) => readFileSync(join(ROOT, p), 'utf8') };
const doc = JSON.parse(fs.read(MATRIX_JSON_PATH)) as MatrixDocument;

describe('ACC-021 / C32 — matrice de traçabilité exécutable', () => {
  it('ACC-021 — complète : 200 cas C29 + 22 ACC + 26 INV-FINAL + 60 B33, chacun automatisé, en recette préprod tracée, hors périmètre décidé ou écart tracé', () => {
    expect(doc.items.map((i) => i.id)).toEqual(expectedIds());
    expect(checkMatrix(doc, fs)).toEqual([]);
  });

  it('ACC-021 — aucun cas « non couvert » ; hors périmètre limité aux décisions PO (Q1 TCO ; lot 83D : V-Q1 bloc Sinistres, V-Q2 ancien modèle) ; écarts avec proposition', () => {
    const s = summarizeMatrix(doc);
    expect(s.byStatus.NON_COUVERT).toBe(0);
    for (const i of doc.items.filter((x) => x.statut === 'HORS_PERIMETRE')) expect(i.decision, i.id).toMatch(/^(Q1|V-Q1|V-Q2) —/);
    for (const e of doc.ecarts) expect(e.proposition.length, e.id).toBeGreaterThan(20);
  });

  it('ACC-021 — le contrôle détecte réellement un trou (identifiant retiré d’un test, statut non couvert, via non automatisé, procédure inconnue)', () => {
    const copie = JSON.parse(JSON.stringify(doc)) as MatrixDocument;
    const f1 = copie.items.find((i) => i.id === 'F-001')!;
    const autre = { exists: fs.exists, read: (p: string) => (p === f1.tests[0] ? fs.read(p).replace(/\bF-001\b/g, 'F-xxx') : fs.read(p)) };
    expect(checkMatrix(copie, autre)).toEqual([`F-001 : identifiant absent du fichier de test ${f1.tests[0]}`]);
    copie.items.find((i) => i.id === 'F-002')!.statut = 'NON_COUVERT';
    const viaItem = copie.items.find((i) => i.via?.length)!;
    copie.items.find((i) => i.id === viaItem.via![0])!.statut = 'HORS_PERIMETRE';
    copie.items.find((i) => i.preprod)!.preprod = 'RP-99';
    const pb = checkMatrix(copie, fs);
    expect(pb).toEqual(expect.arrayContaining([
      'F-002 : non couvert (ni test, ni recette préprod, ni décision)',
      `${viaItem.id} : via ${viaItem.via![0]} non automatisé`,
    ]));
    expect(pb.some((p) => p.includes('RP-99'))).toBe(true);
    const sansCas = { ...copie, items: copie.items.filter((i) => i.id !== 'F-200') };
    expect(checkMatrix(sansCas, fs)[0]).toBe('identifiants absents de la matrice : F-200');
  });

  it('ACC-021 — le rendu Markdown versionné est à jour (npm run recette:matrice)', () => {
    expect(fs.read(MATRIX_MD_PATH)).toBe(renderMatrixMarkdown(doc));
  });

  it('C34 / C31 — chaque invariant final et chaque critère global a une couverture explicite (test, via, préprod ou décision)', () => {
    for (const i of doc.items.filter((x) => x.famille !== 'C29')) {
      expect(i.tests.length + (i.via?.length ?? 0) + (i.decision ? 1 : 0), i.id).toBeGreaterThan(0);
    }
  });
});
