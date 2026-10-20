/**
 * Lot 74B — interface et liens (tests unitaires, sans base) :
 *   L74B-U01 confirmation : ce qui part / ce qui reste, libellés lisibles ;
 *   L74B-U02 fiche du bien (desktop ET mobile : même page) porte l'action ;
 *   L74B-U03 plus aucun lien produit vers `/mon-compte/partage` (point 5) ;
 *   L74B-U04 BO : libellés Duo Titulaire / Membre et statuts (point 6).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describeMoves, describeStays } from '@/components/assets/MoveToDuoSpaceDialog';
import { duoMembershipLabels, memberRole } from '@/services/admin/user-detail.service';

const ROOT = join(__dirname, '../../../..');
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('L74B-U01 — confirmation : ce qui part, ce qui reste', () => {
  it('liste les éléments non nuls, au singulier comme au pluriel', () => {
    expect(describeMoves({
      documents: [], equipments: 1, rooms: 2, agendaItems: 0, events: 1, deadlines: 1,
      operations: 1, toProcessActions: 3, suppliersCopied: 1, suppliersReused: 0,
    })).toEqual([
      '1 équipement',
      '2 pièces',
      '2 événements et échéances de l’historique',
      '1 opération (intervention, sinistre…)',
      '3 actions « À traiter »',
      '1 fiche fournisseur recopiée (sans coordonnées bancaires)',
    ]);
    expect(describeStays({
      sharedDocuments: [{ id: 1, title: 'Assurance.pdf' }], sharedAgendaItems: 1, sharedOperations: 0, pendingTransmissionsCancelled: 1,
    })).toEqual([
      'Assurance.pdf (aussi rattaché à un autre bien : son lien avec ce bien est retiré)',
      '1 élément d’agenda partagé avec un autre bien (lien retiré)',
      '1 transmission en attente annulée',
    ]);
  });
});

describe('L74B-U02 — fiche du bien', () => {
  it('l’action est rendue par la fiche (même composant ordinateur / mobile), visible selon le serveur', () => {
    const page = lire('src/app/(dashboard)/assets/[id]/page.tsx');
    expect(page).toContain("import { MoveToDuoSpaceButton } from '@/components/assets/MoveToDuoSpaceDialog'");
    expect(page).toMatch(/<MoveToDuoSpaceButton assetId=\{asset\.id\} assetName=\{asset\.name\} \/>/);
    const dlg = lire('src/components/assets/MoveToDuoSpaceDialog.tsx');
    // Libellé masqué sous md, icône + aria-label sur mobile.
    expect(dlg).toContain('aria-label="Déplacer vers l’espace Duo"');
    expect(dlg).toContain('hidden md:inline');
    // Rendu seulement si le serveur propose une cible.
    expect(dlg).toContain('if (targets.length === 0) return null');
  });
});

function fichiers(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n === '__tests__' || n === 'node_modules' || n === 'e2e') continue;
      fichiers(p, out);
    } else if (/\.(ts|tsx)$/.test(n) && !/\.test\.ts$/.test(n)) out.push(p);
  }
  return out;
}

describe('L74B-U03 — lien mort /mon-compte/partage', () => {
  it('aucun code ne produit plus ce lien (chaîne ou gabarit d’URL)', () => {
    const fautifs = fichiers(join(ROOT, 'src'))
      .filter((f) => /(['"])\/mon-compte\/partage|`\/mon-compte\/partage\?|\/mon-compte\/partage\?inviteToken=\$\{/.test(readFileSync(f, 'utf-8')))
      .map((f) => f.slice(ROOT.length + 1));
    expect(fautifs).toEqual([]);
  });
  it('un ancien lien ouvre « Mon compte »', () => {
    expect(lire('src/app/(dashboard)/mon-compte/partage/page.tsx')).toContain("redirect('/mon-compte')");
  });
});

describe('L74B-U04 — BO : Duo Titulaire / Membre', () => {
  it('libellés de rôle et de statut', () => {
    expect(duoMembershipLabels('owner', 'active', 'ACTIVE')).toEqual({ roleLabel: 'Titulaire', statusLabel: 'Actif', duoStatusLabel: 'Abonnement actif' });
    expect(duoMembershipLabels('member', 'left', 'UNPAID_RECOVERY')).toEqual({ roleLabel: 'Membre', statusLabel: 'Parti', duoStatusLabel: 'Impayé (régularisation en cours)' });
    expect(duoMembershipLabels('member', 'removed', null)).toEqual({ roleLabel: 'Membre', statusLabel: 'Retiré', duoStatusLabel: null });
  });
  it('rôle du compte : adhésion seule (plus de « second » hérité d’un autre compte)', () => {
    expect(memberRole({ isAccountOwner: true, membershipRole: 'owner', isDuoSecond: false })).toBe('holder');
    expect(memberRole({ isAccountOwner: false, membershipRole: 'member', isDuoSecond: false })).toBe('second');
    expect(lire('src/app/admin/users/[id]/page.tsx')).toContain("second: 'Membre'");
    expect(lire('src/services/admin/user-detail.service.ts')).not.toMatch(/AS duo_second/);
  });
});
