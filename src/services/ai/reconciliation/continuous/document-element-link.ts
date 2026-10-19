/**
 * Réévaluation RÉELLE d'une carte LINK-ELT (document → équipement) — lot 54A,
 * ticket « [P1] T3 — Achever le réexamen systématique de tous les À traiter
 * ouverts », écart 2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AVANT : la phase « open actions » relisait `trigger_context.candidates`
 * (anciennes propositions) et vérifiait seulement qu'elles existaient encore.
 * Un équipement créé APRÈS l'ouverture de la carte, ou devenu identifiable,
 * n'était jamais trouvé : la carte pouvait rester ouverte indéfiniment.
 *
 * MAINTENANT, à chaque passage T3 global du compte, l'univers de recherche est
 * RECONSTRUIT depuis l'état courant :
 *   · document : titre retenu, description, fournisseur ;
 *   · extraction persistée : faits actifs (`document_facts`), unités source
 *     (`document_source_units`), faits non résolus (`document_unresolved_facts`) ;
 *   · bien principal du document, ses pièces (sous-structures) et TOUS ses
 *     équipements actuels non archivés (nom, type, catégorie, marque, modèle,
 *     n° de série).
 * Puis Candidate Builder élément → règles déterministes (n° de série exact,
 * nom dans le titre / le fournisseur, type, similarité lexicale) → arbitrage
 * T3 (`reconcileLinks`, opération et prompt EXISTANTS, inchangés) seulement si
 * les règles ne suffisent pas. Les anciennes propositions de la carte ne sont
 * qu'un HISTORIQUE (comparées pour dire si la carte a changé), jamais
 * l'univers de recherche.
 *
 * Décisions utilisateur protégées : une carte résolue n'est jamais lue (phase
 * appelante) ; un document qui porte déjà un équipement n'est jamais
 * réécrit — la carte devient sans objet (OBSOLETE).
 * ══════════════════════════════════════════════════════════════════════════
 */
export interface ElementCandidate {
  equipmentId: number;
  name: string;
  score: number;
  reason: string;
  method: 'SERIAL_NUMBER' | 'NAME_IN_TITLE' | 'NAME_IN_SUPPLIER' | 'TYPE_MATCH' | 'NAME_IN_TEXT' | 'LEXICAL';
}

export interface ElementDocumentContext {
  title: string | null;
  supplier: string | null;
  description: string | null;
  /** Texte persisté : faits, unités source, faits non résolus. */
  texts: string[];
}

export interface ElementEquipment {
  id: number;
  name: string;
  type: string | null;
  category: string | null;
  brand: string | null;
  model: string | null;
  serialNumber: string | null;
  room: string | null;
}

/** Seuils : application déterministe, puis candidat soumis à l'arbitrage. */
export const ELEMENT_APPLY_THRESHOLD = 0.7;
export const ELEMENT_CANDIDATE_THRESHOLD = 0.3;
/** Candidats au plus soumis à l'arbitrage T3. */
export const ELEMENT_MAX_AI_CANDIDATES = 20;

