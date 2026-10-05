/**
 * Espace de réponse — correctifs de revue :
 *   · ouvrir n'est pas écrire (pas de garde ni d'ouverture au focus) ;
 *   · un échange en attente de décision ne se replie jamais ;
 *   · suggestions pendant la frappe (recherche sans appel modèle) ;
 *   · suppression d'un fil, accès à toutes les demandes ;
 *   · agenda accessible sur mobile ; pas de fenêtres d'ajout mortes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { VerebonaMessage } from '../useVerebona';
import { buildTurns, splitTurns, turnNeedsAttention } from '../space';
import { NAV_PAGES, moveActive, navMatches, toLiveResults } from '../live-search';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const user = (id: string, content: string): VerebonaMessage => ({ id, role: 'user', content });
const bot = (id: string, extra: Partial<VerebonaMessage> = {}): VerebonaMessage => ({ id, role: 'assistant', content: 'x', ...extra });
const NOW = Date.parse('2026-09-28T12:00:00Z');
const plan = (status: NonNullable<VerebonaMessage['commandPlan']>['status'], extra: Partial<NonNullable<VerebonaMessage['commandPlan']>> = {}) => ({
  planId: 'p', summary: '', expiresAt: '2026-09-28T12:10:00Z', actions: [], status, ...extra,
});

describe('ouvrir n’est pas écrire (boucle de la fenêtre de fin d’essai)', () => {
  const provider = read('src/components/verebona/space/VerebonaSpaceProvider.tsx');
  const field = read('src/components/verebona/space/VerebonaField.tsx');

  it('l’ouverture ne passe pas par la garde ; l’envoi, si', () => {
    expect(provider).toMatch(/const open = useCallback\(\(\) => \{\s*setIsOpen\(true\);\s*focusInput\(\);/);
    expect(provider).toMatch(/const envoyer = useCallback\([^]*?if \(!autorise\(\)\)/);
  });

  it('le champ s’ouvre au clic ou à la frappe, jamais au focus', () => {
    expect(field).toMatch(/onFocus=\{\(\) => setFocused\(true\)\}/);
    expect(field).not.toMatch(/onFocus=\{\(\) => \{[^}]*api\.open\(\)/);
    expect(field).toMatch(/onClick=\{\(\) => \{ if \(!api\.isOpen\) api\.open\(\); \}\}/);
  });

  it('⌘K et Échap laissent la main à une fenêtre modale ouverte', () => {
    expect(provider.match(/if \(modalOuverte\(\)\) return;/g)?.length).toBe(2);
  });

  it('mobile : l’espace plein écran se ferme avant un tiroir ou la fenêtre de refus', () => {
    const content = read('src/components/verebona/space/SpaceContent.tsx');
    expect(content).toMatch(/onLeave\(\); openDrawerFromLink/);
    expect(content).toMatch(/api\.leaveForOverlay\(\); openDrawerFromLink/);
    expect(provider).toMatch(/if \(!autorise\(\)\) \{[^}]*leaveForOverlay\(\);/);
    expect(field).toMatch(/<FocusScope trapped loop asChild>/);
  });
});

describe('un échange en attente de décision reste déplié', () => {
  it('plan à confirmer, annulation encore possible, clarification ouverte', () => {
    const t = (m: VerebonaMessage) => buildTurns([user('u', 'q'), m], false)[0];
    expect(turnNeedsAttention(t(bot('b', { commandPlan: plan('PENDING_CONFIRMATION') })), NOW)).toBe(true);
    expect(turnNeedsAttention(t(bot('b', { commandPlan: plan('PENDING_CONFIRMATION', { expiresAt: '2026-09-28T11:00:00Z' }) })), NOW)).toBe(false);
    expect(turnNeedsAttention(t(bot('b', { commandPlan: plan('EXECUTED', { undoUntil: '2026-09-28T12:05:00Z' }) })), NOW)).toBe(true);
    expect(turnNeedsAttention(t(bot('b', { commandPlan: plan('EXECUTED', { undoUntil: '2026-09-28T11:55:00Z' }) })), NOW)).toBe(false);
    expect(turnNeedsAttention(t(bot('b', { clarification: { clarificationId: 'c', question: '?', choices: [{ choiceId: 'a', label: 'A' }] } })), NOW)).toBe(true);
    expect(turnNeedsAttention(t(bot('b')), NOW)).toBe(false);
  });

  it('il n’est pas regroupé avec les échanges précédents', () => {
    const turns = buildTurns([
      user('u1', 'Crée un rappel'), bot('b1', { commandPlan: plan('PENDING_CONFIRMATION') }),
      user('u2', 'a'), bot('b2'), user('u3', 'b'), bot('b3'), user('u4', 'c'), bot('b4'),
    ], false);
    const { recent, older } = splitTurns(turns, 2, NOW);
    expect(recent.map((x) => x.question)).toEqual(['Crée un rappel', 'b', 'c']);
    expect(older.map((x) => x.question)).toEqual(['a']);
  });

  it('une ligne regroupée se déplie au clic, elle ne repose pas la question', () => {
    const content = read('src/components/verebona/space/SpaceContent.tsx');
    expect(content).toMatch(/onClick=\{\(\) => basculer\(t\.id\)\}/);
    expect(content).not.toMatch(/Reposer la question/);
  });
});

describe('suggestions pendant la frappe', () => {
  it('pages par leur nom, sans accent ni casse', () => {
    expect(navMatches('agen').map((x) => x.title)).toEqual(['Mon agenda']);
    expect(navMatches('a')).toEqual([]);
    expect(navMatches('a traiter').map((x) => x.href)).toEqual(['/accueil/a-traiter']);
  });

  it('réponse de la recherche → suggestions typées (tiroir si fourni), bornées', () => {
    const r = toLiveResults('ferrari', [
      { id: 'asset-1', category: 'Bien', label: 'Ferrari Testarossa', sublabel: 'Voiture', href: '/assets/1' },
      { id: 'doc-4', category: 'Document', label: 'Carte grise', sublabel: 'Ferrari', href: '/documents?tiroir=document:4', drawer: { kind: 'document', id: 4 } },
      { id: 'x', category: 'Inconnu', label: 'x', href: '/x' },
    ]);
    expect(r.map((x) => x.kind)).toEqual(['asset', 'document']);
    expect(r[1].drawer).toEqual({ kind: 'document', id: 4 });
    expect(toLiveResults('mes', Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, category: 'Bien', label: `B${i}`, href: '/assets/1' })))).toHaveLength(6);
    expect(NAV_PAGES.every((p) => p.href.startsWith('/'))).toBe(true);
  });

  it('flèches : aucune suggestion (−1) → première → … → dernière → aucune', () => {
    expect(moveActive(-1, 1, 3)).toBe(0);
    expect(moveActive(2, 1, 3)).toBe(-1);
    expect(moveActive(-1, -1, 3)).toBe(2);
    expect(moveActive(-1, 1, 0)).toBe(-1);
  });

  it('jamais d’appel modèle à la frappe : recherche lexicale seule (D-H2, lot 16b-2)', () => {
    expect(read('src/components/verebona/space/VerebonaSpaceProvider.tsx')).toMatch(/\/api\/search\?instant=1&q=/);
    const route = read('src/app/api/search/route.ts');
    // Aucun import de moteur IA (recherche Gemini, drapeaux, passerelle).
    expect(route).not.toMatch(/^import[^\n]*(gemini|ai-feature-flags|ai-gateway|\/services\/ai\/)/im);
    expect(route).not.toMatch(/AiGateway/);
    expect(route).toMatch(/aiPowered: false/);
  });
});

describe('fils : suppression et accès à toutes les demandes', () => {
  it('suppression d’un fil (courant ou archivé), confirmée', () => {
    const hook = read('src/lib/verebona/useVerebona.ts');
    expect(hook).toMatch(/const deleteThread = useCallback\(async \(id: number\) => \{\s*if \(id === conversationRef\.current\) \{ await clear\(\); return; \}/);
    const content = read('src/components/verebona/space/SpaceContent.tsx');
    expect(content).toMatch(/api\.v\.deleteThread\(h\.id\)/);
    expect(content).toMatch(/role="alertdialog"/);
  });

  it('« Nouvelle demande » partout (plus d’« Effacer » trompeur) ; toutes les demandes accessibles', () => {
    const field = read('src/components/verebona/space/VerebonaField.tsx');
    expect(field).not.toMatch(/>\s*Effacer\s*</);
    expect(field.match(/Nouvelle demande/g)?.length).toBeGreaterThanOrEqual(2);
    expect(field).toMatch(/Toutes les demandes/);
  });

  it('le résumé d’un fil ne lit que des messages valides du compte', () => {
    const svc = read('src/services/verebona-assistant/core/conversation.service.ts');
    expect(svc).toMatch(/m\.account_id = c\.account_id\s+AND m\.role = 'assistant' AND m\.expires_at > now\(\)/);
  });
});

describe('coquille', () => {
  const layout = read('src/components/DashboardLayout.tsx');
  it('mobile : l’agenda est un onglet de la barre basse (maquette Direction D v2)', () => {
    expect(read('src/components/mobile/bottom-navigation.tsx')).toMatch(/href: '\/agenda'/);
  });
  it('pas de « + » global desktop (spécification) : plus de fenêtres d’ajout mortes', () => {
    expect(layout).not.toMatch(/AssetFormDialog|UnifiedDocumentDialog|CreateAgendaItemDrawer/);
    expect(read('src/components/verebona/space/VerebonaSpaceProvider.tsx')).not.toMatch(/verebona:add/);
  });
});
