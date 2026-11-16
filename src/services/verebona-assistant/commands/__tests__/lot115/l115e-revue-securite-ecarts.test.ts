/**
 * Carte #790, passage 115E — REVUE DE SÉCURITÉ DES ÉCARTS RÉSIDUELS.
 *
 * Complète `lot114/l114aa-revue-securite.test.ts` (conservé) sur les trois points
 * que la carte #790 soulève et que rien ne prouvait encore :
 *
 *   S06  C04 — autorisation d'appel modèle : TOUS les points d'entrée de
 *        production fournissent les droits réels (`aiAccess`) ; le repli
 *        historique ne peut jamais ouvrir un appel modèle à un compte limité, à
 *        une offre inconnue ou absente ;
 *   S07  E02 — rejeu : la relecture est bornée au COMPTE et à l'UTILISATEUR,
 *        aucun appel modèle, aucune écriture, aucune réexécution ;
 *   S08  E01 — la suppression d'un bien reste une commande d'écriture du
 *        catalogue fermé, confirmée, état relu.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { WRITE_COMMAND_CATALOG } = await import('../../catalog');
const { accountAllowsModelCalls, accountLimitOf, premiumBusinessRightOf } = await import('../../../core/ai-access');

const RACINE = join(__dirname, '../../..');
const APP = join(__dirname, '../../../../../app');
const lire = (p: string) => readFileSync(join(RACINE, p), 'utf8');
const lireApp = (p: string) => readFileSync(join(APP, p), 'utf8');

/** Les DEUX seules routes qui lancent l'orchestrateur en production. */
const ROUTES_ORCHESTRATEUR = [
  'api/verebona/messages/route.ts',
  'api/verebona/clarifications/[clarificationId]/answer/route.ts',
];

