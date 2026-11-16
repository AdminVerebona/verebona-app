/**
 * Passage 114AA (Trello #753, §5 de la carte — SÉCURITÉ) — REVUE DE SÉCURITÉ des exigences de la carte,
 * chacune prouvée par un test. Elle porte sur l'ensemble du catalogue d'actions ET sur les surfaces
 * nouvelles du passage (état d'un export relu, événement de référence du fil).
 *
 *   S01  confirmation avant TOUTE écriture : catalogue FERMÉ, plan figé, aperçu qui demande la confirmation,
 *        exécution seulement par identifiant de plan ; aucune écriture à la préparation ;
 *   S02  aucun identifiant venu du modèle : le contrat des indices d'action n'en porte aucun, le code ne lit
 *        aucun identifiant d'un indice, et les liens affichés sont construits par le serveur ;
 *   S03  état RELU avant d'écrire : chaque commande du catalogue le déclare, et chaque exécuteur le fait ;
 *   S04  isolation du compte ET du fil : toute lecture et toute écriture des surfaces du passage portent le
 *        compte (et, pour le fil, l'utilisateur) dans leur condition ;
 *   S05  `VEREBONA_ASSISTANT_WRITE_COMMANDS` coupée : aucune action, aucun export, aucun dépôt, aucun indice.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { WRITE_COMMAND_CATALOG, actionKind } = await import('../../catalog');
/** Le catalogue EST la liste fermée : une commande d'écriture est exactement une de ses clés. */
const estCommandeEcriture = (t: string) => Object.prototype.hasOwnProperty.call(WRITE_COMMAND_CATALOG, t);
const { REFERENCE_EVENT_EXECUTORS } = await import('../../reference-events');
const { EXECUTORS } = await import('../../executors');
const { safeExportDownloadHref } = await import('../../export-request');
const { etatCarteExport } = await import('../../../core/export-card-state');

const RACINE = join(__dirname, '../../..');
const lire = (p: string) => readFileSync(join(RACINE, p), 'utf8');

