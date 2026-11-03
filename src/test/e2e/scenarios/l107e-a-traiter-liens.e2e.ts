/**
 * Lot 107E — « À traiter » : liens directs vers l'objet et les justificatifs,
 * sur PostgreSQL réel (file réelle `getToProcessPage`, route de revalidation
 * réelle, session simulée).
 *
 *   L107E-E2E-01 Draisienne : 69,99 € → la facture EXACTE (preuve T1 →
 *                document), 127,93 € (actuelle) → aucune source ; « Voir la
 *                fiche » du bien ; revalidation OK de la facture et du bien,
 *                refus d'un document du compte hors de la carte.
 *   L107E-E2E-02 deux sources distinctes : la valeur actuelle prend la facture
 *                de la dernière écriture appliquée ; une saisie humaine
 *                postérieure lui retire toute source (aucune preuve factice).
 *   L107E-E2E-03 plusieurs justificatifs (proposition et carte groupée) :
 *                chaque pièce exacte, liste bornée à la carte.
 *   L107E-E2E-04 document supprimé : état « plus disponible », refus au clic,
 *                aucune anomalie ; preuve disparue : anomalie Supervision.
 *   L107E-E2E-05 autre compte : route refusée (session d'un autre compte) ;
 *                preuve pointant vers un document étranger : jamais exposé,
 *                anomalie Supervision.
 *   L107E-E2E-06 Duo : bien transféré au partenaire — l'ancienne carte ne
 *                montre plus la facture ; le partenaire ne peut rien ouvrir
 *                par la carte de l'autre compte.
 *   L107E-E2E-07 aucune action au clic : la revalidation ne change ni la
 *                carte, ni le bien, ni le journal d'écriture.
 *   L107E-E2E-08 Agenda, événement de référence, statut d'un bien : liens
 *                vers l'événement exact (élément PRINCIPAL), document source
 *                de la proposition « c'est fait ».
 *   L107E-E2E-09 non-régression : choix d'une réponse → carte résolue, lien
 *                « déjà traitée » ; nouvelle décision T3 → liens recalculés à
 *                la lecture (cartes déjà ouvertes couvertes, sans migration).
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { uid } from '../factories';

const etat = vi.hoisted(() => ({ session: { userId: 0, currentAccountId: 0 as number | null } }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: etat.session.userId, currentAccountId: etat.session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));

scenario('L107E-LIENS', 'À traiter : liens directs vers l’objet et les justificatifs', ({ sql, make }) => {
  type Compte = Awaited<ReturnType<typeof make.account>>;

  beforeAll(async () => {
    (await import('@/services/to-process/card-links')).resetCardLinkAnomalyThrottle();
  });

  const facture = async (compte: Compte, assetId: number | null, titre: string, type = 'ACQUISITION_INVOICE') => {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${titre}, document_type_code = ${type}, upload_status = 'COMPLETED' WHERE id = ${f.id}`;
    return f.id;
  };
  const preuve = async (compte: Compte, assetId: number, fileId: number, valeur: number, sourceType = 'document') => (await sql<{ id: number }[]>`
    INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence, fingerprint, evidence_excerpt)
    VALUES (${compte.id}, ${assetId}, 'acquisitionPrice', ${JSON.stringify(valeur)}::jsonb, ${sourceType}, ${fileId}, 'certain', ${uid('fp')}, ${`Total ${valeur}`})
    RETURNING id`)[0].id;
  const cartePrix = async (compte: Compte, assetId: number, proposals: unknown[]) => (await sql<{ public_id: string }[]>`
    INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question, proposals_json, priority)
    VALUES (${compte.id}, 'ASSET', ${assetId}, 'acquisitionPrice', 'ARBITRATE', 'DATA-ACQUISITION-PRICE',
            'Quel est le prix d’acquisition de ce bien ?', ${JSON.stringify(proposals)}::jsonb, 'DO_NEXT')
    RETURNING public_id::text`)[0].public_id;
  const draisienne = async (compte: Compte) => {
    const bien = await make.asset(compte, { category: 'OBJET', name: 'Draisienne', purchasePriceCents: 12793 });
    const f1 = await facture(compte, bien.id, 'Facture Decathlon du 12/03/2024');
    const ev1 = await preuve(compte, bien.id, f1, 69.99);
    const publicId = await cartePrix(compte, bien.id, [
      { value: 69.99, label: '69.99', confidence: 0.6, evidenceIds: [String(ev1)] },
      { value: 127.93, label: '127.93', confidence: 1, isCurrentValue: true },
    ]);
    return { bien, f1, ev1, publicId };
  };
  const page = async (compte: Compte) => (await import('@/services/to-process/to-process-query.service')).getToProcessPage(compte.id, { withLinks: true });
  const carteVue = async (compte: Compte, publicId: string) => {
    const p = await page(compte);
    const c = p.actions.find((a) => a.publicId === publicId);
    expect(c, 'carte publiée').toBeTruthy();
    return c!;
  };
  const verifier = async (compte: Compte, publicId: string, target: { kind: string; id: number }) => {
    etat.session = { userId: compte.ownerUserId, currentAccountId: compte.id };
    const { POST } = await import('@/app/api/v2/to-process/[publicId]/links/route');
    const res = await POST(new NextRequest(`http://localhost/api/v2/to-process/${publicId}/links`, {
      method: 'POST', body: JSON.stringify({ target }), headers: { 'content-type': 'application/json' },
    }), { params: Promise.resolve({ publicId }) });
    return ((await res.json()) as { status?: string }).status;
  };
  /**
   * Donnée INCOHÉRENTE simulée : la base refuse les liens intercomptes
   * (déclencheurs CROSS_ACCOUNT_LINK) ; on les contourne le temps d'une
   * transaction pour prouver que la lecture, elle, ne fuit jamais.
   */
  const sansGardeFou = async (f: (tx: typeof sql) => Promise<unknown>) => sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await f(tx as unknown as typeof sql);
  });
  const anomalies = async (compte: Compte, code: string) => {
    // Les signalements partent sans retarder la file : on les attend ici.
    for (let i = 0; i < 20; i++) {
      const r = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_anomalies WHERE account_id = ${compte.id} AND fingerprint LIKE ${`other:a-traiter-liens:${code.toLowerCase()}:%`}`;
      if (r[0].n > 0) return r[0].n;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    return 0;
  };

  it('L107E-E2E-01 — Draisienne : « Voir la facture » ouvre la facture exacte de 69,99 € ; aucune source pour 127,93 € (actuelle)', async () => {
    const compte = await make.account();
    const { bien, f1, publicId } = await draisienne(compte);
    const autreDoc = await facture(compte, bien.id, 'Facture Decathlon (autre achat)');
    const c = await carteVue(compte, publicId);
    expect(c.links?.object).toMatchObject({ kind: 'asset', id: bien.id, label: 'Draisienne' });
    expect(c.links?.documents).toEqual([{ kind: 'document', id: f1, label: 'Facture Decathlon du 12/03/2024', invoice: true }]);
    expect(c.links?.proposals).toEqual([
      { documents: [f1], target: null, unavailable: 0 },
      { documents: [], target: null, unavailable: 0 },
    ]);
    expect(c.proposals[1]).toMatchObject({ isCurrentValue: true });
    // Aucune URL de stockage dans le contrat.
    expect(JSON.stringify(c.links)).not.toMatch(/https?:|e2e\//);
    expect(await verifier(compte, publicId, { kind: 'document', id: f1 })).toBe('ok');
    expect(await verifier(compte, publicId, { kind: 'asset', id: bien.id })).toBe('ok');
    // Un document du compte, mais pas une preuve de CETTE carte : refusé.
    expect(await verifier(compte, publicId, { kind: 'document', id: autreDoc })).toBe('gone');
  });

  it('L107E-E2E-02 — deux sources distinctes : chaque valeur la sienne ; saisie humaine postérieure → plus de source pour l’actuelle', async () => {
    const compte = await make.account();
    const { bien, f1, publicId } = await draisienne(compte);
    const f2 = await facture(compte, bien.id, 'Facture Vélo Store');
    await sql`INSERT INTO canonical_field_writes (account_id, asset_id, canonical_key, old_value, new_value, origin, source_type, source_id, outcome, created_at)
              VALUES (${compte.id}, ${bien.id}, 'acquisitionPrice', NULL, '127.93'::jsonb, 'RECONCILIATION', 'document', ${String(f2)}, 'written', now() - interval '2 days')`;
    let c = await carteVue(compte, publicId);
    expect(c.links?.proposals.map((p) => p.documents)).toEqual([[f1], [f2]]);
    // L'utilisateur ressaisit la même valeur à la main : elle n'a plus de justificatif.
    await sql`INSERT INTO canonical_field_writes (account_id, asset_id, canonical_key, old_value, new_value, origin, source_type, source_id, outcome)
              VALUES (${compte.id}, ${bien.id}, 'acquisitionPrice', '127.93'::jsonb, '127.93'::jsonb, 'USER', NULL, NULL, 'written')`;
    c = await carteVue(compte, publicId);
    expect(c.links?.proposals.map((p) => p.documents)).toEqual([[f1], []]);
  });

  it('L107E-E2E-03 — plusieurs justificatifs : chaque pièce exacte, liste limitée à la carte', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { name: 'Vélo cargo', purchasePriceCents: 250000 });
    const fa = await facture(compte, bien.id, 'Bon de commande', 'ACQUISITION_ORDER');
    const fb = await facture(compte, bien.id, 'Facture finale');
    const horsCarte = await facture(compte, bien.id, 'Facture sans rapport');
    const ea = await preuve(compte, bien.id, fa, 2600);
    const eb = await preuve(compte, bien.id, fb, 2600);
    const publicId = await cartePrix(compte, bien.id, [
      { value: 2600, label: '2600', confidence: 0.6, evidenceIds: [String(ea), String(eb)] },
      { value: 2500, label: '2500', confidence: 1, isCurrentValue: true },
    ]);
    const c = await carteVue(compte, publicId);
    expect(c.links?.proposals[0].documents.sort()).toEqual([fa, fb].sort());
    expect(c.links?.documents.map((d) => d.id)).not.toContain(horsCarte);
    expect(c.links?.documents.find((d) => d.id === fa)?.invoice).toBe(false);
    for (const id of [fa, fb]) expect(await verifier(compte, publicId, { kind: 'document', id })).toBe('ok');

    // Carte groupée 105D : périmètre exact (documents de la carte).
    const g1 = await facture(compte, null, 'Taxe foncière 2024', 'PROPERTY_TAX');
    const g2 = await facture(compte, null, 'Taxe foncière 2025', 'PROPERTY_TAX');
    const scope = { label: 'Logement du 3 rue des Lilas', documents: [{ id: g1, title: 'Taxe 2024', evidence: 'adresse' }, { id: g2, title: 'Taxe 2025', evidence: 'adresse' }], exceptions: [] };
    const [{ public_id: grp }] = await sql<{ public_id: string }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, relation_key, action_kind, rule_code, question, proposals_json, trigger_context)
      VALUES (${compte.id}, 'DOCUMENT', ${g1}, ${`group:${uid('g')}`}, 'ARBITRATE', 'LINK-ASSET-GROUP', 'Le logement est-il votre bien ?',
              ${JSON.stringify([{ value: `CONFIRM:${bien.id}`, label: 'Oui', confidence: 0.7 }, { value: 'REFUSE', label: 'Non', confidence: 0.3 }])}::jsonb,
              ${JSON.stringify({ scope, assetId: bien.id })}::jsonb)
      RETURNING public_id::text`;
    const p = await page(compte);
    const cg = p.actions.find((a) => a.publicId === grp);
    if (cg) {
      expect(cg.links?.object).toMatchObject({ kind: 'document', id: g1 });
      expect(cg.links?.cardDocuments).toEqual([g2]);
      expect(cg.links?.proposals[0].target).toMatchObject({ kind: 'asset', id: bien.id });
    } else {
      // Carte retenue par la publication (contexte e2e minimal) : liens calculés tels quels.
      const { resolveCardLinks } = await import('@/services/to-process/card-links');
      const l = (await resolveCardLinks(compte.id, [{ publicId: grp, ruleCode: 'LINK-ASSET-GROUP', actionKind: 'ARBITRATE', targetType: 'DOCUMENT', targetId: g1, fieldKey: null, relationKey: 'g',
        proposals: [{ value: `CONFIRM:${bien.id}`, label: 'Oui', confidence: 0.7 }], triggerContext: { scope, assetId: bien.id } }])).get(grp)!;
      expect(l.cardDocuments).toEqual([g2]);
      expect(l.proposals[0].target).toMatchObject({ kind: 'asset', id: bien.id });
    }
  });

  it('L107E-E2E-04 — document supprimé : état explicite, refus au clic, pas d’anomalie ; preuve disparue : anomalie Supervision', async () => {
    const compte = await make.account();
    const { f1, ev1, publicId } = await draisienne(compte);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f1}`;
    let c = await carteVue(compte, publicId);
    expect(c.links?.documents).toEqual([]);
    expect(c.links?.proposals[0]).toEqual({ documents: [], target: null, unavailable: 1 });
    expect(JSON.stringify(c.links)).not.toContain('Decathlon');
    expect(await verifier(compte, publicId, { kind: 'document', id: f1 })).toBe('gone');
    expect(await anomalies(compte, 'SOURCE_NOT_FOUND')).toBe(0);

    await sql`DELETE FROM field_evidence WHERE id = ${ev1}`;
    c = await carteVue(compte, publicId);
    expect(c.links?.proposals[0].unavailable).toBe(1);
    expect(await anomalies(compte, 'EVIDENCE_NOT_FOUND')).toBe(1);
  });

  it('L107E-E2E-05 — autre compte : route refusée, document étranger jamais exposé, anomalie tracée', async () => {
    const a = await make.account();
    const b = await make.account();
    const { f1, publicId, bien } = await draisienne(a);
    // Session du compte B sur la carte du compte A : rien (anti-énumération).
    expect(await verifier(b, publicId, { kind: 'document', id: f1 })).toBe('gone');
    expect(await verifier(b, publicId, { kind: 'asset', id: bien.id })).toBe('gone');
    // Donnée incohérente : preuve du compte A pointant vers un document de B.
    const fb = await facture(b, null, 'Facture privée du compte B');
    let evx = 0;
    await sansGardeFou(async (tx) => {
      [{ id: evx }] = await tx<{ id: number }[]>`
        INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence, fingerprint, evidence_excerpt)
        VALUES (${a.id}, ${bien.id}, 'acquisitionPrice', '80'::jsonb, 'document', ${fb}, 'certain', ${uid('fp')}, 'Total 80') RETURNING id`;
    });
    const pid = await cartePrix(a, (await make.asset(a, { name: 'Trottinette' })).id, [
      { value: 80, label: '80', confidence: 0.6, evidenceIds: [String(evx)] },
    ]);
    const { resolveCardLinks, resetCardLinkAnomalyThrottle } = await import('@/services/to-process/card-links');
    resetCardLinkAnomalyThrottle();
    const row = (await sql<Array<{ target_id: number }>>`SELECT target_id FROM to_process_actions WHERE public_id::text = ${pid}`)[0];
    const l = (await resolveCardLinks(a.id, [{ publicId: pid, ruleCode: 'DATA-ACQUISITION-PRICE', actionKind: 'ARBITRATE', targetType: 'ASSET', targetId: row.target_id, fieldKey: 'acquisitionPrice', relationKey: null,
      proposals: [{ value: 80, label: '80', confidence: 0.6, evidenceIds: [String(evx)] }], triggerContext: null }], { awaitReport: true })).get(pid)!;
    expect(JSON.stringify(l)).not.toMatch(new RegExp(`privée|"id":${fb}\\b`));
    expect(l.proposals[0].unavailable).toBe(1);
    expect(await verifier(a, pid, { kind: 'document', id: fb })).toBe('gone');
    expect(await anomalies(a, 'SOURCE_OTHER_ACCOUNT')).toBe(1);
    const [an] = await sql<Array<{ detail: string }>>`SELECT technical_detail::text AS detail FROM admin_anomalies WHERE account_id = ${a.id} AND fingerprint LIKE 'other:a-traiter-liens:source_other_account:%'`;
    expect(an.detail).not.toContain('privée');
  });

  it('L107E-E2E-06 — Duo : bien transféré au partenaire, aucune fuite par l’ancienne carte', async () => {
    const a = await make.account({ plan: 'premium_duo' });
    const b = await make.account({ plan: 'premium_duo' });
    const [{ id: duo }] = await sql<{ id: number }[]>`INSERT INTO duo_accounts (billing_owner_user_id, subscription_status) VALUES (${a.ownerUserId}, 'ACTIVE') RETURNING id`;
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, joined_at) VALUES (${duo}, ${a.ownerUserId}, 'ACTIVE', 0, now()), (${duo}, ${b.ownerUserId}, 'ACTIVE', 1, now())`;
    await sql`UPDATE accounts SET duo_account_id = ${duo} WHERE id IN (${a.id}, ${b.id})`;
    const { f1, publicId } = await draisienne(a);
    expect(await verifier(a, publicId, { kind: 'document', id: f1 })).toBe('ok');
    // Le partenaire Duo, dans SON compte, n'ouvre rien par la carte de A.
    expect(await verifier(b, publicId, { kind: 'document', id: f1 })).toBe('gone');
    // Le document passe dans le compte du partenaire (transfert de bien).
    await sansGardeFou((tx) => tx`UPDATE asset_files SET account_id = ${b.id}, asset_id = NULL, user_id = ${b.ownerUserId} WHERE id = ${f1}`);
    const c = await carteVue(a, publicId);
    expect(c.links?.documents).toEqual([]);
    expect(c.links?.proposals[0].unavailable).toBe(1);
    expect(await verifier(a, publicId, { kind: 'document', id: f1 })).toBe('gone');
    // La file du partenaire ne montre aucune carte de A.
    expect((await page(b)).actions.some((x) => x.publicId === publicId)).toBe(false);
  });

  it('L107E-E2E-07 — aucune action au clic : carte, bien et journal inchangés', async () => {
    const compte = await make.account();
    const { bien, f1, publicId } = await draisienne(compte);
    const avant = await sql`SELECT resolved_at, proposals_json::text, last_seen_at, updated_at FROM to_process_actions WHERE public_id::text = ${publicId}`;
    const bienAvant = await sql`SELECT purchase_price_cents, key_characteristics::text, updated_at FROM assets WHERE id = ${bien.id}`;
    const [{ n: writesAvant }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM canonical_field_writes WHERE asset_id = ${bien.id}`;
    for (let i = 0; i < 3; i++) {
      expect(await verifier(compte, publicId, { kind: 'document', id: f1 })).toBe('ok');
      expect(await verifier(compte, publicId, { kind: 'asset', id: bien.id })).toBe('ok');
    }
    await page(compte);
    expect(await sql`SELECT resolved_at, proposals_json::text, last_seen_at, updated_at FROM to_process_actions WHERE public_id::text = ${publicId}`).toEqual(avant);
    expect(await sql`SELECT purchase_price_cents, key_characteristics::text, updated_at FROM assets WHERE id = ${bien.id}`).toEqual(bienAvant);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM canonical_field_writes WHERE asset_id = ${bien.id}`)[0].n).toBe(writesAvant);
  });

  it('L107E-E2E-08 — Agenda et événement de référence : l’événement exact, la source de « c’est fait »', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { name: 'Chaudière' });
    const item = await make.agendaItem(compte, { title: 'Entretien chaudière', startDate: '2026-09-15', assetIds: [bien.id] });
    const rapport = await facture(compte, bien.id, 'Rapport d’entretien', 'MAINTENANCE_REPORT');
    const { agendaStatusProposals, agendaStatusTriggerContext } = await import('@/services/to-process/agenda-status-cards');
    const [{ public_id: done }] = await sql<{ public_id: string }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question, proposals_json, trigger_context)
      VALUES (${compte.id}, 'AGENDA_ITEM', ${item.id}, 'manualStatus', 'ARBITRATE', 'AGENDA-DONE', 'Cet entretien a-t-il été réalisé ?',
              ${JSON.stringify(agendaStatusProposals('propose_done', rapport))}::jsonb, ${JSON.stringify(agendaStatusTriggerContext(item.id, 'propose_done', rapport))}::jsonb)
      RETURNING public_id::text`;
    const { resolveCardLinks } = await import('@/services/to-process/card-links');
    const { selectDisplayedProposals } = await import('@/services/to-process/action-model');
    const lire = async (publicId: string) => {
      const [r] = await sql<Array<Record<string, any>>>`SELECT * FROM to_process_actions WHERE public_id::text = ${publicId}`;
      return (await resolveCardLinks(compte.id, [{ publicId, ruleCode: r.rule_code, actionKind: r.action_kind, targetType: r.target_type, targetId: r.target_id,
        fieldKey: r.field_key, relationKey: r.relation_key, proposals: selectDisplayedProposals(r.proposals_json ?? []), triggerContext: r.trigger_context }])).get(publicId)!;
    };
    const l1 = await lire(done);
    expect(l1.object).toMatchObject({ kind: 'echeance', id: item.id, label: 'Entretien chaudière' });
    expect(l1.proposals.map((p) => p.documents)).toEqual([[rapport], []]);
    expect(await verifier(compte, done, { kind: 'echeance', id: item.id })).toBe('ok');

    // Événement de référence : élément PRINCIPAL de la réalité.
    const [{ id: op }] = await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, status) VALUES (${compte.id}, 'REALIZED') RETURNING id`;
    const principal = await make.agendaItem(compte, { title: 'Sinistre dégât des eaux', startDate: '2026-02-01', assetIds: [bien.id] });
    // Rattachement puis rôle (le déclencheur 0652 ne laisse pas hériter un principal par déplacement).
    await sql`UPDATE agenda_items SET business_operation_id = ${op} WHERE id = ${principal.id}`;
    await sql`UPDATE agenda_items SET operation_role = 'PRINCIPAL', operation_role_origin = 'USER' WHERE id = ${principal.id}`;
    const f = await facture(compte, bien.id, 'Devis réparation', 'REPAIR_QUOTE');
    const [{ public_id: montant }] = await sql<{ public_id: string }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, relation_key, action_kind, rule_code, question, proposals_json, trigger_context)
      VALUES (${compte.id}, 'DOCUMENT', ${f}, ${`operationAmount:${op}:e2e`}, 'ARBITRATE', 'OPERATION-AMOUNT', 'Quel montant retenir ?',
              ${JSON.stringify([{ value: 'AMOUNT:1000:EUR', label: '10,00 €', confidence: 0.6 }])}::jsonb, ${JSON.stringify({ operationId: op })}::jsonb)
      RETURNING public_id::text`;
    const l2 = await lire(montant);
    expect(l2.object).toMatchObject({ kind: 'document', id: f, invoice: false });
    expect(l2.related).toEqual([{ kind: 'reference', id: principal.id, label: 'Sinistre dégât des eaux' }]);
    expect(await verifier(compte, montant, { kind: 'reference', id: principal.id })).toBe('ok');
    // Un autre élément d'agenda du compte n'est pas une destination de cette carte.
    expect(await verifier(compte, montant, { kind: 'reference', id: item.id })).toBe('gone');

    // Statut d'un bien proposé par T4 : « Voir l'événement » qui le justifie.
    const [{ public_id: statut }] = await sql<{ public_id: string }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question, proposals_json, trigger_context)
      VALUES (${compte.id}, 'ASSET', ${bien.id}, 'status', 'ARBITRATE', 'ASSET-STATUS', 'Ce bien est-il vendu ?',
              ${JSON.stringify([{ value: 'VENDU', label: 'Vendu', confidence: 0.6, sourceContext: { label: 'Entretien' } }])}::jsonb,
              ${JSON.stringify({ businessType: 'SALE', agendaItemId: item.id })}::jsonb)
      RETURNING public_id::text`;
    const l3 = await lire(statut);
    expect(l3.object).toMatchObject({ kind: 'asset', id: bien.id });
    expect(l3.related).toEqual([{ kind: 'echeance', id: item.id, label: 'Entretien chaudière' }]);
  });

  it('L107E-E2E-09 — non-régression : réponse choisie → carte résolue ; décision T3 nouvelle → liens recalculés', async () => {
    const compte = await make.account();
    const { bien, f1, publicId } = await draisienne(compte);
    // Nouvelle décision T3 sur la carte déjà ouverte : nouvelle preuve, nouvelle facture.
    const f3 = await facture(compte, bien.id, 'Facture corrigée');
    const ev3 = await preuve(compte, bien.id, f3, 74.5);
    await sql`UPDATE to_process_actions SET proposals_json = ${JSON.stringify([
      { value: 74.5, label: '74.5', confidence: 0.6, evidenceIds: [String(ev3)] },
      { value: 127.93, label: '127.93', confidence: 1, isCurrentValue: true },
    ])}::jsonb WHERE public_id::text = ${publicId}`;
    const c = await carteVue(compte, publicId);
    expect(c.links?.proposals[0].documents).toEqual([f3]);
    expect(await verifier(compte, publicId, { kind: 'document', id: f1 })).toBe('gone');
    expect(await verifier(compte, publicId, { kind: 'document', id: f3 })).toBe('ok');
    // L'utilisateur choisit 74,50 € : la carte se ferme, la revalidation le dit.
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    const r = await resolveArbitration(compte.id, publicId, 74.5, { userId: compte.ownerUserId } as never);
    expect(r).toMatchObject({ ok: true });
    expect((await page(compte)).actions.some((a) => a.publicId === publicId)).toBe(false);
    expect(await verifier(compte, publicId, { kind: 'document', id: f3 })).toBe('resolved');
  });
});