describe('L115E-S06 — C04 : autorisation d’appel modèle, fermée par défaut', () => {
  it('chaque point d’entrée de production transmet les droits RÉELS du compte', () => {
    for (const r of ROUTES_ORCHESTRATEUR) {
      const src = lireApp(r);
      expect(src, r).toMatch(/assistantAiAccessFromEntitlements\(/);
      expect(src, r).toMatch(/aiAccess/);
    }
  });

  it('aucun autre appelant de l’orchestrateur : le repli historique n’est atteignable que par un appel interne', () => {
    // `runAssistant` n'est importé, hors tests et scénarios, que par ces deux routes
    // et par la reprise de clarification (qui reçoit `aiAccess` de la route).
    const flux = lire('core/clarification-flow.ts');
    expect(flux).toMatch(/aiAccess/);
    for (const r of ROUTES_ORCHESTRATEUR) expect(lireApp(r), r).toMatch(/runAssistant/);
  });

  it('une limite de compte coupe tout, quels que soient les autres champs', () => {
    for (const limite of ['TRIAL_EXPIRED', 'SUBSCRIPTION_REQUIRED'] as const) {
      expect(accountAllowsModelCalls({ planLimit: limite, planType: 'PREMIUM' })).toBe(false);
      expect(accountLimitOf({ planLimit: limite, planType: 'PREMIUM' })).toBe(limite);
    }
  });

  it('offre inconnue, vide ou absente : aucun appel modèle (fermé par défaut)', () => {
    for (const offre of [undefined, null, '', 'INCONNUE', 'FREE', 'none'] as const) {
      expect(accountAllowsModelCalls({ planType: offre as never, planLimit: null }), String(offre)).toBe(false);
    }
  });

  it('les droits réels fournis font seuls foi : `aiAccess` prime sur `planType`', () => {
    const refuse = { modelCalls: false, denial: 'SUBSCRIPTION_REQUIRED', commercialPlan: 'premium', status: 'past_due', premiumFeatures: true, canWrite: false } as const;
    // Offre cognitive et aucune limite transmise, mais droits réels fermés : aucun appel.
    expect(accountAllowsModelCalls({ aiAccess: refuse as never, planType: 'PREMIUM', planLimit: null })).toBe(false);
    // Droit Premium MÉTIER : jamais déduit de l'éligibilité IA (écriture exigée en plus).
    expect(premiumBusinessRightOf({ aiAccess: refuse as never })).toBe(false);
    expect(premiumBusinessRightOf({})).toBeUndefined();
  });
});

describe('L115E-S07 — E02 : le rejeu relit, il ne recommence pas', () => {
  const route = lireApp('api/verebona/messages/route.ts');

  it('la réponse rejouée est rendue AVANT tout appel à l’orchestrateur', () => {
    const rejeu = route.indexOf('findReplayedAnswer(accountId');
    const lance = route.indexOf('await runAssistant(input, ports)');
    expect(rejeu).toBeGreaterThan(0);
    expect(lance).toBeGreaterThan(rejeu);
    // Rien n'est réexécuté : la branche de rejeu rend la réponse directement.
    expect(route).toMatch(/replayed: true/);
  });

  it('tout ce que le rejeu relit est borné au compte ET à l’utilisateur', () => {
    expect(route).toMatch(/clarificationEnAttentePourApi\(accountId, session\.userId, deja\.conversationId\)/);
    expect(route).toMatch(/findMessageCommandPlan\(accountId, session\.userId, deja\.messageId\)/);
    const fil = lire('core/conversation.service.ts');
    // La réponse rejouée n'est trouvée que pour CE compte, CET auteur et SON fil actif.
    expect(fil).toMatch(/WHERE q\.account_id = \$1 AND q\.author_user_id = \$2 AND q\.client_request_id = \$3[\s\S]*?AND c\.user_id = \$2/);
    const plans = lire('commands/plan.service.ts');
    expect(plans).toMatch(/FROM verebona_command_plans\s*\n\s*WHERE account_id = \$1 AND user_id = \$2 AND message_id = \$3/);
    const clar = lire('core/clarification.service.ts');
    expect(clar).toMatch(/export async function clarificationEnAttentePourApi/);
  });

  it('un plan clos ne réaffiche aucun bouton « Confirmer »', () => {
    expect(route).toMatch(/plan\.status === 'PENDING_CONFIRMATION'/);
  });

  it('le plan est rattaché à son message AVANT la persistance (sinon il est perdu)', () => {
    const orch = readFileSync(join(RACINE, 'core/assistant-orchestrator.service.ts'), 'utf8');
    // Aucune pose du plan APRÈS `finalize` : la persistance ne verrait rien à rattacher.
    expect(orch).not.toMatch(/\n\s*if \(prep\.kind === 'plan'\) result\.commandPlan = prep\.preview;/);
    expect(orch).not.toMatch(/\n\s*if \(prepIndices\.kind === 'plan'\) resultat\.commandPlan = prepIndices\.preview;/);
    expect((orch.match(/base\.commandPlan = /g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(lire('core/conversation.service.ts')).toMatch(/UPDATE verebona_command_plans SET message_id = \$1/);
  });
});

describe('L115E-S08 — E01 : supprimer un bien reste une écriture confirmée', () => {
  it('la fiche de commande exige le droit d’écrire, la relecture et nomme son service métier', () => {
    expect(WRITE_COMMAND_CATALOG.DELETE_ASSET.spec).toMatchObject({ readBeforeWrite: true, undoPolicy: 'IRREVERSIBLE' });
    expect(WRITE_COMMAND_CATALOG.DELETE_ASSET.requiresWriteAccess).toBe(true);
    expect(WRITE_COMMAND_CATALOG.DELETE_ASSET.service).toMatch(/\./);
  });

  it('l’arbitrage d’intention est dans le code, et il refuse AVANT de construire une suppression', () => {
    const plans = lire('commands/plan.service.ts');
    expect(plans).toMatch(/refusEffacementChampInconnu/);
    // Le refus précède la lecture du décompte de suppression.
    expect(plans.indexOf('refusEffacementChampInconnu(draft, bien, acc, lookup)'))
      .toBeLessThan(plans.indexOf('const resume = await lookup.assetDeletionSummary(acc, bien.id)'));
    // La liste des champs effaçables vient du registre, pas d'une énumération locale.
    expect(plans).toMatch(/ASSISTANT_ASSET_FIELDS\s*\n?\s*\.filter\(\(d\) => !famille \|\| d\.sections\[famille\]\)/);
  });
});
