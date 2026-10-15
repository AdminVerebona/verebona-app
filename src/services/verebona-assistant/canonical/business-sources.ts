/**
 * Sources MÉTIER exposées à T2 — lot 49 (ticket « T2 : réduire le routage
 * déterministe… », §2 et §9).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE ABSTRACTION, PLUSIEURS FOURNISSEURS
 *
 * Le serveur expose à T2 des sources métier RÉELLES — bornées au compte et
 * aux biens DISPONIBLES (la cible vient de `resolveAssistantTargets`, règle
 * unique `asset-availability`) — sans que T2 connaisse leur stockage :
 *
 *   · opérations     (`BusinessOperationReadService`, lot 45) — source
 *                    privilégiée quand elle existe : contrats (LLD,
 *                    assurance, abonnement…), interventions, achats ;
 *   · champs         registre canonique (`readCanonicalField`) : les faits
 *                    demandés par UNDERSTAND, et ceux dont le LIBELLÉ du
 *                    registre répond au besoin ;
 *   · agenda         échéances à venir du bien ;
 *   · documents      pièces du bien portant un montant ou une date.
 *
 * Une source future (fournisseurs, « À traiter »…) s'ajoute ici, comme un
 * fournisseur de plus — sans règle lexicale. Aucun mapping « internet →
 * Orange » : la correspondance se fait sur le TEXTE des données
 * (`selectInterpretations`), enrichi des sujets compris par T2.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { listFields, getField } from '@/services/canonical/registry';
import type { RetrievedSource } from '../types/sources';
import type { BusinessSource, BusinessSourceDomain, SemanticNeed, SourceDomainDescriptor, ValueNeed } from '../core/semantic-scope';
import { registerSourceDomain, textMatchesTerms } from '../core/semantic-scope';
import {
  operationReader, operationLabel, operationNoun, operationSource, componentEurCents, formatEur, operationCostLines,
  type AssistantOperationRead,
} from './operations';
import { readCanonicalField, assetFieldSource } from './field-reader';
import { listUpcomingAgenda } from './agenda';
import { isPaymentProofType } from './expense-classes';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const frDate = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/**
 * Nature du montant d'une pièce (pure) — lot 59 (#419 R01) : montant
 * FACTURÉ / documenté, RÈGLEMENT (preuve de paiement : jamais un coût de
 * plus) ou PRÉVISIONNEL (devis). Codes de type génériques, aucun fournisseur.
 */
export function amountNatureOf(type: string | null | undefined): 'documented' | 'payment' | 'forecast' {
  if (isPaymentProofType(type)) return 'payment';
  return /QUOTE$|^DEVIS/i.test((type ?? '').trim()) ? 'forecast' : 'documented';
}

/** Bornes de lecture (latence et coût maîtrisés). */
const MAX_OPERATIONS = 200;
const MAX_DOCUMENTS = 150;
const MAX_FIELDS = 6;

/** Dernier coût réalisé (EUR) d'une opération : montant et date (pure). */
export function lastRealizedAmount(op: Pick<AssistantOperationRead, 'components'>): { cents: number; date: string | null } | null {
  const reels = op.components
    .filter((c) => c.kind === 'REALIZED_COST')
    .map((c) => ({ cents: componentEurCents(c), date: c.economicDate }))
    .filter((c): c is { cents: number; date: string | null } => c.cents != null)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return reels[0] ?? null;
}

