/**
 * Passage 114AB (Trello #753) — GESTES INVERSES sur les ÉVÉNEMENTS DE RÉFÉRENCE.
 *
 * Le point d'écriture de la carte #744 sait déjà les faire ; ils n'étaient pas exposés à l'Assistant. Ce ne
 * sont pas des capacités W du CDC : ce sont les inverses de W23 à W26, plus le rattachement d'une échéance.
 *
 *   I01  phrases reconnues ; non-régression des gestes DIRECTS et des autres analyseurs ;
 *   I02  aperçus : ce qui est conservé est dit, jamais le mot interdit ;
 *   I03  jamais un choix au hasard : introuvable, ambigu, même événement deux fois ;
 *   I04  rétablir : seules les suppressions de l'utilisateur sont lues, et aucune autre ;
 *   I05  exécution : aucune écriture propre — la façade de #744, l'état relu, les textes des résultats ;
 *   I06  catalogue fermé : fiche de chaque commande, service nommé.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { parseCommand } = await import('../../parser');
const { resolveDraft, documentVersion } = await import('../../plan.service');
const { WRITE_COMMAND_CATALOG } = await import('../../catalog');
const { isReferenceEventCommand } = await import('../../reference-events');
type Lookup = import('../../plan.service').CommandLookup;
type Doc = import('../../plan.service').DocumentState;
type Etat = import('../../reference-event-model').ReferenceEventState;
type Agenda = import('../../plan.service').AgendaCandidate;

const TODAY = '2026-11-13';
const input = { accountId: 1, userId: 2, planType: 'PREMIUM', message: '', clientRequestId: 'x', locale: 'fr-FR' } as never;
const sansAccent = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const evenement = (over: Partial<Etat> = {}): Etat => ({
  id: 500, typeCode: 'INTERVENTION', status: 'REALIZED', label: 'Intervention — Vidange', technicalLabel: 'Vidange',
  provider: null, plannedDate: null, startDate: null, realizedDate: '2025-03-12', endDate: null,
  assets: [{ id: 7, name: 'Clio' }], documentTitles: [], version: 3, ...over,
});
const VIDANGE = evenement();
const PRET = evenement({ id: 501, typeCode: 'FINANCING', label: 'Financement — Prêt auto', technicalLabel: 'Prêt auto', realizedDate: null, startDate: '2021-05-03', assets: [] });
const ACHAT = evenement({ id: 502, typeCode: 'ACQUISITION', label: 'Achat — Achat de la voiture', technicalLabel: 'Achat de la voiture', realizedDate: '2021-05-03' });
const SUPPRIME = evenement({ id: 600, version: 9, invalidated: true });

const doc = (id: number, title: string): Doc => {
  const b = { id, title, documentDate: '2026-03-10', notesShown: '' };
  return { ...b, originalFilename: `${title}.pdf`, notesUserOwned: false, isWebLink: false, webLinkUrl: null, assetLabel: null, rubricCode: null, documentTypeCode: null, version: documentVersion(b) };
};
const NORAUTO = doc(33, 'Facture Norauto');
const ECHEANCE: Agenda = { id: 90, title: 'Vidange', startDate: '2027-03-12', version: 'av1', seriesCount: 1, assetLabel: 'Clio' };

const lookup = (o: { actifs?: Etat[]; supprimes?: Etat[]; echeances?: Agenda[] } = {}): Lookup => {
  const actifs = o.actifs ?? [VIDANGE];
  const supprimes = o.supprimes ?? [SUPPRIME];
  const repond = (s: Etat, q: { typeCode: string | null; words: string[]; date: string | null }) => {
    if (q.typeCode && s.typeCode !== q.typeCode) return false;
    if (q.date && ![s.realizedDate, s.startDate, s.plannedDate, s.endDate].includes(q.date)) return false;
    const texte = sansAccent([s.technicalLabel, s.provider, ...s.assets.map((a) => a.name)].filter(Boolean).join(' '));
    return q.words.every((w) => texte.includes(w));
  };
  return {
    today: () => TODAY,
    async findAssets() { return []; },
    async getAsset() { return null; },
    async findDocuments(_a, w) { return w.every((x) => sansAccent(NORAUTO.title).includes(x)) ? [{ id: NORAUTO.id, title: NORAUTO.title, documentDate: NORAUTO.documentDate }] : []; },
    async getDocumentState(_a, id) { return id === NORAUTO.id ? NORAUTO : null; },
    async findSuppliers(_a, w) { return w.every((x) => 'garage martin'.includes(x)) ? [{ id: 44, name: 'Garage Martin', status: 'active' }] : []; },
    async getSupplierState(_a, id) {
      return id === 44 ? { id: 44, name: 'Garage Martin', status: 'active', phone: null, email: null, website: null, version: 'sv1', links: { documents: 0, assets: 0, equipments: 0, agenda: 0 } } : null;
    },
    async findAgendaItems(_a, q) { return (o.echeances ?? [ECHEANCE]).filter((i) => q.words.every((w) => sansAccent(i.title).includes(w)) && (!q.date || i.startDate === q.date)); },
    async findReferenceEvents(_a, q) { return actifs.filter((s) => repond(s, q)); },
    async getReferenceEventState(_a, id) { return actifs.find((s) => s.id === id) ?? null; },
    async findInvalidatedReferenceEvents(_a, q) { return supprimes.filter((s) => repond(s, q)); },
  };
};
const besoin = (a: unknown) => (a as { needInfo: string }).needInfo;
const effets = (a: unknown) => (a as { effects: string[] }).effects;

describe('L114AB-I01 — phrases reconnues', () => {
  it.each([
    ['Retire le document Facture Norauto de l’intervention Vidange', 'UNLINK_DOCUMENT_REFERENCE_EVENT'],
    ['Détache le document Facture Norauto de l’intervention Vidange', 'UNLINK_DOCUMENT_REFERENCE_EVENT'],
    ['Retire le fournisseur Garage Martin de l’intervention Vidange', 'UNLINK_SUPPLIER_REFERENCE_EVENT'],
    ['Rattache l’échéance Vidange à l’intervention Vidange', 'LINK_AGENDA_REFERENCE_EVENT'],
    ['Dissocie le financement Prêt auto de l’achat de la Clio', 'DISSOCIATE_REFERENCE_EVENTS'],
    ['Rétablis l’intervention Vidange', 'RESTORE_REFERENCE_EVENT'],
    ['Restaure l’opération Vidange', 'RESTORE_REFERENCE_EVENT'],
  ])('%s → %s', (phrase, command) => {
    expect(parseCommand(phrase, TODAY)).toMatchObject({ command });
  });

  it('non-régression : les gestes DIRECTS gardent leur commande', () => {
    expect(parseCommand('Rattache le document Facture Norauto à l’intervention Vidange', TODAY)).toMatchObject({ command: 'LINK_DOCUMENT_REFERENCE_EVENT' });
    expect(parseCommand('Relie le fournisseur Garage Martin à l’intervention Vidange', TODAY)).toMatchObject({ command: 'LINK_SUPPLIER_REFERENCE_EVENT' });
    expect(parseCommand('Associe le financement Prêt auto à l’achat de la Clio', TODAY)).toMatchObject({ command: 'ASSOCIATE_REFERENCE_EVENTS' });
    expect(parseCommand('Supprime l’intervention Vidange de la Clio', TODAY)).toMatchObject({ command: 'INVALIDATE_REFERENCE_EVENT' });
  });

  it('non-régression : un document DÉTACHÉ d’un bien, d’une pièce ou d’un équipement est inchangé', () => {
    expect(parseCommand('Détache le document Garantie de la maison', TODAY)).toMatchObject({ command: 'UPDATE_DOCUMENT_TARGETS', mode: 'detach', structureTarget: null });
    expect(parseCommand('Détache le document Garantie de la pièce Cuisine', TODAY)).toMatchObject({ command: 'UPDATE_DOCUMENT_TARGETS', mode: 'detach', structureTarget: { kind: 'room' } });
  });

  it('non-régression : une phrase sur une caractéristique de bien n’est jamais un rétablissement', () => {
    // « Remets la date d'achat … » n'était pas une commande avant ce passage : elle ne l'est pas davantage.
    expect(parseCommand('Remets la date d’achat au 25/05/2021 pour la Clio', TODAY)).toBeNull();
    expect(parseCommand('Mets la date d’achat au 25/05/2021 pour la Clio', TODAY)).toMatchObject({ command: 'UPDATE_ASSET_FIELD' });
  });
});

describe('L114AB-I02 — aperçus : ce qui est conservé est dit', () => {
  it('retirer un document : il reste dans les documents', async () => {
    const a = await resolveDraft(parseCommand('Retire le document Facture Norauto de l’intervention Vidange', TODAY)!, input, lookup());
    expect(a).toMatchObject({
      command: 'UNLINK_DOCUMENT_REFERENCE_EVENT',
      preview: 'Retirer le document « Facture Norauto » de l’opération « Intervention — Vidange » du 12 mars 2025 — Clio.',
      params: { kind: 'reference_event_document_unlink', operationId: 500, linkedDocumentId: 33, expectedVersion: 3, documentVersion: NORAUTO.version },
    });
    expect(effets(a)).toContain('Le document reste dans vos documents et garde ses autres rattachements : il n’est pas supprimé.');
  });

  it('retirer un fournisseur : sa fiche reste', async () => {
    const a = await resolveDraft(parseCommand('Retire le fournisseur Garage Martin de l’intervention Vidange', TODAY)!, input, lookup());
    expect(a).toMatchObject({
      preview: 'Retirer le fournisseur « Garage Martin » de l’opération « Intervention — Vidange » du 12 mars 2025 — Clio.',
      params: { kind: 'reference_event_supplier_unlink', linkedSupplierId: 44, supplierVersion: 'sv1' },
    });
    expect(effets(a)).toContain('La fiche du fournisseur, ses documents et ses autres liens sont conservés : rien n’est supprimé.');
  });

  it('dissocier : seul le lien est retiré, les deux événements restent', async () => {
    const a = await resolveDraft(parseCommand('Dissocie le financement Prêt auto de l’achat de la Clio', TODAY)!, input, lookup({ actifs: [PRET, ACHAT] }));
    expect(a).toMatchObject({
      command: 'DISSOCIATE_REFERENCE_EVENTS',
      params: { kind: 'reference_events_dissociate', fromOperationId: 501, toOperationId: 502, expectedVersions: [3, 3] },
    });
    expect(effets(a)).toContain('Seul le lien entre ces deux opérations est retiré.');
    expect(effets(a)).toContain('Les deux opérations restent dans votre compte, avec leurs documents, leurs échéances et leurs fournisseurs.');
  });

  it('rattacher une échéance : elle garde sa date et ses rappels', async () => {
    const a = await resolveDraft(parseCommand('Rattache l’échéance Vidange à l’intervention Vidange', TODAY)!, input, lookup());
    expect(a).toMatchObject({
      command: 'LINK_AGENDA_REFERENCE_EVENT',
      preview: 'Rattacher l’échéance « Vidange » du 12 mars 2027 à l’opération « Intervention — Vidange » du 12 mars 2025 — Clio.',
      params: { kind: 'reference_event_agenda', operationId: 500, agendaItemId: 90, agendaItemVersion: 'av1' },
    });
    expect(effets(a)).toContain('L’échéance garde son identité, sa date et ses rappels : aucune échéance n’est créée ni copiée.');
  });

  it('rétablir : la limite des échéances détachées est annoncée', async () => {
    const a = await resolveDraft(parseCommand('Rétablis l’intervention Vidange', TODAY)!, input, lookup());
    expect(a).toMatchObject({
      command: 'RESTORE_REFERENCE_EVENT',
      preview: 'Rétablir l’opération « Intervention — Vidange » du 12 mars 2025 — Clio.',
      params: { kind: 'reference_event_restore', operationId: 600, expectedVersion: 9 },
    });
    expect(effets(a)).toContain('Ses échéances détachées à la suppression ne lui sont PAS rattachées de nouveau : elles sont restées dans l’Agenda, à leur date.');
  });

  it('aucun aperçu ne dit « événement de référence »', async () => {
    for (const phrase of [
      'Retire le document Facture Norauto de l’intervention Vidange',
      'Retire le fournisseur Garage Martin de l’intervention Vidange',
      'Rattache l’échéance Vidange à l’intervention Vidange',
      'Rétablis l’intervention Vidange',
    ]) {
      const a = await resolveDraft(parseCommand(phrase, TODAY)!, input, lookup());
      // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
      expect(JSON.stringify(a)).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    }
  });
});

describe('L114AB-I03 — jamais un choix au hasard', () => {
  it('événement introuvable : une question, aucun plan', async () => {
    const a = await resolveDraft(parseCommand('Retire le document Facture Norauto de l’intervention Freins', TODAY)!, input, lookup());
    expect(besoin(a)).toContain('Je n’ai pas trouvé cette opération dans votre compte.');
  });

  it('plusieurs événements : la liste et une question', async () => {
    const deux = [VIDANGE, evenement({ id: 503, realizedDate: '2024-06-02' })];
    const a = await resolveDraft(parseCommand('Retire le fournisseur Garage Martin de l’intervention Vidange', TODAY)!, input, lookup({ actifs: deux }));
    expect(besoin(a)).toContain('Plusieurs opérations correspondent');
  });

  it('dissocier deux fois le même événement : c’est dit', async () => {
    const a = await resolveDraft(parseCommand('Dissocie l’intervention Vidange de l’intervention Vidange', TODAY)!, input, lookup());
    expect(besoin(a)).toBe('Ces deux désignations correspondent à la même opération : précisez les deux opérations à dissocier.');
  });

  it('échéance introuvable ou ambiguë : une question, aucun plan', async () => {
    expect(besoin(await resolveDraft(parseCommand('Rattache l’échéance Freins à l’intervention Vidange', TODAY)!, input, lookup())))
      .toBe('Je n’ai pas trouvé cette échéance dans votre compte. Laquelle voulez-vous rattacher ?');
    const deux = [ECHEANCE, { ...ECHEANCE, id: 91, startDate: '2028-03-12' }];
    expect(besoin(await resolveDraft(parseCommand('Rattache l’échéance Vidange à l’intervention Vidange', TODAY)!, input, lookup({ echeances: deux }))))
      .toContain('Plusieurs échéances correspondent');
  });

  it('rétablir sans désignation, ou sans suppression correspondante : une question, aucun plan', async () => {
    expect(besoin(await resolveDraft({ command: 'RESTORE_REFERENCE_EVENT', target: { typeCode: null, words: [], date: null, fromContext: true } }, input, lookup())))
      .toBe('Quelle opération voulez-vous rétablir ? Donnez son intitulé, sa date complète ou son bien.');
    expect(besoin(await resolveDraft(parseCommand('Rétablis l’intervention Vidange', TODAY)!, input, lookup({ supprimes: [] }))))
      .toBe('Je n’ai pas trouvé d’opération supprimée qui corresponde dans votre compte. Laquelle voulez-vous rétablir ?');
  });
});

describe('L114AB-I04 — rétablir : seules les suppressions de l’utilisateur', () => {
  it('une phrase qui ne désigne aucune suppression du compte n’est pas une commande', async () => {
    const draft = parseCommand('Rétablis l’intervention Vidange', TODAY)!;
    expect(await isReferenceEventCommand(draft as never, input, lookup())).toBe(true);
    expect(await isReferenceEventCommand(draft as never, input, lookup({ supprimes: [] }))).toBe(false);
  });

  it('la lecture est bornée au compte, aux suppressions de l’utilisateur, et ne s’étend pas aux actifs', () => {
    const src = readFileSync(join(__dirname, '../../reference-events-inverse.ts'), 'utf8');
    const lecture = src.slice(src.indexOf('export async function sqlFindInvalidatedReferenceEvents'), src.indexOf('export async function sqlGetInvalidatedReferenceEventState'));
    expect(lecture).toMatch(/o\.account_id = \$1/);
    expect(lecture).toMatch(/o\.invalidated_at IS NOT NULL/);
    expect(lecture).toMatch(/o\.invalidation_reason = \$2/);
    expect(lecture).toMatch(/USER_INVALIDATION_REASON/);
    expect(lecture).toMatch(/o\.merged_into_operation_id IS NULL/);
    // Lecture seule : aucune écriture dans cette requête.
    expect(lecture).not.toMatch(/UPDATE |INSERT |DELETE /);
  });
});

describe('L114AB-I05 — exécution : aucune écriture propre', () => {
  const src = readFileSync(join(__dirname, '../../reference-events-inverse.ts'), 'utf8');
  const exec = src.slice(src.indexOf('export const INVERSE_REFERENCE_EVENT_EXECUTORS'));

  it('chaque exécuteur appelle la façade de la carte #744, et elle seule', () => {
    for (const fn of ['restoreOperation', 'dissociateOperations', 'unlinkDocument', 'unlinkSupplier', 'linkAgendaItem']) {
      expect(exec).toMatch(new RegExp(`${fn}\\(writeContext\\(ctx, action\\)`));
    }
    expect(exec).not.toMatch(/pgClient\.unsafe|UPDATE business_operations|INSERT INTO/);
  });

  it('l’état est relu avant d’écrire, et la version présentée exigée', () => {
    expect(exec).toMatch(/relu\(ctx, action, p\.operationId, p\.expectedVersion\)/);
    expect(exec).toMatch(/etat\.version !== p\.expectedVersion\) return ko\(action, REFERENCE_EVENT_CHANGED_SINCE_PREVIEW\)/);
    expect(exec).toMatch(/doc\.version !== p\.documentVersion/);
    expect(exec).toMatch(/f\.version !== p\.supplierVersion/);
    expect(exec).toMatch(/agendaVersion\(item\) !== p\.agendaItemVersion/);
  });

  it('chaque résultat de la façade est traduit en phrase, sans code et sans le mot interdit', () => {
    expect(exec.match(/translateWriteResult\(/g)?.length).toBe(5);
    // Le mot interdit est celui qui s'AFFICHE (accentué) ; les identifiants techniques de la façade
    // (`restoreOperation`, `operationId`) ne sont jamais montrés à l'utilisateur.
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(exec).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    // Aucun bouton « Annuler » promis.
    expect(exec).toMatch(/reversible: false/);
  });

  it('les exécuteurs sont branchés au catalogue', () => {
    const executors = readFileSync(join(__dirname, '../../executors.ts'), 'utf8');
    for (const type of ['RESTORE_REFERENCE_EVENT', 'DISSOCIATE_REFERENCE_EVENTS', 'UNLINK_DOCUMENT_REFERENCE_EVENT', 'UNLINK_SUPPLIER_REFERENCE_EVENT', 'LINK_AGENDA_REFERENCE_EVENT']) {
      expect(executors).toMatch(new RegExp(`async ${type}\\(action, ctx\\)`));
    }
  });
});

describe('L114AB-I06 — catalogue fermé', () => {
  it('chaque geste inverse a sa fiche et nomme son service', () => {
    const attendus: Record<string, string> = {
      RESTORE_REFERENCE_EVENT: 'operation-write.facade.restoreOperation',
      DISSOCIATE_REFERENCE_EVENTS: 'operation-write.facade.dissociateOperations',
      UNLINK_DOCUMENT_REFERENCE_EVENT: 'operation-write.facade.unlinkDocument',
      UNLINK_SUPPLIER_REFERENCE_EVENT: 'operation-write.facade.unlinkSupplier',
      LINK_AGENDA_REFERENCE_EVENT: 'operation-write.facade.linkAgendaItem',
    };
    for (const [type, service] of Object.entries(attendus)) {
      const def = WRITE_COMMAND_CATALOG[type as keyof typeof WRITE_COMMAND_CATALOG];
      expect(def.service).toBe(service);
      expect(def.requiresWriteAccess).toBe(true);
      expect(def.spec?.targetKind).toBe('reference_event');
      expect(def.spec?.readBeforeWrite).toBe(true);
      expect(def.spec?.undoPolicy).toBe('IRREVERSIBLE');
      expect(def.spec?.retrySafety).toBe('PLAN_TAKEN_ONCE_AND_IDEMPOTENCY_KEY');
      // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
      expect(def.label).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    }
  });

  it('aucun fichier de `business-operations` n’est modifié par ce passage', () => {
    const inverse = readFileSync(join(__dirname, '../../reference-events-inverse.ts'), 'utf8');
    // Seuls des appels à la façade et au modèle : aucune réécriture de ses règles.
    expect(inverse).toMatch(/import\('@\/services\/business-operations\/operation-write\.facade'\)/);
    expect(inverse).toMatch(/from '@\/services\/business-operations\/model'/);
    expect(inverse).not.toMatch(/business-operations\/graph\/(?:write|repository)/);
  });
});
