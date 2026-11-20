/**
 * Carte Trello #806, volet B §12 — EXPORTS : complément de PREUVE (AC69 ; CDC « Opérations / Agenda V2.0 » §18, §19).
 * Le volet sécurité (comptes, Duo, relations) est prouvé par `l116c-exports-relations-securite.e2e.ts` ; ce fichier
 * prouve ce qui restait : dossiers MULTI-BIENS, TOTAUX sans double compte, export demandé depuis l'ASSISTANT et
 * contenu réel de l'archive ZIP. Sur PostgreSQL 16 réel, par les chemins de PRODUCTION : source des dossiers
 * (`loadExportSource`), vraie route `POST /api/assets/:id/exports`, Assistant (`runAssistant` et ses ports réels,
 * façade d'export partagée avec la route). Seuls la session et le DÉPÔT du fichier sont simulés : l'archive est
 * réellement construite, puis relue ici. Aucune IA.
 *
 *   L116CB-X05  MULTI-BIENS : une opération qui concerne deux biens, un justificatif rattaché à un seul, un événement
 *               de l'Agenda lié aux deux, un justificatif partagé entre deux opérations — chaque dossier de chaque
 *               bien contient SES pièces et SES événements, chacun UNE fois ; l'événement commun figure une fois dans
 *               chaque dossier, à sa date ; rien du second bien n'entre dans le premier par l'opération commune
 *   L116CB-X06  TOTAUX : les montants portés par un dossier sont ceux de ses pièces et de ses événements, chacun UNE
 *               fois — un justificatif partagé entre deux opérations n'y pèse qu'une fois ; l'indemnité du sinistre
 *               est dite une fois ; associer des opérations ne change aucun montant du dossier
 *   L116CB-X07  ASSISTANT et ARCHIVE : « Exporte les données brutes de … » produit la MÊME archive que la route de
 *               l'écran (mêmes entrées) ; son récapitulatif cite chaque pièce une seule fois ; aucune pièce d'une
 *               opération associée portée par un autre bien, ni d'un autre compte ; le bien d'un autre compte est
 *               introuvable. LIMITE : le stockage objet est simulé — les fichiers binaires des pièces ne sont pas
 *               téléchargés dans l'atelier ; la preuve porte sur les entrées et le récapitulatif de l'archive.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { scenario } from '../scenario';
import { demander } from '../chain';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';
import type { DossierCode } from '@/services/exports/catalog';

// Stockage objet : configuration factice (aucun appel réseau — seul le dépôt de l'archive est simulé).
process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
process.env.OVH_S3_ENDPOINT ??= 'https://s3.e2e.invalid';

const h = vi.hoisted(() => ({ depots: [] as Array<{ key: string; buffer: Buffer }>, session: { currentAccountId: 0, userId: 0 } }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/export-upload.service', async (o) => ({
  ...(await o<object>()),
  uploadExportFile: async (buffer: Buffer, key: string) => { h.depots.push({ key, buffer: Buffer.from(buffer) }); return key; },
}));
vi.mock('@/services/exports/export-support-notifier', () => ({ notifySupportOfExportFailure: async () => true }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: h.session.userId, currentAccountId: h.session.currentAccountId }),
    tryGetSession: async () => ({ userId: h.session.userId, currentAccountId: h.session.currentAccountId }),
    requireAdmin: async () => h.session.userId,
    handleSessionError: (e: unknown) => { throw e; },
  },
}));

type Json = Record<string, any>;
const DOSSIERS: DossierCode[] = ['VENTE', 'ASSURANCE_SOUSCRIPTION', 'DOSSIER_COMPLET'];
const facade = () => import('@/services/business-operations/operation-write.facade');

scenario('L116CB-X', 'Opérations / Agenda #806 volet B §12 — exports : multi-biens, totaux, Assistant, archive (AC69)', ({ sql, make }) => {
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });
  const asUser = (c: AccountRow) => { h.session.currentAccountId = c.id; h.session.userId = c.ownerUserId; };

  async function operation(compte: AccountRow, type: string, over: { label?: string; realized?: string; assetIds?: number[] } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: { code: type } as never, status: over.realized ? 'REALIZED' : 'ENVISAGED', realizedDate: over.realized ?? null, technicalLabel: over.label ?? null,
      source: { kind: 'MIGRATION', entityKey: `l116cb-x-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' },
      assets: (over.assetIds ?? []).map((assetId) => ({ assetId, authority: 'STRUCTURED' as const })),
      reasonCode: 'L116CB_X_E2E',
    })).id);
  }
  async function piece(compte: AccountRow, assetId: number | null, titre: string, montant: number | null, type = 'MAINTENANCE_INVOICE'): Promise<number> {
    const f = await make.assetFile(compte, { assetId, name: `${titre}.pdf` });
    await sql`UPDATE asset_files SET retained_title = ${titre}, document_date = '2025-04-03', document_type_code = ${type}, amount_cents = ${montant}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    return f.id;
  }
  async function evenement(compte: AccountRow, title: string, date: string, assetIds: number[]): Promise<number> {
    const i = await make.agendaItem(compte, { title, startDate: date, assetIds });
    await sql`UPDATE agenda_items SET event_nature = 'HISTORICAL', business_type = 'MAINTENANCE' WHERE id = ${i.id}`;
    return i.id;
  }
  const lierDoc = async (compte: AccountRow, operationId: number, fileId: number) =>
    expect(await (await facade()).linkDocument(user(compte), { operationId, fileId })).toMatchObject({ status: 'APPLIED' });
  const lierEvt = async (compte: AccountRow, operationId: number, agendaItemId: number) =>
    expect(await (await facade()).linkAgendaItem(user(compte), { operationId, agendaItemId })).toMatchObject({ status: 'APPLIED' });
  const source = async (compte: AccountRow, assetId: number, exportType: DossierCode, claimOperationId?: number) => {
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    return loadExportSource({ assetId, accountId: compte.id, userId: compte.ownerUserId, exportType, ...(claimOperationId ? { claimOperationId } : {}) });
  };
  type Source = Awaited<ReturnType<typeof source>>;
  /** Ce que le dossier CONTIENT et ce qu'il PÈSE : pièces, événements, montants — sans l'horodatage de trace. */
  const contenu = (src: Source): Json => ({
    documents: src.documents.map((d) => d.id).sort((a, b) => a - b),
    events: src.events.map((e) => e.key).sort(),
    montantPieces: src.documents.reduce((t, d) => t + (d.amountCents ?? 0), 0),
    montantEvenements: src.events.reduce((t, e) => t + (e.costCents ?? 0), 0),
    claimDocuments: [...(src.claimFile?.documentIds ?? [])].sort((a, b) => a - b),
    indemnite: src.claimFile?.compensationCents ?? null,
  });
  const sansDoublon = (xs: readonly (string | number)[]) => expect(new Set(xs).size).toBe(xs.length);
  async function entrees(buffer: Buffer): Promise<{ noms: string[]; texte: string }> {
    const zip = await JSZip.loadAsync(buffer);
    const noms = Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name).sort();
    let texte = '';
    for (const n of noms) if (/\.(json|csv|txt|md|html)$/i.test(n)) texte += `\n${await zip.files[n].async('string')}`;
    return { noms, texte };
  }
  async function exporterParLaRoute(assetId: number): Promise<Json> {
    const { POST } = await import('@/app/api/assets/[id]/exports/route');
    const res = await POST(new NextRequest(`https://app.e2e.verebona.test/api/assets/${assetId}/exports`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.e2e.verebona.test' },
      body: JSON.stringify({ exportType: 'EXPORT_BRUT', requestedOutputs: ['ZIP'] }),
    }), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Json };
  }

  /** Deux biens, une opération COMMUNE aux deux, une opération propre à chacun, des partages et des relations. */
  async function monter() {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison des Lilas' });
    const garage = await make.asset(compte, { category: 'IMMOBILIER', name: 'Garage du port' });
    for (const b of [maison, garage]) await sql`UPDATE assets SET status = 'EN_SERVICE', deleted_at = NULL WHERE id = ${b.id}`;
    // SINISTRE commun aux deux biens (tempête) : sa déclaration est rattachée à la maison, son expertise concerne les deux.
    const tempete = await operation(compte, 'CLAIM', { label: 'Tempête de mars', realized: '2025-03-20', assetIds: [maison.id, garage.id] });
    const declaration = await piece(compte, maison.id, 'Declaration tempete 806X', null, 'CLAIM_DECLARATION');
    await lierDoc(compte, tempete, declaration);
    const expertise = await evenement(compte, 'Expertise commune 806X', '2025-03-28', [maison.id, garage.id]);
    await lierEvt(compte, tempete, expertise);
    // RÉPARATIONS propres à chaque bien ; la facture de la maison est PARTAGÉE avec le sinistre.
    const toiture = await operation(compte, 'INTERVENTION', { label: 'Toiture de la maison', realized: '2025-04-10', assetIds: [maison.id] });
    const factureMaison = await piece(compte, maison.id, 'Facture toiture maison 806X', 240_000);
    await lierDoc(compte, toiture, factureMaison);
    await lierDoc(compte, tempete, factureMaison);
    const chantierMaison = await evenement(compte, 'Chantier toiture maison 806X', '2025-04-10', [maison.id]);
    await lierEvt(compte, toiture, chantierMaison);
    const porte = await operation(compte, 'INTERVENTION', { label: 'Porte du garage', realized: '2025-04-12', assetIds: [garage.id] });
    const factureGarage = await piece(compte, garage.id, 'Facture porte garage 806X', 90_000);
    await lierDoc(compte, porte, factureGarage);
    const chantierGarage = await evenement(compte, 'Chantier porte garage 806X', '2025-04-12', [garage.id]);
    await lierEvt(compte, porte, chantierGarage);
    // ASSURANCE de la maison : sa police n'est rattachée à AUCUN bien (seule l'opération la porte).
    const assurance = await operation(compte, 'CONTRACT', { label: 'Assurance habitation', assetIds: [maison.id] });
    const police = await piece(compte, null, 'Police confidentielle 806X', 42_000, 'INSURANCE_POLICY');
    await lierDoc(compte, assurance, police);
    return { compte, maison, garage, tempete, toiture, porte, assurance, declaration, factureMaison, factureGarage, police, expertise, chantierMaison, chantierGarage };
  }

  it('L116CB-X05 — multi-biens : chaque dossier de chaque bien contient ses pièces et ses événements une fois ; l’événement commun une fois dans chacun ; rien ne passe par l’opération commune', async () => {
    const m = await monter();
    const f = await facade();
    for (const [de, vers, nature] of [[m.tempete, m.toiture, 'CLAIM_REPAIR'], [m.tempete, m.porte, 'CLAIM_REPAIR'], [m.tempete, m.assurance, 'ASSOCIATED']] as const) {
      expect(await f.associateOperations(user(m.compte), { fromOperationId: de, toOperationId: vers, nature })).toMatchObject({ status: 'APPLIED' });
    }
    for (const code of DOSSIERS) {
      const maison = await source(m.compte, m.maison.id, code);
      const garage = await source(m.compte, m.garage.id, code);
      // Chaque pièce et chaque événement UNE fois par dossier.
      for (const src of [maison, garage]) { sansDoublon(src.documents.map((d) => d.id)); sansDoublon(src.events.map((e) => e.key)); }
      // La maison : sa déclaration et sa facture ; jamais la facture du garage, jamais la police portée par l'opération associée.
      const docsMaison = maison.documents.map((d) => d.id);
      expect(docsMaison, code).toEqual(expect.arrayContaining([m.declaration, m.factureMaison]));
      for (const interdit of [m.factureGarage, m.police]) expect(docsMaison, `${code} maison`).not.toContain(interdit);
      // Le garage : sa facture ; jamais les pièces de la maison, même si le sinistre commun les porte.
      const docsGarage = garage.documents.map((d) => d.id);
      expect(docsGarage, code).toContain(m.factureGarage);
      for (const interdit of [m.declaration, m.factureMaison, m.police]) expect(docsGarage, `${code} garage`).not.toContain(interdit);
      // L'événement commun aux deux biens : une fois dans CHAQUE dossier, à SA date ; les chantiers restent chez leur bien.
      const texteMaison = JSON.stringify(maison);
      const texteGarage = JSON.stringify(garage);
      expect(maison.events.filter((e) => JSON.stringify(e).includes('Expertise commune 806X')), `${code} maison`).toHaveLength(1);
      expect(garage.events.filter((e) => JSON.stringify(e).includes('Expertise commune 806X')), `${code} garage`).toHaveLength(1);
      expect(JSON.stringify(maison.events.find((e) => JSON.stringify(e).includes('Expertise commune 806X')))).toContain('2025-03-28');
      expect(texteMaison).not.toContain('Chantier porte garage 806X');
      expect(texteGarage).not.toContain('Chantier toiture maison 806X');
      expect(texteGarage).not.toContain('Police confidentielle 806X');
    }
    // Dossier « Assurance — sinistre » du sinistre COMMUN, vu de chaque bien : ses pièces une fois, sans la police associée.
    for (const bien of [m.maison, m.garage]) {
      const sinistre = await source(m.compte, bien.id, 'ASSURANCE_SINISTRE', m.tempete);
      sansDoublon(sinistre.claimFile?.documentIds ?? []);
      expect(sinistre.claimFile?.documentIds ?? []).not.toContain(m.police);
      expect(JSON.stringify(sinistre)).not.toContain('Police confidentielle 806X');
    }
  }, 180000);

  it('L116CB-X06 — totaux : chaque montant d’un dossier une seule fois ; associer des opérations ne change aucun montant', async () => {
    const m = await monter();
    const releve = async () => {
      const out: Json = {};
      for (const code of DOSSIERS) {
        out[`maison:${code}`] = contenu(await source(m.compte, m.maison.id, code));
        out[`garage:${code}`] = contenu(await source(m.compte, m.garage.id, code));
      }
      out['maison:SINISTRE'] = contenu(await source(m.compte, m.maison.id, 'ASSURANCE_SINISTRE', m.tempete));
      return out;
    };
    const avant = await releve();
    // La facture de la maison est partagée entre le sinistre et la réparation : elle pèse UNE fois (2 400 €) dans le
    // dossier de la maison ; la facture du garage (900 €) n'y pèse jamais ; la police (420 €) non plus.
    expect(avant['maison:DOSSIER_COMPLET'].montantPieces).toBe(240_000);
    expect(avant['garage:DOSSIER_COMPLET'].montantPieces).toBe(90_000);
    expect(avant['maison:SINISTRE'].claimDocuments.filter((id: number) => id === m.factureMaison)).toHaveLength(1);

    // Indemnité du sinistre : enregistrée une fois, dite une fois, quel que soit le nombre de biens et de relations.
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(m.compte.id, async (repo) => {
      const [src] = await sql<{ id: number }[]>`SELECT id::int AS id FROM business_operation_sources WHERE operation_id = ${m.tempete} AND active ORDER BY id LIMIT 1`;
      await repo.addFinancialComponent(m.tempete, {
        kind: 'INDEMNITY', amountMinor: 150_000, currency: 'EUR', amountEurCents: 150_000, economicDate: '2025-05-02', targetAssetId: null,
        sources: [{ sourceId: src.id }], fingerprint: 'l116cb-x06-indemnite',
      } as never, 'L116CB_X_E2E');
    });
    const avecIndemnite = await releve();
    const indemniteAvant = avecIndemnite['maison:SINISTRE'].indemnite;

    // RELATIONS : sinistre ↔ réparations des deux biens, sinistre ↔ assurance. Aucun montant ne bouge, nulle part.
    const f = await facade();
    for (const [de, vers, nature] of [[m.tempete, m.toiture, 'CLAIM_REPAIR'], [m.tempete, m.porte, 'CLAIM_REPAIR'], [m.tempete, m.assurance, 'ASSOCIATED'], [m.toiture, m.porte, 'ASSOCIATED']] as const) {
      expect(await f.associateOperations(user(m.compte), { fromOperationId: de, toOperationId: vers, nature })).toMatchObject({ status: 'APPLIED' });
    }
    const apres = await releve();
    expect(apres).toEqual(avecIndemnite);
    expect(apres['maison:SINISTRE'].indemnite).toBe(indemniteAvant);
    // Les montants des dossiers ordinaires ne dépendent d'aucune opération : ils sont ceux d'avant l'indemnité et les relations.
    for (const cle of Object.keys(avant).filter((k) => !k.endsWith('SINISTRE'))) expect(apres[cle], cle).toEqual(avant[cle]);
  }, 180000);

  it('L116CB-X07 — l’Assistant produit la même archive que l’écran ; chaque fichier une fois ; aucune pièce d’une opération associée d’un autre bien ni d’un autre compte', async () => {
    const m = await monter();
    const autre = await make.account({ plan: 'premium' });
    const bienAutre = await make.asset(autre, { category: 'IMMOBILIER', name: 'Maison des Lilas' });
    await sql`UPDATE assets SET status = 'EN_SERVICE', deleted_at = NULL WHERE id = ${bienAutre.id}`;
    const pieceAutre = await piece(autre, bienAutre.id, 'Piece autre compte 806X', 11_000);
    const f = await facade();
    for (const [de, vers, nature] of [[m.tempete, m.toiture, 'CLAIM_REPAIR'], [m.tempete, m.porte, 'CLAIM_REPAIR'], [m.tempete, m.assurance, 'ASSOCIATED']] as const) {
      expect(await f.associateOperations(user(m.compte), { fromOperationId: de, toOperationId: vers, nature })).toMatchObject({ status: 'APPLIED' });
    }
    asUser(m.compte);

    // 1. Depuis l'ÉCRAN (vraie route).
    h.depots = [];
    const ecran = await exporterParLaRoute(m.maison.id);
    expect(ecran.status, JSON.stringify(ecran.body)).toBe(200);
    expect(h.depots).toHaveLength(1);
    const archiveEcran = await entrees(h.depots[0].buffer);
    // 2. Depuis l'ASSISTANT (génération directe, sans plan ni confirmation, aucun appel d'IA).
    h.depots = [];
    const r = await demander({ id: m.compte.id, ownerUserId: m.compte.ownerUserId }, 'Exporte les données brutes de la Maison des Lilas', { planType: 'PREMIUM' });
    expect(r.error ?? null).toBeNull();
    expect(r.cascade?.intent).toBe('EXPORT_COMMAND');
    expect(r.cascade?.aiCalls ?? 0).toBe(0);
    expect(h.depots).toHaveLength(1);
    const archiveAssistant = await entrees(h.depots[0].buffer);

    // MÊME archive : les mêmes entrées, dans les deux parcours.
    expect(archiveAssistant.noms).toEqual(archiveEcran.noms);
    expect(archiveEcran.noms.length).toBeGreaterThan(0);
    // Chaque fichier UNE fois (la facture partagée entre le sinistre et la réparation n'a qu'une entrée).
    sansDoublon(archiveEcran.noms);
    for (const archive of [archiveEcran, archiveAssistant]) {
      const tout = `${archive.noms.join('\n')}\n${archive.texte}`;
      // Les pièces de la maison y sont ; la pièce du garage, la police de l'opération associée et la pièce de l'autre compte n'y sont pas.
      expect(tout).toContain('Facture toiture maison 806X');
      for (const interdit of ['Facture porte garage 806X', 'Police confidentielle 806X', 'Piece autre compte 806X', 'Chantier porte garage 806X']) {
        expect(tout.includes(interdit), interdit).toBe(false);
      }
      // Le récapitulatif de l'archive cite chaque pièce de la maison UNE fois — la facture partagée entre le sinistre
      // et la réparation n'y est pas listée deux fois.
      for (const titre of ['Facture toiture maison 806X', 'Declaration tempete 806X']) expect(archive.texte.split(titre).length - 1, titre).toBe(1);
    }
    // Deux générations dans l'historique du compte, aucune dans celui de l'autre ; le bien de l'autre compte est introuvable.
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM export_generation WHERE account_id = ${m.compte.id}`)[0].n).toBe(2);
    h.depots = [];
    expect((await exporterParLaRoute(bienAutre.id)).status).not.toBe(200);
    expect(h.depots).toHaveLength(0);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM export_generation WHERE account_id = ${autre.id}`)[0].n).toBe(0);
    expect(pieceAutre).toBeGreaterThan(0);
  }, 240000);
});
