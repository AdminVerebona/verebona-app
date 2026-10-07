/**
 * Lecture ciblée de PLUSIEURS champs canoniques — tickets 12, 13 et 8a (lot 29).
 *
 * La cible est résolue UNE fois (bien, équipement ou pièce) ; chaque champ
 * demandé est lu par l'abstraction canonique de sa cible (`readCanonicalField`
 * pour un bien, `readCanonicalEntityField` pour un équipement / une pièce),
 * jamais par une lecture brute de la fiche ni par le modèle. Lectures en
 * parallèle, résultats RANGÉS dans l'ordre de la demande (dédoublonnée).
 *
 * Statut par champ :
 *   VALUE_FOUND             valeur canonique (ou, si absente, fait documentaire
 *                           du même champ — cascade par champ, §G) ;
 *   MISSING_CANONICAL_VALUE cible trouvée, valeur non renseignée ;
 *   FIELD_NOT_APPLICABLE    champ sans objet pour cette cible (famille, type) ;
 *   FIELD_UNAVAILABLE       clé hors registre / non lisible, ou lecture en échec.
 * Un champ vide n'annule jamais les valeurs trouvées ; une source et une
 * affirmation PAR champ (§H, §I).
 *
 * Champs `sensitive` (8a) : restitués à leur propriétaire dans la réponse
 * DÉTERMINISTE ; leurs sources ne les portent jamais en clair (modèle, traces).
 * Aucun appel modèle ici.
 */
import type { Claim, RetrievedSource } from '../types/sources';
import { fieldTargetTypes, getField, toAssetFamily, type CanonicalFieldDef } from '@/services/canonical/registry';
import type { CanonicalEntityFieldReading, CanonicalFieldReading } from '../canonical/field-reader';
import type { DocumentFieldFact } from '../canonical/field-document';
import { dedupeFacts } from '../canonical/field-vocabulary';
import { TargetReadError } from './t2-diagnostics';

export type FactStatus = 'VALUE_FOUND' | 'MISSING_CANONICAL_VALUE' | 'FIELD_NOT_APPLICABLE' | 'FIELD_UNAVAILABLE';

export interface FactResult {
  /** Clé demandée (telle que reçue). */
  requested: string;
  /** Clé canonique (null : hors registre). */
  key: string | null;
  label: string;
  status: FactStatus;
  /** Valeur restituée (null sauf VALUE_FOUND). */
  display: string | null;
  /** D'où vient la valeur. */
  from: 'canonical' | 'document' | 'entities' | null;
  /** Phrase de l'affirmation de CE champ. */
  text: string | null;
  sourceIds: string[];
  sensitive: boolean;
  /** Lecture en échec (erreur technique, tracée). */
  failed?: boolean;
}

/** Cible lue : un bien, ou un équipement / une pièce avec son bien parent. */
export type FactTarget =
  | { type: 'asset'; id: number; name: string | null; category?: string | null }
  | { type: 'equipment' | 'room'; id: number; name: string | null; assetId: number | null; assetName?: string | null };

export interface FactReaders {
  field(accountId: number, assetId: number, key: string): Promise<CanonicalFieldReading | null>;
  entityField?(accountId: number, target: { type: 'EQUIPMENT' | 'ROOM'; id: number }, key: string): Promise<CanonicalEntityFieldReading | null>;
  /** Cascade par champ : fait documentaire d'un champ absent de la fiche. */
  documentFact?(accountId: number, assetId: number, key: string): Promise<DocumentFieldFact | null>;
  /** Sources (fonctions pures, injectables). */
  assetSource(r: CanonicalFieldReading): RetrievedSource;
  entitySource(r: CanonicalEntityFieldReading): RetrievedSource;
  documentSource(f: DocumentFieldFact, assetId: number): RetrievedSource;
  /** Phrase d'un champ de bien (`fieldAnswer`, inchangée pour un seul champ). */
  fieldAnswer(r: CanonicalFieldReading): string;
}

export interface FactReading {
  target: FactTarget;
  facts: FactResult[];
  sources: RetrievedSource[];
  claims: Claim[];
  text: string;
  strategy: string;
  /** Aucune valeur restituée, au moins un champ non renseigné. */
  allMissing: boolean;
}

const lowerFirst = (s: string) => (/^[A-ZÉÈ][a-zà-ÿ]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** Statut d'un champ sans valeur pour un bien (pure) : sans objet si la famille l'exclut. */
function statutSansValeur(def: CanonicalFieldDef | undefined, category: string | null | undefined): FactStatus {
  const fam = toAssetFamily(category ?? null);
  return def && fam && !def.families.includes(fam) ? 'FIELD_NOT_APPLICABLE' : 'MISSING_CANONICAL_VALUE';
}

/** Valeur composée d'un champ (ex. adresse complète), à partir des lectures de ses composants. */
function composer(def: CanonicalFieldDef, lectures: Map<string, CanonicalFieldReading | null>): string | null {
  if (!def.composedDisplay?.length) return null;
  const groupes = def.composedDisplay
    .map((g) => g.map((k) => lectures.get(k)?.display).filter((x): x is string => !!x && x.trim() !== '').join(' '))
    .filter(Boolean);
  return groupes.length ? groupes.join(', ') : null;
}

async function protege<T>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: Error }> {
  try { return { ok: true, v: await p }; } catch (e) { return { ok: false, e: e as Error }; }
}