/** Source métier d'une opération (pure, testée). */
export function operationBusinessSource(op: AssistantOperationRead, assetId: number | null, assetName: string | null): BusinessSource {
  const label = capitalize(operationLabel(op));
  const dernier = lastRealizedAmount(op);
  const prevu = op.components.filter((c) => c.kind === 'FORECAST_COST').map((c) => componentEurCents(c)).filter((x): x is number => x != null);
  const fin = op.effectiveTo ?? op.endDate ?? null;
  const date = op.realizedDate ?? op.startDate ?? op.effectiveFrom ?? op.plannedDate ?? null;
  const detail = [
    op.provider,
    fin ? `jusqu’au ${frDate(fin)}` : op.effectiveFrom ? `depuis le ${frDate(op.effectiveFrom)}` : date ? frDate(date) : null,
  ].filter(Boolean).join(' · ') || null;
  const [l] = operationCostLines([op], { assetIds: assetId ? [assetId] : [] });
  const content = [
    label, op.provider ? `prestataire : ${op.provider}` : null, op.contractReference ? `n° ${op.contractReference}` : null,
    op.effectiveFrom || fin ? `période : ${op.effectiveFrom ?? '?'} → ${fin ?? '?'}` : null,
    dernier ? `dernier montant : ${formatEur(dernier.cents)}${dernier.date ? ` (${dernier.date})` : ''}` : null,
    l && (l.hasCost || l.costCents) ? `total documenté : ${formatEur(l.costCents)}` : null,
    prevu.length ? `tarif annoncé : ${formatEur(prevu[prevu.length - 1])}` : null,
  ].filter(Boolean).join(' · ');
  return {
    ref: `operation:${op.id}`,
    domain: 'operation',
    label,
    detail,
    text: [op.technicalLabel, op.provider, op.contractReference, ...op.documents.map((d) => `${d.title} ${d.documentTypeCode ?? ''}`)].filter(Boolean).join(' '),
    kindNoun: operationNoun(op.typeCode),
    assetId,
    provider: op.provider ?? null,
    amountCents: dernier?.cents ?? (prevu.length ? prevu[prevu.length - 1] : null),
    endDate: fin,
    date,
    representedFileIds: op.documents.map((d) => d.fileId),
    source: operationSource(op, { content, assetId, assetName }) ?? undefined,
    meta: {
      totalCents: l && (l.hasCost || l.costCents) ? l.costCents : null,
      lastDate: dernier?.date ?? null,
      forecastCents: prevu.length ? prevu[prevu.length - 1] : null,
      typeCode: op.typeCode,
      operationId: op.id,
      // Lot 59 (#419 R03) : référence contractuelle — preuve d'identité métier.
      contractReference: op.contractReference ?? null,
      realizedCount: op.components.filter((c) => c.kind === 'REALIZED_COST').length,
      // Lot 53 (PO D21) : montants réalisés datés, pour une question bornée à une période.
      realized: op.components.filter((c) => c.kind === 'REALIZED_COST')
        .map((c) => ({ cents: componentEurCents(c), date: c.economicDate ?? null }))
        .filter((c): c is { cents: number; date: string | null } => c.cents != null),
    },
  };
}

/** Clés du registre à lire : faits demandés, puis libellés qui répondent au besoin (pure). */
export function fieldKeysFor(need: SemanticNeed): string[] {
  const keys = new Set(need.facts);
  const type = need.need === 'amount' ? 'money_eur' : need.need ? 'date' : null;
  if (type && need.terms.length) {
    for (const d of listFields()) {
      if (d.valueType === type && d.assistantReadable && textMatchesTerms(d.label, need.terms)) keys.add(d.key);
    }
  }
  return [...keys].slice(0, MAX_FIELDS);
}

// ══════════════════════════════════════════════════════════════════════════
// FOURNISSEURS DE SOURCES — lot 54E (#419 écart 8)
//
// Chaque domaine est un FOURNISSEUR enregistré (liste + relecture), avec son
// descripteur (autorité, structuration) : un domaine futur (« À traiter »,
// fournisseurs…) s'ajoute par `registerBusinessSourceProvider`, sans toucher
// à la sélection (`selectInterpretations`), à l'étape sémantique ni à
// l'orchestrateur.
// ══════════════════════════════════════════════════════════════════════════

export interface ProviderContext {
  ids: number[];
  nom: (id: number | null) => string | null;
  need: SemanticNeed;
}

export interface BusinessSourceProvider {
  domain: BusinessSourceDomain;
  /** Descripteur du domaine (autorité, structuration) ; défaut : celui déjà déclaré. */
  descriptor?: SourceDomainDescriptor;
  /** Sources du périmètre ; `null` : domaine non applicable à ce besoin (non déclaré disponible). */
  list(accountId: number, ctx: ProviderContext): Promise<BusinessSource[] | null>;
  /** Relecture d'UNE source par sa référence (reprise), revalidée — `null` : refusée. */
  read?(accountId: number, ref: string, ctx: { assetIds: number[]; nom: (id: number | null) => string | null }): Promise<BusinessSource | null>;
}