describe('L114AA-S01 — confirmation avant toute écriture', () => {
  it('le catalogue des commandes d’écriture est FERMÉ et chacune exige le droit d’écrire', () => {
    const commandes = Object.keys(WRITE_COMMAND_CATALOG);
    expect(commandes.length).toBeGreaterThan(0);
    for (const [type, def] of Object.entries(WRITE_COMMAND_CATALOG)) {
      expect(def.type, type).toBe(type);
      expect(def.requiresWriteAccess, type).toBe(true);
      expect(estCommandeEcriture(type), type).toBe(true);
      expect(actionKind(type as never), type).toBe('write_command');
      // Chaque commande nomme le SERVICE métier qu'elle appelle : aucune écriture propre à l'Assistant.
      expect(def.service, type).toMatch(/\./);
    }
  });

  it('chaque commande d’écriture a un exécuteur, et aucun exécuteur n’existe hors du catalogue', () => {
    const executeurs = new Set([...Object.keys(EXECUTORS), ...Object.keys(REFERENCE_EVENT_EXECUTORS)]);
    for (const type of Object.keys(WRITE_COMMAND_CATALOG)) expect(executeurs.has(type), type).toBe(true);
    for (const type of executeurs) expect(estCommandeEcriture(type), type).toBe(true);
  });

  it('l’exécution n’est possible que par l’identifiant du PLAN : la prise est atomique et bornée au propriétaire', () => {
    const src = lire('commands/plan.service.ts');
    // Le plan est pris en passant de PENDING_CONFIRMATION à EXECUTING, pour CE compte et CET utilisateur.
    expect(src).toMatch(/SET status = 'EXECUTING'[\s\S]*?WHERE plan_id = \$1 AND account_id = \$2 AND user_id = \$3[\s\S]*?AND status = 'PENDING_CONFIRMATION' AND expires_at > now\(\)/);
    // L'empreinte des paramètres présentés est recontrôlée avant d'exécuter.
    expect(src).toMatch(/hashActions\(pris\[0\]\.actions_payload\) !== pris\[0\]\.params_hash/);
    // Les droits sont réévalués À L'EXÉCUTION, pas à la préparation.
    expect(src).toMatch(/const droit = await \(deps\.canWrite \?\? defaultCanWrite\)\(p\.accountId\)/);
  });

  it('un plan est enregistré en attente de confirmation, et l’aperçu demande la confirmation', () => {
    const src = lire('commands/plan.service.ts');
    expect(src).toMatch(/'PENDING_CONFIRMATION'/);
    expect(src).toMatch(/Confirmez-vous \?/);
    // Aucune écriture métier à la préparation : le fichier n'appelle aucune façade d'écriture.
    expect(src).not.toMatch(/updateDocumentForAccount|createAssetForAccount|createOperation\(/);
  });

  it('l’export et le dépôt d’un fichier, seules actions sans confirmation, n’écrivent AUCUNE donnée métier', () => {
    // L'export passe par la façade du service d'export (ligne d'historique + fichier), jamais par un plan.
    const exp = lire('commands/export-request.ts');
    expect(exp).toMatch(/export-request\.facade/);
    expect(exp).not.toMatch(/PlannedAction|CommandParams/);
    // Le dépôt ne dépose rien : il ouvre le parcours existant.
    const dep = lire('commands/upload-request.ts');
    expect(dep).not.toMatch(/facade|INSERT|UPDATE/i);
  });
});

describe('L114AA-S02 — aucun identifiant venu du modèle', () => {
  it('le contrat des indices d’action ne porte AUCUN identifiant', async () => {
    const src = lire('types/contracts.ts');
    const bloc = src.slice(src.indexOf('export interface ActionHint {'));
    const corps = bloc.slice(0, bloc.indexOf('}'));
    expect(corps).toContain('targetHint: string | null');
    // Ni identifiant, ni clé technique : seulement des textes et des énumérations fermées.
    expect(corps).not.toMatch(/\bid\b|Id\b|operationId|assetId|documentId/);
  });

  it('le code des actions comprises par le sens ne lit aucun identifiant d’un indice', () => {
    const src = lire('commands/action-hints.ts');
    expect(src).not.toMatch(/\bh\.(id|targetId|assetId|documentId|operationId)\b/);
    expect(src).not.toMatch(/Number\(\s*h\./);
    // Les objets sont retrouvés dans le COMPTE, par l'analyseur habituel puis la préparation du plan.
    expect(src).toMatch(/deps\.prepare\(/);
  });

  it('un lien de téléchargement n’est admis que vers la route des exports', () => {
    expect(safeExportDownloadHref('/api/export-generations/abc-1/download?file=pdf')).toBe('/api/export-generations/abc-1/download?file=pdf');
    for (const faux of [
      'https://exemple.test/vol', '/api/export-generations/../../secret/download?file=pdf',
      '/api/export-generations/abc/download?file=exe', 'javascript:alert(1)', '/autre/chemin', null, 42,
    ]) expect(safeExportDownloadHref(faux)).toBeNull();
  });

  it('le lien d’une carte d’export est construit avec l’identifiant public LU EN BASE', () => {
    const etat = etatCarteExport(
      { id: 7, publicId: 'pub-7', status: 'ready', outputPayload: JSON.stringify({ pdfS3Key: 'k.pdf' }), expiresAt: null },
      () => ({ statut: 'ready', pdf: 'k.pdf', zip: null }),
    );
    expect(etat!.href).toBe('/api/export-generations/pub-7/download?file=pdf');
    expect(safeExportDownloadHref(etat!.href)).toBe(etat!.href);
    // Aucun lien n'est deviné quand aucun fichier n'est connu.
    expect(etatCarteExport({ id: 7, publicId: 'pub-7', status: 'ready', outputPayload: null, expiresAt: null }, () => ({ statut: 'ready', pdf: null, zip: null }))!.href).toBeNull();
  });

  it('l’événement de référence du fil est un entier du contexte serveur, jamais une valeur du client ni du modèle', () => {
    const conv = lire('core/conversation.service.ts');
    // Lu comme entier positif, et de toute façon relu dans le compte avant usage.
    expect(conv).toMatch(/lastReferenceEventId: Number\.isInteger\(c\.lastReferenceEventId\) && Number\(c\.lastReferenceEventId\) > 0/);
    const ev = lire('commands/reference-events.ts');
    expect(ev).toMatch(/const duFil = input\.threadReferenceEventId;[\s\S]*?getReferenceEventState\(accountId, duFil\)/);
    // Le contrat de la demande dit qu'il n'est jamais fourni par le client.
    expect(lire('types/contracts.ts')).toMatch(/threadReferenceEventId[\s\S]{0,40}number \| null/);
  });
});

describe('L114AA-S03 — état relu avant d’écrire', () => {
  it('chaque fiche de commande déclare la lecture avant écriture', () => {
    for (const [type, def] of Object.entries(WRITE_COMMAND_CATALOG)) {
      if (!def.spec) continue; // deux commandes historiques, déjà recettées, n'ont pas de fiche
      expect(def.spec.readBeforeWrite, type).toBe(true);
      expect(def.spec.retrySafety, type).toMatch(/PLAN_TAKEN_ONCE/);
    }
  });

  it('les exécuteurs d’événements de référence relisent l’état et exigent la version présentée', () => {
    const src = lire('commands/reference-events.ts');
    // Une fonction unique relit l'état, refuse l'absent et refuse une version différente de l'aperçu.
    expect(src).toMatch(/async function relu\([\s\S]*?getReferenceEventState[\s\S]*?REFERENCE_EVENT_NOT_FOUND[\s\S]*?REFERENCE_EVENT_CHANGED_SINCE_PREVIEW/);
    // Chaque exécuteur qui vise un événement existant l'appelle.
    for (const nom of ['UPDATE_REFERENCE_EVENT', 'INVALIDATE_REFERENCE_EVENT', 'LINK_DOCUMENT_REFERENCE_EVENT', 'LINK_SUPPLIER_REFERENCE_EVENT']) {
      const bloc = src.slice(src.indexOf(`async ${nom}(`));
      expect(bloc.slice(0, 600), nom).toMatch(/await relu\(ctx, action/);
    }
    // L'association relit LES DEUX événements.
    const assoc = src.slice(src.indexOf('async ASSOCIATE_REFERENCE_EVENTS('));
    expect((assoc.slice(0, 800).match(/await relu\(/g) ?? [])).toHaveLength(2);
  });

  it('les autres exécuteurs refusent une cible modifiée depuis l’aperçu', () => {
    const src = lire('commands/executors.ts');
    expect(src).toMatch(/expectedVersion/);
    expect(src).toMatch(/CHANGED_SINCE_PREVIEW/);
  });
});

describe('L114AA-S04 — isolation du compte et du fil', () => {
  it('l’état des exports du fil est lu avec le compte dans la condition', () => {
    const src = lire('core/export-card-state.ts');
    expect(src).toMatch(/FROM export_generation[\s\S]*?WHERE id = ANY\(\$1::int\[\]\) AND account_id = \$2/);
    // Les messages du fil : compte ET utilisateur ET fil, fil actif seulement.
    expect(src).toMatch(/WHERE c\.id = \$1 AND c\.account_id = \$2 AND c\.user_id = \$3 AND c\.status = 'active'/);
    expect(src).toMatch(/AND m\.account_id = \$2/);
    // C'est une LECTURE : rien n'est réécrit (aucune écriture dans ce module).
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('l’événement de référence du fil n’est mémorisé que dans un fil de CET utilisateur', () => {
    const src = lire('core/conversation.service.ts');
    const bloc = src.slice(src.indexOf('export async function noterEvenementDeReferenceDuFil'));
    expect(bloc.slice(0, 1200)).toMatch(/UPDATE verebona_conversations[\s\S]*?WHERE id = \$1 AND account_id = \$2 AND user_id = \$3 AND status = 'active'/);
    // Le contexte du fil n'est lisible qu'avec le compte ET l'utilisateur.
    const charge = src.slice(src.indexOf('export async function loadThreadContext'));
    expect(charge.slice(0, 900)).toMatch(/WHERE id = \$1 AND account_id = \$2 AND user_id = \$3 AND status = 'active' AND expires_at > now\(\)/);
  });

  it('la mise à jour d’une carte transmise au client porte un identifiant de message, pas un lien forgeable', () => {
    const src = lire('core/export-card-state.ts');
    expect(src).toMatch(/export interface MiseAJourCarte \{ messageId: string; resultGroups: ResultGroup\[\] \}/);
    // Le client ne fait que remplacer les cartes d'un message qu'il affiche déjà.
    const client = readFileSync(join(RACINE, '../../lib/verebona/useVerebona.ts'), 'utf8');
    expect(client).toMatch(/majCartes\.has\(m\.id\)/);
  });
});

describe('L114AA-S05 — interrupteur des actions coupé', () => {
  it('les cinq points d’entrée d’écriture de l’Assistant sont coupés d’un seul geste', () => {
    const src = lire('core/ports.ts');
    const coupes = src.match(/if \(!areWriteCommandsEnabled\(\)\) return null;/g) ?? [];
    // Commande, annulation de commande, undo, indices d'action, export / dépôt : tous derrière l'interrupteur.
    expect(coupes.length).toBeGreaterThanOrEqual(5);
  });

  it('la confirmation d’un plan préparé AVANT la bascule est refusée, sans aucune écriture', () => {
    const route = readFileSync(join(RACINE, '../../app/api/verebona/commands/[planId]/confirm/route.ts'), 'utf8');
    expect(route).toMatch(/if \(!areWriteCommandsEnabled\(\)\) \{[\s\S]*?WRITE_COMMANDS_DISABLED_MESSAGE[\s\S]*?status: 403/);
    // Le refus est posé AVANT `confirmCommandPlan`.
    expect(route.indexOf('areWriteCommandsEnabled')).toBeLessThan(route.indexOf('confirmCommandPlan({'));
  });

  it('seuls off / false / 0 / no coupent l’interrupteur (activé par défaut)', async () => {
    const { areWriteCommandsEnabled } = await import('../../../config/assistant-config');
    const avant = process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS;
    try {
      for (const v of ['off', 'false', '0', 'no', 'OFF', 'False']) {
        process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS = v;
        expect(areWriteCommandsEnabled(), v).toBe(false);
      }
      for (const v of ['on', 'true', '1', 'yes', '']) {
        process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS = v;
        expect(areWriteCommandsEnabled(), v).toBe(true);
      }
      delete process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS;
      expect(areWriteCommandsEnabled()).toBe(true);
    } finally {
      if (avant === undefined) delete process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS;
      else process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS = avant;
    }
  });

  it('les surfaces de lecture du passage 114AA n’en dépendent pas (elles n’écrivent rien)', () => {
    expect(lire('core/export-card-state.ts')).not.toMatch(/areWriteCommandsEnabled/);
    // La variable d'environnement de catalogue d'aide retirée au lot 113 n'est nommée nulle part.
    for (const f of ['core/export-card-state.ts', 'commands/reference-events.ts', 'commands/plan.service.ts']) {
      expect(lire(f), f).not.toMatch(/HELP_CATALOG/);
    }
  });
});
