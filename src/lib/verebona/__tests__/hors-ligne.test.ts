/**
 * Hors ligne — CDC §30.6 : un nouveau message affiche un état hors ligne
 * sans être perdu ; l'envoi reprend au retour du réseau.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { composerState, isBrowserOnline, OFFLINE_NOTICE, OfflineQueue } from '../offline';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('état du champ de saisie', () => {
  it('hors ligne : envoi désactivé et expliqué, quel que soit le texte', () => {
    expect(composerState(false, false, 'Où est ma facture ?')).toEqual({ canSend: false, notice: OFFLINE_NOTICE });
  });
  it('en ligne : envoi possible avec un texte, pas pendant un traitement', () => {
    expect(composerState(true, false, 'x')).toEqual({ canSend: true, notice: null });
    expect(composerState(true, true, 'x').canSend).toBe(false);
    expect(composerState(true, false, '   ').canSend).toBe(false);
  });
  it('navigateur : `navigator.onLine === false` seul signifie hors ligne', () => {
    expect(isBrowserOnline({ onLine: false })).toBe(false);
    expect(isBrowserOnline({ onLine: true })).toBe(true);
    expect(isBrowserOnline(undefined)).toBe(true);
  });
});

describe('file des questions en attente de connexion', () => {
  it('ordre conservé, sans doublon, vidée au retour du réseau', () => {
    const q = new OfflineQueue();
    q.enqueue({ messageId: 'a', text: 'première', clientRequestId: 'req-a' });
    q.enqueue({ messageId: 'b', text: 'seconde', context: { assetId: '4' }, clientRequestId: 'req-b' });
    q.enqueue({ messageId: 'a', text: 'première', clientRequestId: 'req-a' });
    expect(q.size).toBe(2);
    expect(q.has('b')).toBe(true);
    expect(q.drain().map((x) => [x.text, x.clientRequestId])).toEqual([['première', 'req-a'], ['seconde', 'req-b']]);
    expect(q.size).toBe(0);
  });
});

describe('branchement dans le client', () => {
  const hook = read('src/lib/verebona/useVerebona.ts');
  const composer = read('src/components/verebona/VerebonaComposer.tsx');
  const drawer = read('src/components/verebona/VerebonaDrawer.tsx');

  it('le hook écoute `online` / `offline`, met la question en attente et la renvoie au retour', () => {
    expect(hook).toMatch(/addEventListener\('offline'/);
    expect(hook).toMatch(/addEventListener\('online'/);
    expect(hook).toMatch(/offlineQueue\.current\.enqueue/);
    expect(hook).toMatch(/offlineQueue\.current\.drain\(\)/);
    expect(hook).toMatch(/pendingOffline: true/);
  });

  it('renvoi avec l’identifiant de requête D’ORIGINE (pas de double traitement, §31.9)', () => {
    expect(hook).toMatch(/sendRef\.current\(q\.text, q\.context, \{ clientRequestId: q\.clientRequestId, userMessageId: q\.messageId \}\)/);
    expect(hook).toMatch(/const clientRequestId = reprise\?\.clientRequestId \?\? newId\(\)/);
    // La coupure pendant l'envoi met en file l'identifiant déjà transmis.
    expect(hook).toMatch(/enqueue\(\{ messageId: userMsg\.id, text: message, context: extraContext, clientRequestId \}\)/);
  });

  it('le champ est désactivé hors ligne, le tiroir le lui dit', () => {
    expect(composer).toMatch(/composerState\(!offline/);
    expect(composer).toMatch(/disabled=\{!etat\.canSend\}/);
    expect(drawer).toMatch(/offline=\{!v\.online\}/);
  });

  it('pagination de l’historique branchée (§27.6)', () => {
    expect(hook).toMatch(/cursor=\$\{olderCursor\}/);
    expect(drawer).toMatch(/onLoadOlder=/);
  });
});