const operationProvider: BusinessSourceProvider = {
  domain: 'operation',
  async list(accountId, { ids, nom }) {
    const out: BusinessSource[] = [];
    const ops = await operationReader().listForAssistant(accountId, { assetIds: ids.length ? ids : null, includeUntargeted: ids.length === 0, limit: MAX_OPERATIONS });
    for (const op of ops) {
      if (op.status === 'CANCELLED' || op.typeCode === 'DISPOSAL') continue;
      // Aucun bien disponible dans le périmètre : seules les opérations SANS
      // bien sont exposées (jamais celles d'un bien archivé, vendu, transmis).
      if (!ids.length && op.assetIds.length) continue;
      const assetId = op.assetIds.find((a) => ids.includes(a)) ?? (ids.length === 1 ? ids[0] : op.assetIds[0] ?? null);
      out.push(operationBusinessSource(op, assetId, nom(assetId)));
    }
    return out;
  },
  async read(accountId, ref, { assetIds, nom }) {
    const id = Number(ref.split(':')[1]);
    const [op] = await operationReader().listForAssistant(accountId, { ids: [id], limit: 1 });
    if (!op || op.status === 'CANCELLED') return null;
    // Bien de la reprise : l'opération doit le concerner (lien ACTIF).
    // Sans bien de reprise : seule une opération sans bien est relisible.
    if (assetIds.length ? !op.assetIds.some((x) => assetIds.includes(x)) : op.assetIds.length > 0) return null;
    const assetId = op.assetIds.find((x) => assetIds.includes(x)) ?? op.assetIds[0] ?? null;
    return operationBusinessSource(op, assetId, nom(assetId));
  },
};

/** Source d'un champ canonique lu (pure). */
function fieldSource(ref: string, assetId: number, key: string, r: NonNullable<Awaited<ReturnType<typeof readCanonicalField>>>, text: string): BusinessSource {
  const def = getField(key);
  return {
    ref, domain: 'field', label: r.label, detail: r.display, text, fieldKey: key, assetId,
    amountCents: def?.valueType === 'money_eur' && typeof r.value === 'number' ? Math.round(r.value * 100) : null,
    date: def?.valueType === 'date' ? String(r.value).slice(0, 10) : null,
    endDate: def?.valueType === 'date' && def.agendaEffect?.nature === 'DEADLINE' ? String(r.value).slice(0, 10) : null,
    source: assetFieldSource(r),
    meta: { display: r.display, assetName: r.assetName },
  };
}

const fieldProvider: BusinessSourceProvider = {
  domain: 'field',
  async list(accountId, { ids, nom, need }) {
    const keys = fieldKeysFor(need);
    if (!keys.length || !ids.length || ids.length > 3) return null;
    const out: BusinessSource[] = [];
    for (const assetId of ids) {
      for (const key of keys) {
        const r = await readCanonicalField(accountId, assetId, key, { assetName: nom(assetId) }).catch(() => null);
        if (!r || r.value == null || r.display == null) continue;
        out.push(fieldSource(`field:${assetId}:${key}`, assetId, key, r, `${r.label} ${key}`));
      }
    }
    return out;
  },
  async read(accountId, ref, { assetIds, nom }) {
    const [, a, b] = ref.split(':');
    const id = Number(a);
    // Bien DISPONIBLE (règle unique) : la reprise passe `assetIds` résolus par le serveur.
    if (!b || !assetIds.includes(id)) return null;
    const r = await readCanonicalField(accountId, id, b, { assetName: nom(id) }).catch(() => null);
    if (!r || r.value == null || r.display == null) return null;
    return fieldSource(ref, id, b, r, r.label);
  },
};

const agendaProvider: BusinessSourceProvider = {
  domain: 'agenda',
  async list(accountId, { ids, need }) {
    if (!need.need || need.need === 'amount' || !need.terms.length) return null;
    const rows = await listUpcomingAgenda(accountId, { assetIds: ids.length ? ids : undefined, windowDays: null, limit: 30 });
    return rows.map((r): BusinessSource => ({
      ref: `agenda:${r.id}`, domain: 'agenda', label: r.title, detail: frDate(r.date), text: r.title, assetId: ids.length === 1 ? ids[0] : null,
      date: r.date, endDate: r.date,
      source: { id: `agenda_${r.id}`, type: 'agenda_item', title: r.title, content: `${r.date}${r.forecast ? ' · date prévisionnelle' : ''}`, relevanceScore: 1, meta: { date: r.date, forecast: r.forecast } },
      meta: { forecast: r.forecast },
    }));
  },
  async read(accountId, ref, { assetIds }) {
    const id = Number(ref.split(':')[1]);
    const rows = (await pgClient.unsafe(
      `SELECT i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS date FROM agenda_items i WHERE i.id = $1 AND i.account_id = $2
          AND ($3::int[] IS NULL OR EXISTS (SELECT 1 FROM agenda_asset_links x WHERE x.agenda_item_id = i.id AND x.asset_id = ANY($3::int[])))`,
      [id, accountId, assetIds.length ? assetIds : null] as never[],
    )) as unknown as Array<{ id: number; title: string; date: string | null }>;
    const r = rows[0];
    return r ? {
      ref, domain: 'agenda', label: r.title, detail: frDate(r.date), text: r.title, assetId: assetIds[0] ?? null, date: r.date, endDate: r.date,
      source: { id: `agenda_${id}`, type: 'agenda_item', title: r.title, content: r.date ?? '', relevanceScore: 1, meta: { date: r.date } },
    } : null;
  },
};

