/**
 * Lot 31 — point 5 : plus de panneau flottant « Envoi de documents 2/2 »
 * après l'ajout d'un document (« La notification suffit »).
 *
 * L31-5-AC1 : aucun suivi flottant n'est affiché, ni sur ordinateur ni sur
 *             mobile ; le composant monté dans le gabarit ne rend rien.
 * L31-5-AC2 : aucun toast de succès « document(s) ajouté(s) » (ni « Lien web
 *             ajouté », ni « Suivez-le dans le panneau… ») à l'ajout.
 * L31-5-AC3 : le retour utilisateur d'un envoi réussi est couvert par
 *             l'indicateur « Analyse(s) en cours… Voir » du header (bandeau
 *             mobile) et la cloche, alimentés par les signaux de la modale.
 * L31-5-AC4 : un ÉCHEC reste signalé de façon visible : message d'erreur en
 *             fin de lot (avec « Reprendre » si la modale ne suit plus le
 *             lot), envois interrompus restaurés et reprise automatique
 *             échouée signalés une fois, avec « Reprendre ».
 * L31-5-AC5 : « Reprendre » ouvre la modale d'ajout, qui liste les envois à
 *             reprendre (fichier à resélectionner compris).
 * L31-5-AC6 : la file elle-même est intacte : stockage par utilisateur,
 *             avertissement de fermeture, reprise automatique, purge par
 *             session ; le code mort du suivi flottant a disparu.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ElementDepot } from '@/lib/upload-queue';

(globalThis as { React?: typeof React }).React = React;

const el = (over: Partial<ElementDepot>): ElementDepot => ({
  operationId: Math.random().toString(36).slice(2), lotId: 'l', nom: 'facture.pdf', taille: 1000, mimeType: 'application/pdf',
  derniereModif: 1, etape: 'attente', progression: 0, fileId: null, sha256: null, transfere: false, reprise: null,
  erreur: null, meta: {} as ElementDepot['meta'], creeLe: 0, fichierDisponible: true, ...over,
});

const etat = vi.hoisted(() => ({ mobile: false, elements: [] as unknown[] }));
vi.mock('@/lib/upload-http', () => ({ fetchDepot: vi.fn(), messageSelonStatut: () => '' }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => etat.mobile }));
vi.mock('@/hooks/useFileDepot', () => ({
  useFileDepot: () => ({ elements: etat.elements, enCours: (etat.elements as ElementDepot[]).filter((e) => !['termine', 'echec', 'annule', 'interrompu'].includes(e.etape)).length }),
}));
vi.mock('@/contexts/AnalysisBannerContext', () => ({
  useAnalysisBanner: () => ({ analyzingCount: 2, analyzingFileIds: [41, 42], analysisStartTimes: {} }),
}));

const { UploadQueueSupervisor } = await import('../UploadQueueSupervisor');
const { UploadResumeSection } = await import('../UploadQueuePanel');
const { AnalysisBanner, MobileAnalysisBanner } = await import('@/components/AnalysisBanner');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const fb = await import('@/lib/upload-queue-feedback');

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const DIALOGUE = lire('src/components/documents/unified-document-dialog.tsx');
const GABARIT = lire('src/components/DashboardLayout.tsx');
const SUPERVISEUR = lire('src/components/documents/UploadQueueSupervisor.tsx');
const PANNEAU = lire('src/components/documents/UploadQueuePanel.tsx');

describe('L31-5-AC1 : plus de suivi flottant « Envoi de documents »', () => {
  const lot = [el({ etape: 'termine', nom: 'Attestation.pdf' }), el({ etape: 'transfert', progression: 0.4 }), el({ etape: 'echec', reprise: 'presign', erreur: 'x' })];

  it('ordinateur : rien n’est rendu, même pendant et après un envoi', () => {
    etat.mobile = false; etat.elements = lot;
    expect(renderToStaticMarkup(h(UploadQueueSupervisor, { userId: 1 }))).toBe('');
  });

  it('mobile : rien n’est rendu non plus', () => {
    etat.mobile = true; etat.elements = lot;
    expect(renderToStaticMarkup(h(UploadQueueSupervisor, { userId: 1 }))).toBe('');
  });

  it('le gabarit monte la supervision sans rendu, plus l’ancien indicateur', () => {
    expect(GABARIT).toMatch(/<UploadQueueSupervisor userId=\{user\?\.id \?\? null\} \/>/);
    expect(GABARIT).not.toMatch(/UploadQueueIndicator/);
    expect(existsSync(join(process.cwd(), 'src/components/documents/UploadQueueIndicator.tsx'))).toBe(false);
    // Seul rendu possible : la modale d'ajout, sur « Reprendre ».
    expect(SUPERVISEUR).toMatch(/if \(!repriseOuverte\) return null;\s*return <LazyUnifiedDocumentDialog open /);
    expect(SUPERVISEUR).not.toMatch(/<div|className=|data-upload-queue/);
  });
});

describe('L31-5-AC2 : aucun toast de succès à l’ajout', () => {
  it('ni « N documents ajoutés », ni « Lien web ajouté », ni renvoi au panneau d’envoi', () => {
    expect(DIALOGUE).not.toMatch(/toast\.success/);
    expect(DIALOGUE).not.toMatch(/toast\.info/);
    expect(DIALOGUE).not.toMatch(/documents? ajoutés?['`]/);
    expect(DIALOGUE).not.toMatch(/panneau « Envoi de documents »|panneau d'envoi|en bas de l’écran/);
    // Ni dans le panneau « + Ajouter » qui ouvre la modale.
    expect(lire('src/components/mobile/mobile-actions-sheet.tsx')).not.toMatch(/toast\.success/);
  });
});

describe('L31-5-AC3 : la notification couvre le retour d’un envoi réussi', () => {
  it('la modale émet les signaux d’analyse lus par le header et la cloche', () => {
    expect(DIALOGUE).toMatch(/new CustomEvent\('document-analysis-start', \{ detail: \{ fileId \} \}\)/);
    expect(DIALOGUE).toMatch(/new CustomEvent\('document-added'/);
    expect(lire('src/contexts/AnalysisBannerContext.tsx')).toMatch(/addEventListener\('document-analysis-start'/);
    expect(lire('src/components/NotificationBell.tsx')).toMatch(/addEventListener\('document-analysis-start'/);
  });

  it('header (ordinateur) et bandeau mobile : « 2 analyses en cours… » et « Voir »', () => {
    const desktop = renderToStaticMarkup(h(TooltipProvider, null, h(AnalysisBanner)));
    expect(desktop).toContain('2 analyses en cours');
    expect(desktop).toContain('Voir');
    const mobile = renderToStaticMarkup(h(MobileAnalysisBanner));
    expect(mobile).toContain('2 analyses en cours');
    expect(mobile).toContain('Voir');
  });
});

describe('L31-5-AC4 : un échec reste signalé de façon visible', () => {
  it('fin de lot avec échecs : message d’erreur, « Reprendre » si la modale ne suit plus le lot', () => {
    const fin = DIALOGUE.slice(DIALOGUE.indexOf('const surFinLot'), DIALOGUE.indexOf('// ── Submit'));
    expect(fin).toMatch(/if \(bilan\.echecs\.length > 0\) \{[^]*toast\.error\(/);
    expect(fin).toMatch(/const suivi = suitLeLot\(bilan\.lotId\)/);
    expect(fin).toMatch(/suivi \? \{\} : \{ action: \{ label: ACTION_REPRISE, onClick: ouvrirRepriseDepots \} \}/);
  });

  it('envois restaurés « interrompus » : un message, une seule fois', () => {
    const m = fb.nouvelleMemoireSignalements();
    const a = el({ etape: 'interrompu', reprise: 'preparation', fichierDisponible: false });
    const b = el({ etape: 'interrompu', reprise: 'confirmation', fichierDisponible: false, transfere: true });
    expect(fb.signalementsDepot([a, b, el({ etape: 'termine' })], m)).toEqual(['2 envois de documents interrompus']);
    expect(fb.signalementsDepot([a, b], m)).toEqual([]);
    const c = el({ etape: 'interrompu', reprise: 'preparation', fichierDisponible: false });
    expect(fb.signalementsDepot([a, b, c], m)).toEqual(['1 envoi de document interrompu']);
  });

  it('reprise automatique retombée en échec : signalée ; réussie : silencieuse', () => {
    const m = fb.nouvelleMemoireSignalements();
    const ko = el({ etape: 'echec', reprise: 'presign', erreur: 'réseau' });
    const ok = el({ etape: 'termine' });
    m.relances.add(ko.operationId); m.relances.add(ok.operationId);
    expect(fb.signalementsDepot([el({ ...ko, etape: 'transfert' }), ok], m)).toEqual([]);
    expect(m.relances.has(ok.operationId)).toBe(false);
    expect(fb.signalementsDepot([ko, ok], m)).toEqual(['1 document non ajouté après reprise']);
    expect(fb.signalementsDepot([ko, ok], m)).toEqual([]);
  });

  it('la supervision affiche ces messages en erreur, avec « Reprendre »', () => {
    expect(SUPERVISEUR).toMatch(/toast\.error\(message, \{[^]*action: \{ label: ACTION_REPRISE, onClick: ouvrirRepriseDepots \}/);
    expect(SUPERVISEUR).toMatch(/for \(const message of signalementsDepot\(elements, memoire\.current\)\) signaler\(message\)/);
  });
});

describe('L31-5-AC5 : « Reprendre » ouvre la modale d’ajout sur les envois à reprendre', () => {
  it('l’événement ouvre la modale d’ajout depuis le gabarit', () => {
    expect(fb.EVENEMENT_REPRISE_DEPOTS).toBe('upload-queue:resume');
    expect(SUPERVISEUR).toMatch(/window\.addEventListener\(EVENEMENT_REPRISE_DEPOTS, ouvrir\)/);
    expect(SUPERVISEUR).toMatch(/<LazyUnifiedDocumentDialog open onOpenChange=/);
    expect(DIALOGUE).toMatch(/<UploadResumeSection lotSuivi=\{lotId\} mobile=\{isMobile\} \/>/);
  });

  it('section « envois à reprendre » : échecs et interrompus hors du lot suivi', () => {
    etat.elements = [
      el({ operationId: 'a', lotId: 'ancien', etape: 'interrompu', reprise: 'preparation', fichierDisponible: false, erreur: 'Envoi interrompu. Resélectionnez le fichier pour le reprendre.' }),
      el({ operationId: 'b', lotId: 'ancien', etape: 'echec', reprise: 'presign', erreur: 'réseau', nom: 'devis.pdf' }),
      el({ operationId: 'c', lotId: 'courant', etape: 'echec', reprise: 'presign', nom: 'courant.pdf' }),
      el({ operationId: 'd', lotId: 'ancien', etape: 'termine', nom: 'ok.pdf' }),
    ];
    const html = renderToStaticMarkup(h(UploadResumeSection, { lotSuivi: 'courant' }));
    expect(html).toContain('data-upload-resume');
    expect(html).toContain('role="alert"');
    expect(html).toContain('2 envois à reprendre');
    expect(html).toContain('Choisir le fichier');
    expect(html).toContain('Reprendre');
    expect(html).toContain('devis.pdf');
    expect(html).not.toContain('courant.pdf'); // affiché par le suivi du lot de la modale
    expect(html).not.toContain('ok.pdf');
  });

  it('rien à reprendre : aucune section', () => {
    etat.elements = [el({ etape: 'termine' })];
    expect(renderToStaticMarkup(h(UploadResumeSection, { lotSuivi: null }))).toBe('');
    expect(fb.envoisAReprendre([el({ etape: 'annule' }), el({ etape: 'transfert' })])).toEqual([]);
  });
});

describe('L31-5-AC6 : file d’envoi intacte, code mort supprimé', () => {
  it('stockage par utilisateur, avertissement de fermeture, reprise au retour', () => {
    expect(SUPERVISEUR).toMatch(/fileDepot\.utiliserStockage\(userId \? stockageLocal\(userId\) : null\)/);
    expect(SUPERVISEUR).toMatch(/addEventListener\('beforeunload', avertir\)/);
    expect(SUPERVISEUR).toMatch(/addEventListener\('visibilitychange', surRetour\)/);
    expect(SUPERVISEUR).toMatch(/fileDepot\.reprendre\(id\)/);
  });

  it('purge par session toujours branchée dans la file', () => {
    const file = lire('src/lib/upload-queue.ts');
    expect(file).toMatch(/purger\(\): void \{/);
    expect(file).toMatch(/onSessionTransition/);
  });

  it('plus de position flottante ni de repli du suivi', () => {
    expect(PANNEAU).not.toMatch(/POSITION_MOBILE|right-4 bottom-4|retirerTermines|Envoi de documents \{/);
  });
});
