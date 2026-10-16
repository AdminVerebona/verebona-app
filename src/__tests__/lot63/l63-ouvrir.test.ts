/**
 * Lot 63 — décision PO du 16/10 (point 3) : la carte « À traiter » de la
 * mascotte d'accueil affichait encore « Compléter » ; elle affiche « Ouvrir »,
 * comme le bouton de la carte de la page « À traiter » (lot 59, L59-4).
 * Desktop et mobile : un seul composant (`MascotSpeaks` › `ItemButton`), qui
 * affiche l'appel à l'action calculé par le serveur (`todo-items`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ToProcessActionView } from '@/services/to-process/to-process-query.service';
import { TODO_OPEN_CTA, todoItemFrom } from '@/services/home/mascot/todo-items';
import { todoHomeItem } from '@/services/home/mascot/bubble';
import { MICROCOPY } from '@/lib/referential/v2/microcopy';

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

const vue = (over: Partial<ToProcessActionView> = {}): ToProcessActionView => ({
  publicId: '00000001-aaaa-bbbb-cccc-dddddddddddd', targetType: 'DOCUMENT', targetId: 101, fieldKey: 'contractEndDate', relationKey: null,
  actionKind: 'COMPLETE', priority: 'DO_FIRST', ruleCode: 'DATA-CONTRACT-END',
  question: 'Quelle est la date de fin de ce contrat ?', proposals: [], allowNotApplicable: false,
  activeSince: '2026-10-01T10:00:00Z', inputType: 'date',
  target: { label: 'Contrat d’assurance habitation', publicId: 'doc-1', assetId: 1, assetName: 'Maison' },
  ...over,
});

describe('L63-OUVRIR — « Ouvrir » remplace « Compléter » sur la carte « À traiter » de l’accueil', () => {
  it('L63-OUVRIR-01 — saisie (COMPLETE) : « Ouvrir », même microcopie que la page « À traiter »', () => {
    expect(TODO_OPEN_CTA).toBe('Ouvrir');
    expect(TODO_OPEN_CTA).toBe(MICROCOPY.open);
    const item = todoItemFrom(vue());
    expect(item).toMatchObject({ actionType: 'OPEN_TODO_CARD', cta: 'Ouvrir', title: 'Date de fin de contrat à compléter' });
    // L'élément affiché par la bulle (desktop et mobile) porte ce libellé.
    expect(todoHomeItem(item).cta).toBe('Ouvrir');
  });

  it('L63-OUVRIR-02 — aucune action de la file ne produit plus « Compléter » ; les autres libellés sont inchangés', () => {
    const cas: Array<[Partial<ToProcessActionView>, string]> = [
      [{}, 'Ouvrir'],
      [{ inputType: undefined, ruleCode: 'DOC-TYP', fieldKey: 'documentTypeCode' }, 'Ouvrir'],
      [{ actionKind: 'ARBITRATE', proposals: [{ value: '2027-01-01', label: '01/01/2027', confidence: 0.6 }] }, 'Vérifier'],
      [{ actionKind: 'ARBITRATE', proposals: [{ value: 'a', label: 'a', confidence: 0.6 }, { value: 'b', label: 'b', confidence: 0.5 }] }, 'Vérifier'],
      [{ actionKind: 'ARBITRATE', ruleCode: 'LINK-ASSET', fieldKey: null, relationKey: 'assetIds',
        proposals: [{ value: 3, label: 'Cupra', confidence: 0.6 }, { value: 4, label: 'Clio', confidence: 0.5 }] }, 'Choisir le bien'],
    ];
    for (const [over, attendu] of cas) {
      const it = todoItemFrom(vue(over));
      expect(it.cta).toBe(attendu);
      expect(it.cta).not.toBe('Compléter');
    }
  });

  it('L63-OUVRIR-03 — un seul composant desktop / mobile affiche l’appel à l’action du serveur, sans libellé propre', () => {
    const src = lire('src/components/home/MascotSpeaks.tsx');
    expect(src).toMatch(/cta=\{it\.cta\}/);
    // Le composant n'écrit jamais « Compléter » en dur (seul un commentaire historique le cite).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('Compléter');
    // Aucune variante mobile distincte de l'élément : mêmes classes responsives (md:).
    expect(src).toMatch(/function ItemButton/);
    expect((src.match(/function ItemButton/g) ?? []).length).toBe(1);
  });
});