const documentProvider: BusinessSourceProvider = {
  domain: 'document',
  async list(accountId, { ids, need }) {
    if (!need.terms.length) return null;
    const docs = (await pgClient.unsafe(
      `SELECT f.id, coalesce(nullif(f.retained_title, ''), f.original_filename, 'Document') AS title, f.supplier,
              to_char(f.document_date, 'YYYY-MM-DD') AS date, f.amount_cents AS "amountCents", f.document_type_code AS type
         FROM asset_files f
        WHERE f.account_id = $1 AND f.deleted_at IS NULL AND (f.amount_cents IS NOT NULL OR f.document_date IS NOT NULL)
          AND ($2::int[] IS NULL
               OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id
                           AND l.status = 'ACTIVE' AND l.asset_id = ANY($2::int[]))
               OR f.asset_id = ANY($2::int[]) OR f.linked_asset_id = ANY($2::int[]))
        ORDER BY f.document_date DESC NULLS LAST, f.id DESC LIMIT ${MAX_DOCUMENTS}`,
      [accountId, ids.length ? ids : null] as never[],
    )) as unknown as Array<{ id: number; title: string; supplier: string | null; date: string | null; amountCents: number | null; type: string | null }>;
    return docs.map((d): BusinessSource => {
      const id = Number(d.id);
      return {
        ref: `document:${id}`, domain: 'document', label: d.title,
        detail: [d.supplier, frDate(d.date), d.amountCents != null ? formatEur(Number(d.amountCents)) : null].filter(Boolean).join(' · ') || null,
        text: `${d.title} ${d.supplier ?? ''} ${d.type ?? ''}`, assetId: ids.length === 1 ? ids[0] : null, provider: d.supplier ?? null,
        amountCents: d.amountCents == null ? null : Number(d.amountCents), date: d.date,
        // Lot 59 (#419 R01/R02) : la date d'un document est sa `document_date`
        // (jamais une fin de contrat) ; nature du montant (facturé, réglé, devis).
        meta: { dateKind: 'document_date', amountNature: amountNatureOf(d.type) },
        source: { id: `doc_${id}`, type: 'document', title: d.title, content: `${d.title}${d.date ? ` · ${d.date}` : ''}${d.amountCents != null ? ` · montant : ${formatEur(Number(d.amountCents))}` : ''}`, relevanceScore: 1, meta: { fileId: id, date: d.date } },
      };
    });
  },
  async read(accountId, ref, { assetIds }) {
    const id = Number(ref.split(':')[1]);
    const rows = (await pgClient.unsafe(
      `SELECT f.id, coalesce(nullif(f.retained_title, ''), f.original_filename, 'Document') AS title, f.supplier,
              to_char(f.document_date, 'YYYY-MM-DD') AS date, f.amount_cents AS "amountCents", f.document_type_code AS type
         FROM asset_files f WHERE f.id = $1 AND f.account_id = $2 AND f.deleted_at IS NULL
          AND ($3::int[] IS NULL
               OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id
                           AND l.status = 'ACTIVE' AND l.asset_id = ANY($3::int[]))
               OR f.asset_id = ANY($3::int[]) OR f.linked_asset_id = ANY($3::int[]))`,
      [id, accountId, assetIds.length ? assetIds : null] as never[],
    )) as unknown as Array<{ id: number; title: string; supplier: string | null; date: string | null; amountCents: number | null; type: string | null }>;
    const d = rows[0];
    return d ? {
      ref, domain: 'document', label: d.title, detail: [d.supplier, frDate(d.date)].filter(Boolean).join(' · ') || null, text: d.title,
      assetId: assetIds[0] ?? null, provider: d.supplier ?? null, amountCents: d.amountCents == null ? null : Number(d.amountCents), date: d.date,
      meta: { dateKind: 'document_date', amountNature: amountNatureOf(d.type) },
      source: { id: `doc_${id}`, type: 'document', title: d.title, content: `${d.title}${d.date ? ` · ${d.date}` : ''}`, relevanceScore: 1, meta: { fileId: id, date: d.date } },
    } : null;
  },
};

