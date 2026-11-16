/**
 * Lot 114G (Trello #760, audit T1 du 13/11 — P1-03 et P1-04) — IDENTITÉ D'UN
 * FAIT DE RÉPARATION ET LIENS LOCAUX fait ↔ unité de source.
 *
 * Deux défauts de la reprise différée (`retryDocument`) :
 *
 *   P1-03  la passe de réparation rend, pour chaque fait, les unités CIBLÉES
 *          qui le prouvent (`links`) ; la reprise les jetait et recalculait
 *          le rattachement sur tout le document — un passage présent à
 *          plusieurs endroits pouvait être rattaché à la mauvaise occurrence ;
 *   P1-04  un fait était réputé « déjà écrit » sur la seule égalité
 *          valeur + extrait : deux faits distincts (deux attributs, deux
 *          cibles) pouvaient être éliminés à tort.
 *
 * Fonctions PURES, sans base ni modèle. Aucune règle métier : l'identité
 * d'un fait est sa clé, sa valeur, sa cible et sa preuve précise.
 */

const plat = (s: unknown): string => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Ce qui permet de reconnaître le MÊME fait rendu par le modèle avant et après projection. */
export interface LinkableFact {
  rawKey?: string | null;
  label?: string | null;
  rawValue?: unknown;
  value?: unknown;
  normalizedValue?: unknown;
  evidence?: { excerpt?: string | null } | null;
}

/** Clé de correspondance fait rendu ↔ fait projeté (libellé d'origine, valeur d'origine, extrait). */
export function factLinkKey(f: LinkableFact): string {
  return [plat(f.rawKey ?? f.label), plat(f.rawValue ?? f.normalizedValue ?? f.value), plat(f.evidence?.excerpt).slice(0, 200)].join('\u0001');
}

/**
 * Liens locaux de la passe de réparation, consommés DANS L'ORDRE : deux faits
 * de même clé (même libellé, même valeur, même extrait) lus dans deux unités
 * différentes gardent chacun leur unité.
 */
export class LocalLinks {
  private readonly files = new Map<string, string[][]>();
  /**
   * Lot 115F (Trello #792, écart P1-03) : clés dont la file portait, À LA
   * CONSTRUCTION, des unités DIFFÉRENTES. L'information est retenue par clé et
   * non recalculée sur la file restante : sans cela, le DERNIER fait d'une file
   * épuisée était rendu comme un lien propre (`ordered: false`) alors que son
   * appariement reposait lui aussi sur l'ordre de lecture — le fallback de la
   * fin de file n'était jamais compté.
   */
  private readonly parOrdre = new Set<string>();

  constructor(links?: ReadonlyMap<LinkableFact, readonly string[]> | null) {
    for (const [f, ids] of links ?? []) {
      if (!ids.length) continue;
      const k = factLinkKey(f);
      this.files.set(k, [...(this.files.get(k) ?? []), [...ids]]);
    }
    for (const [k, file] of this.files) {
      if (new Set(file.map((l) => l.join('\u0001'))).size > 1) this.parOrdre.add(k);
    }
  }

  /** Unités qui prouvent ce fait d'après la zone ciblée ; `null` : aucun lien local exploitable. */
  take(f: LinkableFact): string[] | null {
    return this.takeDetailed(f)?.ids ?? null;
  }

  /**
   * Lot 115F (Trello #792, écart P1-03) — même consommation, en SIGNALANT le
   * fallback : `ordered` vaut `true` quand plusieurs faits de MÊME clé
   * (libellé, valeur, extrait) portent des unités DIFFÉRENTES — l'appariement
   * repose alors sur l'ordre de lecture, pas sur une preuve propre à chaque
   * fait. L'appelant le compte (jamais silencieux).
   */
  takeDetailed(f: LinkableFact): { ids: string[]; ordered: boolean } | null {
    const cle = factLinkKey(f);
    const file = this.files.get(cle);
    if (!file?.length) return null;
    // Le dernier lien reste disponible : une relecture du même fait garde sa preuve.
    return { ids: file.length > 1 ? file.shift()! : [...file[0]], ordered: this.parOrdre.has(cle) };
  }

  get size(): number { return this.files.size; }
}

/**
 * Lot 115F (Trello #792, écart P1-04) — EMPREINTES DES FAITS RENDUS, par fait.
 *
 * Règle remplacée : l'empreinte (`t1FactRef`) d'un fait projeté était prise
 * comme « la première empreinte connue pour cette clé de correspondance ».
 * Deux faits distincts de même libellé, même valeur et même extrait (deux
 * attributs, deux cibles) recevaient donc la MÊME empreinte, donc les mêmes
 * identifiants de faits persistés : les décisions de valeur de la reprise
 * pouvaient être rattachées au mauvais fait. Chaque fait consomme maintenant
 * SON empreinte, dans l'ordre de lecture ; la dernière reste disponible pour
 * une relecture du même fait.
 */
export class FactRefs {
  private readonly files = new Map<string, string[]>();

  constructor(facts: Iterable<LinkableFact & { t1FactRef?: string | null }>) {
    for (const f of facts) {
      if (!f.t1FactRef) continue;
      const k = factLinkKey(f);
      this.files.set(k, [...(this.files.get(k) ?? []), f.t1FactRef]);
    }
  }

  /** Empreinte de CE fait, sinon `null`. */
  take(f: LinkableFact): string | null {
    const file = this.files.get(factLinkKey(f));
    if (!file?.length) return null;
    return file.length > 1 ? file.shift()! : file[0];
  }

  get size(): number { return this.files.size; }
}

/** Identité d'un fait pour la déduplication d'une reprise. */
export interface FactIdentityInput {
  /** Clé canonique, sinon clé générique du fait. */
  key: string | null | undefined;
  value: string | null | undefined;
  excerpt: string | null | undefined;
  targetType?: string | null;
  targetEntityId?: number | string | null;
  /** Unités de source qui prouvent le fait — complétées à la relecture, hors identité. */
  sourceUnitIds?: readonly string[] | null;
}

/**
 * Identité d'un fait : clé, valeur, cible, extrait — la MÊME que celle de
 * l'analyse (`factFingerprint`, `mergeFacts`). Un même fait lu à deux
 * endroits (même numéro sur deux pages) reste UN fait, prouvé par plusieurs
 * unités : ses occurrences sont portées par `source_unit_ids`, jamais par
 * une seconde ligne.
 */
export function factCoreIdentity(f: FactIdentityInput): string {
  return [plat(f.key), plat(f.value), `${f.targetType ?? ''}:${f.targetEntityId ?? ''}`, plat(f.excerpt).slice(0, 200)].join('\u0001');
}

/**
 * Registre des faits déjà écrits d'un document. Un fait rendu par la
 * réparation est un DOUBLON seulement s'il a la même clé, la même valeur, la
 * même cible et le même extrait qu'un fait écrit. Deux attributs ou deux
 * cibles différents ne sont jamais confondus, même à valeur et extrait égaux.
 */
export class KnownFacts {
  private readonly parIdentite = new Map<string, number>();

  constructor(rows: ReadonlyArray<FactIdentityInput & { id: number }>) {
    for (const r of rows) this.add(r, r.id);
  }

  add(f: FactIdentityInput, id: number): void {
    const k = factCoreIdentity(f);
    if (!this.parIdentite.has(k)) this.parIdentite.set(k, id);
  }

  /** Identifiant du fait déjà écrit qui EST ce fait, sinon `null`. */
  match(f: FactIdentityInput): number | null {
    return this.parIdentite.get(factCoreIdentity(f)) ?? null;
  }
}
