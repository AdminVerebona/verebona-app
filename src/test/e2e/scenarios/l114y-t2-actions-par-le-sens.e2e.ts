/**
 * Lot 114Y (Trello #753, CDC T2 §9.1, §9.3, annexe A13 — bloc PO n° 40) — ACTIONS COMPRISES PAR LE SENS, de bout en
 * bout sur PostgreSQL réel : `runAssistant` + ports réels, T2 en master, sortie UNDERSTAND rejouée par la vraie
 * passerelle (aucun réseau), plan figé réel, confirmation par identifiant de plan, écriture par le service de la fiche.
 *
 *   E01  tournure libre + `actionIntents` : plan À CONFIRMER (rien n'est écrit avant) ; après confirmation, le bien
 *        est renommé une seule fois ;
 *   E02  même phrase, sortie du prompt ACTUEL (sans `actionIntents`) : aucun plan — comportement inchangé ;
 *   E03  indice non pris en charge (pièce) ou bien introuvable : aucun plan, ou une question ; rien n'est écrit ;
 *   E04  EXPORT compris par le sens : génération directe par le service d'export, sans plan ;
 *   E05  deux comptes : l'indice ne trouve jamais le bien d'un autre compte.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
process.env.OVH_S3_ENDPOINT ??= 'https://s3.e2e.invalid';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/export-upload.service', async (o) => ({ ...(await o<object>()), uploadExportFile: async (_b: Buffer, key: string) => key }));
vi.mock('@/services/exports/export-support-notifier', () => ({ notifySupportOfExportFailure: async () => true }));

type Compte = { id: number; ownerUserId: number };
type Json = Record<string, any>;
const understand = (output: Record<string, unknown>) => ({
  operationCode: 't2_understand', task: 'UNDERSTAND',
  output: { mode: 'UNDERSTAND', intent: 'UNSUPPORTED_ACTION', confidence: 'exact', requestedFacts: [], requestedTopics: [], filters: {}, reason: 'e2e', ...output },
});
const LIBRE = 'La Clio devrait plutôt s’appeler Clio de Paul';

scenario('L114Y-SENS', 'Lot 114Y — actions comprises par le sens (champ actionIntents de la compréhension)', ({ sql, make, useRecordings }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });

  const compte = async (): Promise<Compte> => {
    const a = await make.account({ plan: 'premium' });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const bien = async (c: Compte, name: string) => {
    const b = await make.asset(c as never, { name, category: 'VEHICULE' });
    await sql`UPDATE assets SET status = 'EN_SERVICE', deleted_at = NULL WHERE id = ${b.id}`;
    return b.id as number;
  };
  const nom = async (id: number) => (await sql<Json[]>`SELECT name FROM assets WHERE id = ${id}`)[0].name as string;
  const plans = async (c: Compte) => Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM verebona_command_plans WHERE account_id = ${c.id}`)[0].n);
  const renommer = { operation: 'UPDATE', entityType: 'asset', targetHint: 'la Clio', fieldChanges: [{ fieldHint: 'nom', value: 'Clio de Paul', unit: null }], evidencePhrase: 'devrait plutôt s’appeler Clio de Paul' };

  it('E01 — tournure libre : plan à confirmer ; écrit seulement après confirmation, une seule fois', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    const replay = await useRecordings([understand({ interactionMode: 'ACTION_REQUEST', actionIntents: [renommer] })]);

    const r = await demander(c, LIBRE);
    expect(replay.calls.map((x) => x.task)).toEqual(['UNDERSTAND']);
    expect(r.commandPlan?.summary).toBe('Renommer le bien « Clio » en « Clio de Paul ». Confirmez-vous ?');
    expect(r.answer).toBe(r.commandPlan!.summary);
    expect(r.cascade?.intent).toBe('WRITE_COMMAND');
    // Rien n'est écrit avant la confirmation.
    expect(await nom(clio)).toBe('Clio');

    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    const ok = await confirmCommandPlan({ planId: r.commandPlan!.planId, accountId: c.id, userId: c.ownerUserId });
    expect(ok).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await nom(clio)).toBe('Clio de Paul');
    // Second envoi de la même confirmation : rien n'est rejoué.
    const encore = await confirmCommandPlan({ planId: r.commandPlan!.planId, accountId: c.id, userId: c.ownerUserId });
    expect(encore).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });
    expect(await nom(clio)).toBe('Clio de Paul');
  });

  it('E02 — sortie du prompt actuel (sans actionIntents) : aucun plan, comportement inchangé', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    await useRecordings([understand({ interactionMode: 'ACTION_REQUEST' })]);
    const r = await demander(c, LIBRE);
    expect(r.commandPlan ?? null).toBeNull();
    expect(await plans(c)).toBe(0);
    expect(await nom(clio)).toBe('Clio');
  });

  it('E03 — indice non pris en charge, ou bien introuvable : aucun plan ; rien n’est écrit', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    await useRecordings([understand({ interactionMode: 'ACTION_REQUEST', actionIntents: [{ operation: 'CREATE', entityType: 'room', targetHint: 'Cuisine', fieldChanges: [], evidencePhrase: null }] })]);
    const piece = await demander(c, 'Il faudrait que la maison ait aussi une cuisine dans sa liste');
    expect(piece.commandPlan ?? null).toBeNull();

    await useRecordings([understand({ interactionMode: 'ACTION_REQUEST', actionIntents: [{ ...renommer, targetHint: 'la Twingo' }] })]);
    const absent = await demander(c, 'La Twingo devrait plutôt s’appeler Clio de Paul');
    expect(absent.commandPlan ?? null).toBeNull();
    expect(absent.answer).toContain('Je n’ai pas trouvé ce bien dans votre compte.');
    expect(await plans(c)).toBe(0);
    expect(await nom(clio)).toBe('Clio');
  });

  it('E04 — EXPORT compris par le sens : génération directe, sans plan', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    await useRecordings([understand({
      interactionMode: 'ACTION_REQUEST',
      actionIntents: [{ operation: 'EXPORT', entityType: 'export', targetHint: 'la Clio', fieldChanges: [{ fieldHint: 'dossier', value: 'données brutes', unit: null }], evidencePhrase: null }],
    })]);
    const r = await demander(c, 'Il me faudrait une archive de tout ce que vous avez sur la Clio');
    expect(r.cascade?.intent).toBe('EXPORT_COMMAND');
    expect(r.answer).toBe('L’export « Export données brutes » de Clio est prêt. Il reste disponible 30 jours dans les exports de ce bien.');
    expect(r.commandPlan ?? null).toBeNull();
    const lignes = await sql<Json[]>`SELECT asset_id, export_type, status FROM export_generation WHERE account_id = ${c.id}`;
    expect(lignes).toEqual([{ asset_id: clio, export_type: 'EXPORT_BRUT', status: 'ready' }]);
    expect(await plans(c)).toBe(0);
  });

  it('E05 — deux comptes : l’indice ne trouve jamais le bien d’un autre compte', async () => {
    const a = await compte();
    const b = await compte();
    const clioB = await bien(b, 'Clio');
    await useRecordings([understand({ interactionMode: 'ACTION_REQUEST', actionIntents: [renommer] })]);
    const r = await demander(a, LIBRE);
    expect(r.commandPlan ?? null).toBeNull();
    expect(await plans(a)).toBe(0);
    expect(await nom(clioB)).toBe('Clio');
  });

});
