/**
 * Garde d'écriture — CDC 1 §8.3, §9.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE BON DISCOURS AU BON MOMENT
 *
 * La fenêtre de refus vivait dans `assets/page.tsx`, avec un corps figé :
 * « Passez à Premium pour gérer jusqu'à 10 biens et 150 documents ».
 *
 * C'est juste pour un abonné Standard qui bute sur son quota. Pas pour un
 * essai terminé : cette personne n'a AUCUNE offre, et lui proposer une montée
 * en gamme lui fait sauter l'étape du choix.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const sansCommentaires = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '')
   .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
   .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const DIALOGUE = read('src/components/premium/WriteBlockedDialog.tsx');
const CONTEXTE = read('src/contexts/WriteGuardContext.tsx');

describe('deux discours selon la situation', () => {
  it('un essai terminé invite à choisir, pas à monter en gamme', () => {
    expect(DIALOGUE).toContain("Choisissez l&apos;offre qui vous convient");
    // Même libellé que le bandeau de fin d'essai.
    expect(DIALOGUE).toContain('Choisir une offre');
  });

  it('un quota atteint garde l’argumentaire Premium', () => {
    // L'abonné Standard, lui, a bien une offre à faire évoluer.
    expect(DIALOGUE).toContain('Passer à Premium');
  });

  it('la distinction porte sur le code du serveur', () => {
    expect(DIALOGUE).toMatch(/TRIAL_EXPIRED|SUBSCRIPTION_REQUIRED/);
  });

  it('l’essai terminé rassure sur les données', () => {
    // « Terminé » laisse craindre une perte : le dire évite un contact.
    expect(DIALOGUE).toContain('Vos données sont conservées');
  });
});

describe('une seule fenêtre pour toute l’application', () => {
  it('elle est montée à la racine', () => {
    const shell = sansCommentaires(read('src/components/ClientShell.tsx'));
    expect(shell).toContain('WriteGuardProvider');
  });

  it('la page des biens ne la recopie plus', () => {
    // 73 lignes de JSX y étaient écrites en dur.
    const page = sansCommentaires(read('src/app/(dashboard)/assets/page.tsx'));
    expect(page).toContain('WriteBlockedDialog');
    expect(page).not.toContain('Passez à');
  });

  it('les deux gardes recopiées passent par le contexte', () => {
    for (const chemin of [
      'src/components/DashboardLayout.tsx',
      'src/components/mobile/mobile-actions-sheet.tsx',
    ]) {
      const source = sansCommentaires(read(chemin));
      expect(source, chemin).toContain('useWriteGuard');
      // Un bandeau disparaît ; l'utilisateur ne comprend pas pourquoi rien
      // ne s'ouvre.
      expect(source, chemin).not.toContain('notifyWriteBlocked');
    }
  });
});

describe('la garde ne bloque pas à tort', () => {
  it('elle laisse passer tant que les droits sont inconnus', () => {
    // Bloquer sur une information absente refuserait l'action à un compte
    // valide, le temps d'un chargement — et le serveur tranche de toute façon.
    expect(CONTEXTE).toMatch(/if \(isLoading\) return null/);
  });

  it('hors du fournisseur, elle reste passive', () => {
    // Un aperçu ou un test monté hors contexte doit continuer de fonctionner.
    expect(CONTEXTE).toMatch(/garder: \(action\) => action\(\)/);
  });
});

describe('les points de déclenchement sont gardés', () => {
  const câblés = [
    'src/components/DashboardLayout.tsx',
    'src/components/mobile/mobile-actions-sheet.tsx',
    'src/components/assets/asset-substructures-panel.tsx',
    'src/components/assets/asset-equipments-panel.tsx',
    'src/components/assets/AssetExportsTab.tsx',
    'src/components/asset-documents-panel.tsx',
    'src/components/agenda/AgendaItemDrawer.tsx',
    'src/components/assets/AssetDetailSection.tsx',
    'src/components/assets/DocumentDrawer.tsx',
    'src/components/assets/EquipmentDrawer.tsx',
    'src/components/assets/RoomDrawer.tsx',
    'src/components/verebona/VerebonaDrawer.tsx',
  ];

  for (const chemin of câblés) {
    it(`${chemin.split('/').pop()} passe par la garde`, () => {
      expect(sansCommentaires(read(chemin))).toContain('useWriteGuard');
    });
  }

  it('la garde précède la saisie, pas l’enregistrement', () => {
    // Un formulaire rempli pour rien est pire qu'un bouton qui refuse : les
    // tiroirs gardent leur ENTRÉE en édition, pas leur bouton « Enregistrer ».
    for (const chemin of [
      'src/components/assets/RoomDrawer.tsx',
      'src/components/assets/EquipmentDrawer.tsx',
      'src/components/assets/DocumentDrawer.tsx',
    ]) {
      expect(sansCommentaires(read(chemin)), chemin).toMatch(/enterEditMode/);
    }
  });

  it('la transmission et les données brutes restent accessibles', () => {
    // Les fermer priverait l'utilisateur de ses propres données — ce que le
    // message « vos données sont conservées » promet précisément.
    const onglet = sansCommentaires(read('src/components/assets/AssetExportsTab.tsx'));
    expect(onglet).toMatch(/if \(!premiumOnly\) \{ setDrawerUsage\(type\); return; \}/);
  });
});
