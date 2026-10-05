/**
 * APP-PERF-29 — suivi des dépôts hors du panneau, annulation explicite,
 * reprise compréhensible, limite mobile annoncée honnêtement.
 */
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@/lib/upload-http', () => ({ fetchDepot: vi.fn(), messageSelonStatut: () => '' }));
import { UploadQueuePanel, libelleEtape, MESSAGE_MOBILE } from '../UploadQueueIndicator';
import type { ElementDepot } from '@/lib/upload-queue';

// Le harnais (environnement node) compile le JSX en `React.createElement`.
(globalThis as { React?: typeof React }).React = React;

const el = (over: Partial<ElementDepot>): ElementDepot => ({
  operationId: Math.random().toString(36).slice(2), lotId: 'l', nom: 'facture.pdf', taille: 1000, mimeType: 'application/pdf',
  derniereModif: 1, etape: 'attente', progression: 0, fileId: null, sha256: null, transfere: false, reprise: null,
  erreur: null, meta: {} as ElementDepot['meta'], creeLe: 0, fichierDisponible: true, ...over,
});
const rendre = (elements: ElementDepot[], mobile = false) => renderToStaticMarkup(createElement(UploadQueuePanel, {
  elements, mobile, onAnnuler: () => {}, onReprendre: () => {}, onChoisirFichier: () => {}, onRetirer: () => {},
}));

describe('panneau de suivi', () => {
  it('transfert en cours : progression et « Annuler »', () => {
    const html = rendre([el({ etape: 'transfert', progression: 0.42 })]);
    expect(html).toContain('Envoi 42 %');
    expect(html).toContain('>Annuler<');
    expect(html).toContain('width:42%');
  });

  it('échec reprenable avec le fichier en mémoire : « Reprendre » et motif', () => {
    const html = rendre([el({ etape: 'echec', reprise: 'presign', erreur: 'facture.pdf : le stockage a refusé le fichier (réseau ou CORS).' })]);
    expect(html).toContain('Reprendre');
    expect(html).toContain('réseau ou CORS');
    expect(html).toContain('Abandonner');
    expect(html).not.toContain('Choisir le fichier');
  });

  it('interrompu après fermeture, fichier absent : « Choisir le fichier »', () => {
    const html = rendre([el({ etape: 'interrompu', reprise: 'preparation', fichierDisponible: false, erreur: 'Envoi interrompu.' })]);
    expect(html).toContain('Choisir le fichier');
    expect(html).not.toContain('Reprendre<');
  });

  it('transféré non confirmé : reprise sans fichier (confirmation seule)', () => {
    const html = rendre([el({ etape: 'interrompu', reprise: 'confirmation', fichierDisponible: false, transfere: true })]);
    expect(html).toContain('Reprendre');
  });

  it('refus définitif : ni reprise ni choix, seulement « Abandonner »', () => {
    const html = rendre([el({ etape: 'echec', reprise: null, erreur: 'Espace de stockage insuffisant.' })]);
    expect(html).not.toContain('Reprendre');
    expect(html).not.toContain('Choisir le fichier');
    expect(html).toContain('Abandonner');
  });

  it('mobile : limite d’arrière-plan annoncée, aucune promesse d’envoi en veille (CA-03)', () => {
    expect(rendre([el({ etape: 'transfert' })], true)).toContain('gardez l’application ouverte');
    expect(rendre([el({ etape: 'termine' })], true)).not.toContain('gardez l’application ouverte');
    expect(MESSAGE_MOBILE).not.toMatch(/arrière-plan garanti|continue même/i);
  });

  it('libellés d’étape', () => {
    expect(libelleEtape(el({ etape: 'preparation', progression: 0.5 }))).toBe('Préparation 50 %');
    expect(libelleEtape(el({ etape: 'confirmation' }))).toBe('Enregistrement…');
  });
});

describe('le panneau n’annule plus l’envoi en se fermant (CA-01)', () => {
  const DIALOGUE = readFileSync(join(process.cwd(), 'src/components/documents/unified-document-dialog.tsx'), 'utf-8');
  const GABARIT = readFileSync(join(process.cwd(), 'src/components/DashboardLayout.tsx'), 'utf-8');

  it('aucun AbortController dans le dialogue ; fermer ≠ annuler', () => {
    expect(DIALOGUE).not.toMatch(/new AbortController|uploadAbortRef/);
    const close = DIALOGUE.slice(DIALOGUE.indexOf('const handleClose = () => {'), DIALOGUE.indexOf('const annulerEnvoi'));
    expect(close).not.toMatch(/annulerLot|abort\(/);
    expect(DIALOGUE).toMatch(/fileDepot\.annulerLot\(lotRef\.current\)/);
    expect(DIALOGUE).toMatch(/Annuler l'envoi/);
  });

  it('la file est confiée au module global, suivie dans le gabarit de l’application', () => {
    expect(DIALOGUE).toMatch(/fileDepot\.ajouterLot\(/);
    expect(GABARIT).toMatch(/<UploadQueueIndicator userId=/);
  });

  it('la fin d’un lot ne referme un panneau que s’il suit encore ce lot', () => {
    expect(DIALOGUE).toMatch(/suitLeLot\(bilan\.lotId\)/);
  });
});