const MOTS_VIDES = new Set(['le', 'la', 'les', 'des', 'du', 'de', 'un', 'une', 'et', 'ou', 'a', 'au', 'aux', 'en', 'pour', 'sur']);
const sansAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
function tokens(text: string): Set<string> {
  return new Set(sansAccents(text.toLowerCase()).replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter((t) => t.length > 1 && !MOTS_VIDES.has(t)));
}
const compact = (s: string) => sansAccents(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Candidate Builder élément (pur, testé) : score de chaque équipement ACTUEL
 * du bien face aux données persistées du document.
 */
export function buildElementCandidates(doc: ElementDocumentContext, equipments: ElementEquipment[]): ElementCandidate[] {
  const titre = sansAccents((doc.title ?? '').toLowerCase());
  const fournisseur = sansAccents((doc.supplier ?? '').toLowerCase());
  const corps = sansAccents([doc.description ?? '', ...doc.texts].join(' \n ').toLowerCase());
  const toutCompact = compact([doc.title ?? '', doc.description ?? '', doc.supplier ?? '', ...doc.texts].join(' '));
  const docTokens = tokens([doc.title ?? '', doc.supplier ?? '', doc.description ?? '', ...doc.texts].join(' '));
  const out: ElementCandidate[] = [];
  for (const e of equipments) {
    const nom = sansAccents(e.name.toLowerCase()).trim();
    const serie = e.serialNumber ? compact(e.serialNumber) : '';
    let c: Omit<ElementCandidate, 'equipmentId' | 'name'> | null = null;
    if (serie.length >= 5 && toutCompact.includes(serie)) {
      c = { score: 1, reason: `N° de série ${e.serialNumber} lu dans le document`, method: 'SERIAL_NUMBER' };
    } else if (nom.length >= 3 && titre.includes(nom)) {
      c = { score: 0.95, reason: `« ${e.name} » dans le titre du document`, method: 'NAME_IN_TITLE' };
    } else if (nom.length >= 3 && fournisseur.includes(nom)) {
      c = { score: 0.85, reason: `« ${e.name} » chez le fournisseur du document`, method: 'NAME_IN_SUPPLIER' };
    } else if (e.type && e.type.length >= 3 && (titre.includes(sansAccents(e.type.toLowerCase())))) {
      c = { score: 0.7, reason: `Type « ${e.type} » dans le titre du document`, method: 'TYPE_MATCH' };
    } else if (nom.length >= 3 && corps.includes(nom)) {
      c = { score: 0.6, reason: `« ${e.name} » cité dans le document`, method: 'NAME_IN_TEXT' };
    } else {
      const eqTokens = tokens([e.name, e.type ?? '', e.category ?? '', e.brand ?? '', e.model ?? '', e.room ?? ''].join(' '));
      let inter = 0;
      for (const t of eqTokens) if (docTokens.has(t)) inter++;
      const sim = eqTokens.size === 0 ? 0 : inter / eqTokens.size;
      if (sim >= 0.5) c = { score: 0.5, reason: `Similitudes avec « ${e.name} » (${Math.round(sim * 100)} %)`, method: 'LEXICAL' };
      else if (sim > 0) c = { score: 0.3, reason: `Faibles similitudes avec « ${e.name} »`, method: 'LEXICAL' };
    }
    if (c) out.push({ equipmentId: e.id, name: e.name, ...c });
  }
  return out.sort((a, b) => b.score - a.score || a.equipmentId - b.equipmentId);
}

/** Décision déterministe (pure) : un seul candidat au-dessus du seuil d'application, ou un n° de série unique. */
export function decideElementDeterministic(cands: ElementCandidate[]): ElementCandidate | null {
  const series = cands.filter((c) => c.method === 'SERIAL_NUMBER');
  if (series.length === 1) return series[0];
  if (series.length > 1) return null;
  const forts = cands.filter((c) => c.score >= ELEMENT_APPLY_THRESHOLD);
  return forts.length === 1 ? forts[0] : null;
}

export type ElementLinkStatus = 'APPLIED' | 'ALREADY_LINKED' | 'NO_ASSET' | 'TARGET_GONE' | 'NO_CANDIDATE' | 'AMBIGUOUS';

export interface ElementLinkResult {
  status: ElementLinkStatus;
  candidateCount: number;
  deterministicAttempted: boolean;
  aiCalled: boolean;
  equipmentId: number | null;
  method: string | null;
  /** Carte modifiée (nouvelles propositions) sans être fermée. */
  cardUpdated: boolean;
}

export interface ElementLinkDeps {
  /** Arbitrage T3 (défaut : `reconcileLinks`, opération existante). Rend l'équipement retenu ou null. */
  arbitrate?: (p: { accountId: number; fileId: number; subject: string; candidates: ElementCandidate[] }) => Promise<{ equipmentId: number | null }>;
}

type Sql = typeof import('@/db').pgClient;
const pg = async (): Promise<Sql> => (await import('@/db')).pgClient;

async function defaultArbitrate(p: { accountId: number; fileId: number; subject: string; candidates: ElementCandidate[] }): Promise<{ equipmentId: number | null }> {
  const { reconcileLinks, retainAbove, LINK_SCORE_THRESHOLDS } = await import('../link-reconciler');
  // Lot 71A (ticket P1 « contexte T3 équipements ») : sujet et candidats
  // ENRICHIS depuis les sources canoniques (bien parent, marque, modèle,
  // n° de série, faits T1 avec cibles et preuves) ; repli : contexte historique.
  let subject = p.subject;
  let liste = p.candidates.map((c) => `[id:${c.equipmentId}] "${c.name}" — ${c.reason}`).join('\n');
  try {
    const svc = await import('@/services/equipment/document-equipment-link.service');
    const fmt = await import('@/services/equipment/document-equipment-matching');
    const doc = await svc.loadDocumentProfile(p.accountId, p.fileId);
    const profils = await svc.loadEquipmentProfiles(p.accountId, { equipmentIds: p.candidates.map((c) => c.equipmentId) });
    if (doc) subject = fmt.formatDocumentSubject(doc.profile);
    if (profils.length === p.candidates.length) liste = profils.map(fmt.formatEquipmentCandidate).join('\n');
  } catch (e) {
    console.warn('[t3-open-actions] contexte enrichi LINK-ELT indisponible :', (e as Error).message);
  }
  const linked = await reconcileLinks({
    accountId: p.accountId,
    variables: {
      SUBJECT_CONTEXT: subject,
      DOCUMENTS_LIST: '(sans objet)',
      AGENDA_LIST: '(sans objet)',
      SUPPLIERS_LIST: '(sans objet)',
      EQUIPMENTS_LIST: liste,
    },
    sourceIds: [p.fileId],
  });
  // Abstention explicite du modèle (marge, égalité) : aucun rattachement.
  if ((linked.ambiguities ?? []).some((a) => a.section === 'matches')) return { equipmentId: null };
  const retenus = retainAbove(linked.matches, LINK_SCORE_THRESHOLDS.documentToEquipment)
    .filter((m) => p.candidates.some((c) => c.equipmentId === m.id));
  return { equipmentId: retenus.length === 1 || (retenus.length > 1 && retenus[0].score - retenus[1].score >= 0.2) ? retenus[0].id : null };
}

/**
 * Réévalue le rattachement document → équipement d'une carte LINK-ELT ouverte
 * depuis l'état COURANT. Écrit le rattachement (jamais par-dessus un
 * équipement déjà posé) et ferme la carte si résolu ; sinon actualise ses
 * propositions avec les candidats reconstruits.
 */
export async function resolveDocumentElementLink(p: {
  accountId: number; fileId: number; actionId: number;
  guard?: { assertActive(what: string): Promise<void> };
  deps?: ElementLinkDeps;
}): Promise<ElementLinkResult> {
  const sql = await pg();
  const res = (status: ElementLinkStatus, over: Partial<ElementLinkResult> = {}): ElementLinkResult => ({
    status, candidateCount: 0, deterministicAttempted: false, aiCalled: false, equipmentId: null, method: null, cardUpdated: false, ...over,
  });
  const [doc] = (await sql.unsafe(
    `SELECT id, equipment_id, coalesce(asset_id, linked_asset_id) AS asset_id, retained_title, original_filename, supplier, description
       FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
    [p.fileId, p.accountId] as never[],
  )) as unknown as Array<Record<string, unknown>>;
  if (!doc) return res('TARGET_GONE');
  if (doc.equipment_id != null) return res('ALREADY_LINKED', { equipmentId: Number(doc.equipment_id) });
  if (doc.asset_id == null) return res('NO_ASSET');
  const assetId = Number(doc.asset_id);

  // Données persistées du document (aucune relecture du fichier, aucun T1).
  const textes = (await sql.unsafe(
    `SELECT t FROM (
       SELECT concat_ws(' ', label, value_text, normalized_value, excerpt) AS t, 1 AS o FROM document_facts
        WHERE file_id = $1 AND account_id = $2 AND status = 'active'
       UNION ALL
       SELECT concat_ws(' ', label, value_text, content_text), 2 FROM document_source_units
        WHERE file_id = $1 AND account_id = $2
       UNION ALL
       SELECT concat_ws(' ', raw_key, raw_value), 3 FROM document_unresolved_facts
        WHERE file_id = $1 AND account_id = $2
     ) x WHERE t <> '' ORDER BY o LIMIT 600`,
    [p.fileId, p.accountId] as never[],
  )) as unknown as Array<{ t: string }>;
  // Équipements ACTUELS du bien (compte vérifié), avec leur pièce.
  const eqs = (await sql.unsafe(
    `SELECT e.id, e.name, e.type, e.category, s.brand, s.model, s.serial_number, sub.name AS room
       FROM equipments e
       JOIN assets a ON a.id = e.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
       LEFT JOIN equipment_cil_specs s ON s.equipment_id = e.id
       LEFT JOIN substructures sub ON sub.id = e.substructure_id
      WHERE e.asset_id = $1 AND e.archived_at IS NULL
      ORDER BY e.id`,
    [assetId, p.accountId] as never[],
  )) as unknown as Array<Record<string, unknown>>;
  const s = (v: unknown) => (v == null ? null : String(v));
  const ctx: ElementDocumentContext = {
    title: s(doc.retained_title) ?? s(doc.original_filename), supplier: s(doc.supplier), description: s(doc.description),
    texts: textes.map((x) => x.t),
  };
  const candidats = buildElementCandidates(ctx, eqs.map((e) => ({
    id: Number(e.id), name: String(e.name), type: s(e.type), category: s(e.category), brand: s(e.brand), model: s(e.model),
    serialNumber: s(e.serial_number), room: s(e.room),
  })));
  const base = { candidateCount: candidats.length, deterministicAttempted: true };
  if (candidats.length === 0) return res('NO_CANDIDATE', base);

  let retenu = decideElementDeterministic(candidats);
  let aiCalled = false;
  if (!retenu) {
    const soumis = candidats.filter((c) => c.score >= ELEMENT_CANDIDATE_THRESHOLD).slice(0, ELEMENT_MAX_AI_CANDIDATES);
    if (soumis.length > 0) {
      await p.guard?.assertActive('T3 LINK-ELT — arbitrage');
      aiCalled = true;
      const subject = `Document — Titre: "${ctx.title ?? `#${p.fileId}`}"${ctx.supplier ? ` | Fournisseur: "${ctx.supplier}"` : ''}`
        + `${ctx.description ? ` | Description: ${ctx.description.slice(0, 150)}` : ''}`;
      const r = await (p.deps?.arbitrate ?? defaultArbitrate)({ accountId: p.accountId, fileId: p.fileId, subject, candidates: soumis });
      const choisi = r.equipmentId == null ? null : soumis.find((c) => c.equipmentId === r.equipmentId) ?? null;
      if (choisi) retenu = { ...choisi, reason: `Arbitrage T3 — ${choisi.reason}` };
    }
  }
  if (retenu) {
    await p.guard?.assertActive('T3 LINK-ELT — écriture');
    // Jamais par-dessus un équipement posé entre-temps (utilisateur) ; équipement du compte ET du bien du document.
    const ecrits = (await sql.unsafe(
      `UPDATE asset_files f SET equipment_id = $3, updated_at = now()
        WHERE f.id = $1 AND f.account_id = $2 AND f.deleted_at IS NULL AND f.equipment_id IS NULL
          AND EXISTS (SELECT 1 FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $2
                       WHERE e.id = $3 AND e.asset_id = coalesce(f.asset_id, f.linked_asset_id) AND e.archived_at IS NULL)
        RETURNING f.id`,
      [p.fileId, p.accountId, retenu.equipmentId] as never[],
    )) as unknown as unknown[];
    if (ecrits.length === 0) return res('ALREADY_LINKED', { ...base, aiCalled });
    const { resolveAction } = await import('@/services/to-process/to-process-action.service');
    await resolveAction(p.actionId, 'OBSOLETE');
    console.info(`[t3-open-actions] LINK-ELT document ${p.fileId} → équipement ${retenu.equipmentId} (${retenu.method}${aiCalled ? ', arbitrage T3' : ''}) — carte ${p.actionId} close.`);
    return res('APPLIED', { ...base, aiCalled, equipmentId: retenu.equipmentId, method: aiCalled ? 'AI' : retenu.method });
  }
  // Toujours ambigu : la carte porte les candidats RECONSTRUITS (pas les anciens).
  let cardUpdated = false;
  const propos = candidats.filter((c) => c.score >= ELEMENT_CANDIDATE_THRESHOLD);
  if (propos.length >= 2) {
    await p.guard?.assertActive('T3 LINK-ELT — propositions');
    const { proposeDocumentEquipmentLink } = await import('@/services/to-process/document-equipment-link');
    const r = await proposeDocumentEquipmentLink({
      accountId: p.accountId, fileId: p.fileId, assetId,
      candidates: propos.map((c) => ({ equipmentId: c.equipmentId, score: c.score, reason: c.reason })),
    });
    cardUpdated = r.status === 'UPDATED' || r.status === 'CREATED';
  }
  return res('AMBIGUOUS', { ...base, aiCalled, cardUpdated });
}