/**
 * Lit les champs demandés sur UNE cible (ordre conservé, ≤ 20, dédoublonnés).
 * Lève `TargetReadError` si TOUTES les lectures ont échoué (erreur technique,
 * jamais un faux « non renseigné »).
 */
export async function readFactsOnTarget(
  accountId: number,
  target: FactTarget,
  requestedFacts: readonly string[],
  readers: FactReaders,
): Promise<FactReading> {
  const cles = dedupeFacts(requestedFacts);
  const nom = target.name ?? (target.type === 'asset' ? 'ce bien' : target.type === 'room' ? 'la pièce' : 'l’équipement');

  const lus = await Promise.all(cles.map(async (requested): Promise<{ fact: FactResult; sources: RetrievedSource[] }> => {
    const def0 = getField(requested);
    const key = def0 ? requested : null;
    const resolved = key ?? (await import('../canonical/field-reader')).canonicalKeyOf(requested);
    const def = resolved ? getField(resolved) : undefined;
    const base: FactResult = {
      requested, key: def?.key ?? null, label: def?.label ?? requested, status: 'FIELD_UNAVAILABLE',
      display: null, from: null, text: null, sourceIds: [], sensitive: def?.sensitive === true,
    };
    if (!def || !def.assistantReadable) return { fact: base, sources: [] };

    // ── Équipement / pièce : lecture de CETTE entité (13 §J) ─────────────
    if (target.type !== 'asset') {
      const typeCible = target.type === 'room' ? 'ROOM' : 'EQUIPMENT';
      if (!fieldTargetTypes(def).includes(typeCible)) return { fact: { ...base, status: 'FIELD_NOT_APPLICABLE' }, sources: [] };
      if (!readers.entityField) return { fact: base, sources: [] };
      const r = await protege(readers.entityField(accountId, { type: typeCible, id: target.id }, def.key));
      if (!r.ok) return { fact: { ...base, failed: true }, sources: [] };
      if (!r.v) return { fact: base, sources: [] };
      const src = readers.entitySource(r.v);
      if (r.v.display === null || r.v.display === '') {
        return { fact: { ...base, status: 'MISSING_CANONICAL_VALUE', sourceIds: [src.id] }, sources: [src] };
      }
      const nomE = r.v.entityName ?? nom;
      const origine = r.v.originLabel ? ` Valeur ${r.v.originLabel}${r.v.evidence?.documentTitle && r.v.origin !== 'USER' ? ` (« ${r.v.evidence.documentTitle} »)` : ''}.` : '';
      return {
        fact: { ...base, status: 'VALUE_FOUND', display: r.v.display, from: 'canonical', text: `${def.label} de ${nomE} : ${r.v.display}.${origine}`, sourceIds: [src.id] },
        sources: [src],
      };
    }

    // ── Bien : lecture canonique (8a, 12) ─────────────────────────────────
    const r = await protege(readers.field(accountId, target.id, def.key));
    if (!r.ok) return { fact: { ...base, failed: true }, sources: [] };
    if (!r.v) return { fact: base, sources: [] };
    const reading = r.v;
    const src = readers.assetSource(reading);
    const aValeur = reading.value !== null && reading.value !== undefined && !!reading.display;
    if (aValeur) {
      // Restitution composée (adresse complète) : composants lus sur la même fiche.
      let lecture = reading;
      const sources = [src];
      if (def.composedDisplay?.length) {
        const autres = [...new Set(def.composedDisplay.flat())].filter((k) => k !== def.key);
        const comp = new Map<string, CanonicalFieldReading | null>([[def.key, reading]]);
        for (const k of autres) {
          const x = await protege(readers.field(accountId, target.id, k));
          comp.set(k, x.ok ? x.v : null);
          if (x.ok && x.v && x.v.display) sources.push(readers.assetSource(x.v));
        }
        const compose = composer(def, comp);
        if (compose) lecture = { ...reading, display: compose };
      }
      return {
        fact: { ...base, status: 'VALUE_FOUND', display: lecture.display, from: 'canonical', text: readers.fieldAnswer(lecture), sourceIds: sources.map((s) => s.id) },
        sources,
      };
    }
    // Champ vide sur le bien, renseigné sur ses équipements / pièces (lot 18) :
    // restitution AGRÉGÉE (« les numéros de série des équipements »).
    if (reading.entities?.some((e) => e.display)) {
      return {
        fact: { ...base, status: 'VALUE_FOUND', display: null, from: 'entities', text: readers.fieldAnswer(reading), sourceIds: [src.id] },
        sources: [src],
      };
    }
    // Cascade documentaire PAR CHAMP (§G) : seulement pour un champ absent.
    if (readers.documentFact) {
      const d = await protege(readers.documentFact(accountId, target.id, def.key));
      if (d.ok && d.v) {
        const ds = readers.documentSource(d.v, target.id);
        return {
          fact: {
            ...base, status: 'VALUE_FOUND', display: d.v.display, from: 'document',
            text: `${def.label} de ${reading.assetName ?? nom} : ${d.v.display} (lu dans « ${d.v.documentTitle ?? 'un document'} », pas encore enregistré sur la fiche).`,
            sourceIds: [ds.id],
          },
          sources: [ds],
        };
      }
    }
    const statut = statutSansValeur(def, target.category);
    return { fact: { ...base, status: statut, sourceIds: statut === 'MISSING_CANONICAL_VALUE' ? [src.id] : [] }, sources: statut === 'MISSING_CANONICAL_VALUE' ? [src] : [] };
  }));

  const facts = lus.map((x) => x.fact);
  if (facts.length > 0 && facts.every((f) => f.failed)) {
    throw new TargetReadError(`lecture canonique impossible (${target.type} ${target.id}, ${cles.length} champ(s))`);
  }
  // Une source par identifiant (une valeur composée peut partager un composant).
  const sources = [...new Map(lus.flatMap((x) => x.sources).map((s) => [s.id, s])).values()];
  const trouves = facts.filter((f) => f.status === 'VALUE_FOUND');
  const manquants = facts.filter((f) => f.status === 'MISSING_CANONICAL_VALUE');
  const sansObjet = facts.filter((f) => f.status === 'FIELD_NOT_APPLICABLE');
  const libelles = (l: FactResult[]) => l.map((f) => lowerFirst(f.label)).join(', ');

  let text: string;
  if (facts.filter((f) => f.status !== 'FIELD_UNAVAILABLE').length <= 1 && trouves.length === 1) {
    // Un seul champ : réponse inchangée (AC13 ticket 12).
    text = trouves[0].text!;
  } else if (trouves.length === 0) {
    const parts: string[] = [];
    if (manquants.length === 1) parts.push(`L’information « ${manquants[0].label} » n’est pas renseignée pour ${nom}.`);
    else if (manquants.length > 1) parts.push(`Ces informations ne sont pas renseignées pour ${nom} : ${libelles(manquants)}.`);
    if (sansObjet.length) parts.push(`${sansObjet.length > 1 ? 'Ces informations ne s’appliquent' : `L’information « ${sansObjet[0].label} » ne s’applique`} pas à ${nom}${sansObjet.length > 1 ? ` : ${libelles(sansObjet)}` : ''}.`);
    text = parts.join(' ') || `Je n’ai pas pu lire ces informations pour ${nom}.`;
  } else {
    // Plusieurs champs : une ligne par valeur, dans l'ordre de la demande,
    // puis les champs vides ou sans objet — jamais un « rien trouvé ».
    const lignes = trouves.map((f) => (f.from === 'canonical' && f.display ? `${lowerFirst(f.label)} : ${f.display}` : f.text!.replace(/\.$/, '')));
    const parts = [`Pour ${nom} : ${lignes.join(' ; ')}.`];
    if (manquants.length) parts.push(`Non renseigné${manquants.length > 1 ? 's' : ''} : ${libelles(manquants)}.`);
    if (sansObjet.length) parts.push(`Sans objet pour ce ${target.type === 'asset' ? 'bien' : target.type === 'room' ? 'type de pièce' : 'type d’équipement'} : ${libelles(sansObjet)}.`);
    text = parts.join(' ');
  }

  // Une affirmation PAR champ, reliée à SA source (§H).
  const claims: Claim[] = facts.filter((f) => f.status === 'VALUE_FOUND' || f.status === 'MISSING_CANONICAL_VALUE').map((f) => ({
    claimKey: `field:${f.key}`,
    text: f.status === 'VALUE_FOUND' ? f.text! : `${f.label} de ${nom} : non renseigné.`,
    sourceIds: f.sourceIds,
    derivation: 'direct' as const,
  }));
  const entite = target.type !== 'asset';
  const strategy = trouves.length === 0
    ? (manquants.length ? 'target.field_missing' : 'target.not_applicable')
    : trouves.length === 1 && facts.length === 1 && trouves[0].from === 'document' ? 'target.field_document'
      : facts.length > 1 ? (entite ? 'target.entity_fields' : 'target.asset_fields')
        : entite ? 'target.entity_field' : 'target.asset_field';
  return { target, facts, sources, claims, text, strategy, allMissing: trouves.length === 0 && manquants.length > 0 };
}