/** Fournisseurs enregistrés, dans l'ordre de lecture (aucune priorité de sélection). */
const PROVIDERS: BusinessSourceProvider[] = [operationProvider, fieldProvider, agendaProvider, documentProvider];

/**
 * Enregistre (ou remplace) le fournisseur d'un domaine — extensibilité
 * (#419 écart 8). Rend une fonction de retrait (tests, désactivation).
 */
export function registerBusinessSourceProvider(p: BusinessSourceProvider): () => void {
  const i = PROVIDERS.findIndex((x) => x.domain === p.domain);
  const precedent = i >= 0 ? PROVIDERS[i] : null;
  if (i >= 0) PROVIDERS[i] = p; else PROVIDERS.push(p);
  if (p.descriptor) registerSourceDomain(p.descriptor);
  return () => {
    const j = PROVIDERS.indexOf(p);
    if (j < 0) return;
    if (precedent) PROVIDERS[j] = precedent; else PROVIDERS.splice(j, 1);
  };
}

/**
 * Sources métier d'un périmètre (biens disponibles déjà résolus par le
 * serveur). Chaque fournisseur est indépendant : une lecture en échec ne
 * prive pas T2 des autres (trace : `domains`).
 */
export async function listBusinessSources(accountId: number, req: {
  assetIds: number[];
  assetNames?: Record<number, string>;
  need: SemanticNeed;
}): Promise<{ sources: BusinessSource[]; domains: string[] }> {
  const ids = req.assetIds.filter((x) => Number.isSafeInteger(x) && x > 0);
  const nom = (id: number | null) => (id != null ? req.assetNames?.[id] ?? null : null);
  const domains: string[] = [];
  const out: BusinessSource[] = [];
  for (const p of PROVIDERS) {
    try {
      const r = await p.list(accountId, { ids, nom, need: req.need });
      if (!r) continue;
      domains.push(p.domain);
      out.push(...r);
    } catch (e) {
      console.warn(`[assistant] sources métier : ${p.domain} illisible —`, (e as Error).message);
    }
  }
  return { sources: out, domains };
}

/**
 * Relit UNE source métier par sa référence (reprise après clarification) :
 * toujours du compte, toujours disponible — sinon `null` (choix refusé).
 * Le choix de l'utilisateur n'est jamais cru sur parole.
 */
export async function readBusinessSource(accountId: number, ref: string, ctx: { assetIds: number[]; assetNames?: Record<number, string> } = { assetIds: [] }): Promise<BusinessSource | null> {
  const [domain, a] = ref.split(':');
  const id = Number(a);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const p = PROVIDERS.find((x) => x.domain === domain);
  if (!p?.read) return null;
  const nom = (x: number | null) => (x != null ? ctx.assetNames?.[x] ?? null : null);
  return p.read(accountId, ref, { assetIds: ctx.assetIds, nom });
}

/** Réponse SERVEUR depuis une source métier choisie (pure, testée) — lecture canonique, aucune génération. */
export function answerFromBusinessSource(
  s: BusinessSource, need: ValueNeed | null,
  ctx: { assetName?: string | null; period?: { from: string; to: string; label: string } | null } = {},
): { text: string; sources: RetrievedSource[] } {
  const sources = s.source ? [s.source] : [];
  const pour = ctx.assetName ? ` (${ctx.assetName})` : '';
  const meta = (s.meta ?? {}) as Record<string, unknown>;
  if (s.domain === 'field') {
    const v = String(meta.display ?? s.detail ?? '');
    return { text: `${s.label}${pour} : ${v}.`, sources };
  }
  if (need === 'amount' && ctx.period && s.domain === 'operation') {
    // ══════════════════════════════════════════════════════════════════════
    // Lot 53 (PO D21) — PÉRIODE DEMANDÉE : jamais le total de toute la vie
    // de l'opération à la place de celui de la période. Seuls les montants
    // réalisés DATÉS dans la période sont comptés ; aucun → absence dite.
    // ══════════════════════════════════════════════════════════════════════
    const p = ctx.period;
    const realises = Array.isArray(meta.realized) ? (meta.realized as Array<{ cents: number; date: string | null }>) : [];
    const dans = realises.filter((r) => r.date && r.date.slice(0, 10) >= p.from && r.date.slice(0, 10) <= p.to)
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    if (!dans.length) return { text: `${s.label}${pour} : aucun montant documenté sur ${p.label}.`, sources };
    const total = dans.reduce((n, r) => n + r.cents, 0);
    if (dans.length === 1) return { text: `${s.label}${pour} : ${formatEur(total)} documenté sur ${p.label} (${frDate(dans[0].date)}).`, sources };
    return { text: `${s.label}${pour} : total documenté ${formatEur(total)} sur ${p.label} (${dans.length} montants, dernier ${formatEur(dans[0].cents)} le ${frDate(dans[0].date)}).`, sources };
  }
  if (need === 'amount' && ctx.period && s.domain === 'document' && s.amountCents != null) {
    const d = s.date ? String(s.date).slice(0, 10) : null;
    if (!d || d < ctx.period.from || d > ctx.period.to) return { text: `« ${s.label} »${pour} : aucun montant documenté sur ${ctx.period.label}.`, sources };
  }
  if (need === 'amount') {
    if (s.domain === 'operation') {
      const total = typeof meta.totalCents === 'number' ? meta.totalCents : null;
      const n = typeof meta.realizedCount === 'number' ? meta.realizedCount : 0;
      const lastDate = typeof meta.lastDate === 'string' ? meta.lastDate : null;
      const prevu = typeof meta.forecastCents === 'number' ? meta.forecastCents : null;
      if (s.amountCents == null) return { text: `${s.label}${pour} : aucun montant n’est encore documenté.`, sources };
      if (n === 0 && prevu != null) return { text: `${s.label}${pour} : tarif annoncé ${formatEur(prevu)} (prévisionnel, aucun règlement documenté).`, sources };
      const parts = [`dernier montant documenté ${formatEur(s.amountCents)}${lastDate ? ` (${frDate(lastDate)})` : ''}`];
      if (total != null && n > 1) parts.push(`total documenté ${formatEur(total)} sur ${n} montants`);
      return { text: `${s.label}${pour} : ${parts.join(' ; ')}.`, sources };
    }
    if (s.amountCents == null) return { text: `« ${s.label} »${pour} ne porte pas de montant lisible.`, sources };
    // Lot 59 (#419 R01) : réalisé, réglé et prévisionnel ne se confondent pas.
    const nature = meta.amountNature === 'payment' ? 'montant réglé ' : meta.amountNature === 'forecast' ? 'montant prévisionnel (devis) ' : '';
    return { text: `« ${s.label} »${pour} : ${nature}${formatEur(s.amountCents)}${s.date ? ` (${frDate(s.date)})` : ''}.`, sources };
  }
  if (need === 'end_date' || need === 'date') {
    if (s.domain === 'operation') {
      if (need === 'end_date') {
        return {
          text: s.endDate ? `${s.label}${pour} se termine le ${frDate(s.endDate)}.` : `${s.label}${pour} : aucune date de fin n’est renseignée.`,
          sources,
        };
      }
      const d = s.endDate ?? s.date;
      return { text: d ? `${s.label}${pour} : ${frDate(d)}.` : `${s.label}${pour} : aucune date n’est renseignée.`, sources };
    }
    // Lot 59 (#419 R02) : une date de FIN n'est jamais la date du document.
    if (need === 'end_date') {
      return { text: s.endDate ? `« ${s.label} »${pour} : le ${frDate(s.endDate)}.` : `« ${s.label} »${pour} : aucune date de fin n’est renseignée.`, sources };
    }
    const d = s.endDate ?? s.date;
    return { text: d ? `« ${s.label} »${pour} : le ${frDate(d)}.` : `« ${s.label} »${pour} : aucune date n’est renseignée.`, sources };
  }
  return { text: `${s.label}${pour}${s.detail ? ` : ${s.detail}` : ''}.`, sources };
}
