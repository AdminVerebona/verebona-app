/**
 * Matrice de traçabilité EXÉCUTABLE de la recette Opérations V1 (lot 48,
 * O10 — CDC Opérations V1 C29, C31 ACC-021, C32, C34, B33).
 *
 * Source de vérité : `docs/recette/operations-v1-matrice.json` (versionnée).
 * Rendu lisible : `docs/recette/operations-v1-matrice.md`, régénéré par
 * `npm run recette:matrice` (ce module, `renderMatrixMarkdown`) ; le test
 * `src/test/recette/__tests__/o10-matrice.test.ts` vérifie que les deux
 * concordent et que la matrice est COMPLÈTE (`checkMatrix`).
 *
 * Règles (aucune exception silencieuse) :
 *   · les 200 cas F-001…F-200, les 22 ACC, les 26 INV-FINAL et les 60
 *     invariants B33 sont présents, une seule fois ;
 *   · AUTOMATISE / AUTOMATISE_PREPROD : chaque fichier de test cité existe et
 *     CONTIENT l'identifiant ; à défaut de fichier, « via » ne cite que des
 *     entrées elles-mêmes automatisées ;
 *   · AUTOMATISE_PREPROD / RECETTE_PREPROD : procédure de recette préprod
 *     existante, avec ses étapes ;
 *   · HORS_PERIMETRE : décision PO citée (Qn connue) ;
 *   · ECART : écart décrit, avec proposition, et comportement actuel couvert
 *     par un test ;
 *   · NON_COUVERT : interdit.
 * Module PUR (lectures injectées) : aucun accès base, utilisable en script.
 */

export const MATRIX_STATUSES = ['AUTOMATISE', 'AUTOMATISE_PREPROD', 'RECETTE_PREPROD', 'HORS_PERIMETRE', 'ECART', 'NON_COUVERT'] as const;
export type MatrixStatus = (typeof MATRIX_STATUSES)[number];

export interface MatrixItem {
  id: string;
  famille: 'C29' | 'C31' | 'C34' | 'B33';
  domaine: string;
  trace: string;
  scenario: string;
  attendu: string;
  statut: MatrixStatus;
  tests: string[];
  via?: string[];
  preprod?: string;
  decision?: string;
  ecart?: string;
  note?: string;
}

export interface MatrixProcedure { id: string; titre: string; etapes: string[]; attendu: string }
export interface MatrixEcart { id: string; cas: string[]; constat: string; proposition: string; gravite: string }

export interface MatrixDocument {
  titre: string;
  cdc: string;
  regle: string;
  decisions: Record<string, string>;
  procedures: MatrixProcedure[];
  ecarts: MatrixEcart[];
  items: MatrixItem[];
}

export const MATRIX_JSON_PATH = 'docs/recette/operations-v1-matrice.json';
export const MATRIX_MD_PATH = 'docs/recette/operations-v1-matrice.md';

const pad = (n: number) => String(n).padStart(3, '0');
/** Identifiants attendus, dans l'ordre de la matrice. */
export function expectedIds(): string[] {
  const r = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${pad(i + 1)}`);
  return [...r('F-', 200), ...r('ACC-', 22), ...r('INV-FINAL-', 26), ...r('INV-', 60)];
}

export interface MatrixFs {
  exists(path: string): boolean;
  read(path: string): string;
}

const AUTOMATISES: ReadonlySet<MatrixStatus> = new Set(['AUTOMATISE', 'AUTOMATISE_PREPROD']);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Problèmes de la matrice (liste vide = matrice complète et exacte). */
export function checkMatrix(doc: MatrixDocument, fs: MatrixFs): string[] {
  const pb: string[] = [];
  const ids = doc.items.map((i) => i.id);
  const attendus = expectedIds();
  const manquants = attendus.filter((x) => !ids.includes(x));
  if (manquants.length) pb.push(`identifiants absents de la matrice : ${manquants.join(', ')}`);
  const doublons = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (doublons.length) pb.push(`identifiants en double : ${[...new Set(doublons)].join(', ')}`);
  const inconnus = ids.filter((x) => !attendus.includes(x));
  if (inconnus.length) pb.push(`identifiants inconnus : ${inconnus.join(', ')}`);

  const parId = new Map(doc.items.map((i) => [i.id, i]));
  const procedures = new Map(doc.procedures.map((p) => [p.id, p]));
  const ecarts = new Map(doc.ecarts.map((e) => [e.id, e]));
  const contenu = new Map<string, string>();
  const lire = (f: string) => {
    if (!contenu.has(f)) contenu.set(f, fs.exists(f) ? fs.read(f) : '');
    return contenu.get(f)!;
  };

  for (const p of doc.procedures) if (!p.etapes.length || !p.attendu) pb.push(`${p.id} : procédure sans étape ou sans résultat attendu`);
  for (const e of doc.ecarts) {
    if (!e.proposition || !e.constat) pb.push(`${e.id} : écart sans constat ou sans proposition`);
    for (const c of e.cas) if (!parId.has(c)) pb.push(`${e.id} : cas inconnu ${c}`);
  }

  for (const i of doc.items) {
    if (!(MATRIX_STATUSES as readonly string[]).includes(i.statut)) { pb.push(`${i.id} : statut inconnu « ${i.statut} »`); continue; }
    if (i.statut === 'NON_COUVERT') { pb.push(`${i.id} : non couvert (ni test, ni recette préprod, ni décision)`); continue; }
    for (const f of i.tests) {
      if (!fs.exists(f)) pb.push(`${i.id} : fichier de test absent ${f}`);
      else if (!new RegExp(`\\b${escapeRe(i.id)}\\b`).test(lire(f))) pb.push(`${i.id} : identifiant absent du fichier de test ${f}`);
    }
    if (AUTOMATISES.has(i.statut)) {
      if (!i.tests.length && !i.via?.length) pb.push(`${i.id} : automatisé sans test ni « via »`);
      for (const v of i.via ?? []) {
        const cible = parId.get(v);
        if (!cible) pb.push(`${i.id} : via ${v} inconnu`);
        else if (!AUTOMATISES.has(cible.statut) || (!cible.tests.length && !(cible.via?.length))) pb.push(`${i.id} : via ${v} non automatisé`);
        else if (cible.via?.includes(i.id)) pb.push(`${i.id} : via circulaire avec ${v}`);
      }
    }
    if (i.statut === 'AUTOMATISE_PREPROD' || i.statut === 'RECETTE_PREPROD') {
      if (!i.preprod || !procedures.has(i.preprod)) pb.push(`${i.id} : procédure de recette préprod absente (${i.preprod ?? '—'})`);
    }
    if (i.statut === 'HORS_PERIMETRE') {
      // Lot 83D : décisions PO « V-Q… » (CDC Opérations v5) admises au même titre que « Q… ».
      const q = /\b(?:V-)?Q\d+\b/.exec(i.decision ?? '')?.[0];
      if (!q || !doc.decisions[q]) pb.push(`${i.id} : hors périmètre sans décision PO connue`);
    }
    if (i.statut === 'ECART') {
      if (!i.ecart || !ecarts.has(i.ecart)) pb.push(`${i.id} : écart non décrit`);
      if (!i.tests.length) pb.push(`${i.id} : écart sans test du comportement actuel`);
    }
  }
  return pb;
}

export interface MatrixSummary {
  total: number;
  byStatus: Record<MatrixStatus, number>;
  byFamily: Record<string, Record<MatrixStatus, number>>;
}

export function summarizeMatrix(doc: MatrixDocument): MatrixSummary {
  const vide = () => Object.fromEntries(MATRIX_STATUSES.map((s) => [s, 0])) as Record<MatrixStatus, number>;
  const byStatus = vide();
  const byFamily: Record<string, Record<MatrixStatus, number>> = {};
  for (const i of doc.items) {
    byStatus[i.statut]++;
    (byFamily[i.famille] ??= vide())[i.statut]++;
  }
  return { total: doc.items.length, byStatus, byFamily };
}

const LIBELLE: Record<MatrixStatus, string> = {
  AUTOMATISE: 'AUTOMATISÉ',
  AUTOMATISE_PREPROD: 'AUTOMATISÉ + RECETTE PRÉPROD',
  RECETTE_PREPROD: 'RECETTE PRÉPROD',
  HORS_PERIMETRE: 'HORS PÉRIMÈTRE',
  ECART: 'ÉCART',
  NON_COUVERT: 'NON COUVERT',
};
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const court = (f: string) => f.replace(/^src\//, '').replace(/^test\/e2e\/scenarios\//, 'e2e/');

/** Rendu Markdown déterministe (même entrée → même texte). */
export function renderMatrixMarkdown(doc: MatrixDocument): string {
  const s = summarizeMatrix(doc);
  const out: string[] = [];
  out.push(`# ${doc.titre}`, '');
  out.push('> Fichier GÉNÉRÉ depuis `docs/recette/operations-v1-matrice.json` par `npm run recette:matrice` — ne pas modifier à la main.', '');
  out.push(`**Référence** : ${doc.cdc}.`, '', `**Règle** : ${doc.regle}`, '');
  out.push('## Synthèse', '', '| Famille | Total | Automatisés | dont + recette préprod | Recette préprod seule | Hors périmètre | Écarts |', '|---|---|---|---|---|---|---|');
  for (const [f, c] of Object.entries(s.byFamily)) {
    const tot = Object.values(c).reduce((a, b) => a + b, 0);
    out.push(`| ${f} | ${tot} | ${c.AUTOMATISE + c.AUTOMATISE_PREPROD} | ${c.AUTOMATISE_PREPROD} | ${c.RECETTE_PREPROD} | ${c.HORS_PERIMETRE} | ${c.ECART} |`);
  }
  const b = s.byStatus;
  out.push(`| **Total** | **${s.total}** | **${b.AUTOMATISE + b.AUTOMATISE_PREPROD}** | **${b.AUTOMATISE_PREPROD}** | **${b.RECETTE_PREPROD}** | **${b.HORS_PERIMETRE}** | **${b.ECART}** |`, '');
  out.push('## Décisions PO citées', '');
  for (const [k, v] of Object.entries(doc.decisions)) out.push(`- **${k}** — ${v}`);
  out.push('', '## Écarts tracés', '');
  for (const e of doc.ecarts) out.push(`- **${e.id}** (${e.cas.join(', ')} ; gravité ${e.gravite}) — ${e.constat} *Proposition :* ${e.proposition}`);
  out.push('', '## Procédures de recette préprod', '');
  for (const p of doc.procedures) {
    out.push(`### ${p.id} — ${p.titre}`, '');
    p.etapes.forEach((e, n) => out.push(`${n + 1}. ${e}`));
    out.push('', `*Attendu :* ${p.attendu}`, '');
  }
  const sections: Array<[string, string]> = [['C29', 'C29 — Matrice de recette fonctionnelle (F-001 à F-200)'], ['C31', 'C31 — Critères d’acceptation globaux'], ['C34', 'C34 — Invariants finaux de livraison'], ['B33', 'B33 — Invariants normatifs']];
  for (const [fam, titre] of sections) {
    out.push(`## ${titre}`, '');
    out.push(fam === 'C29' ? '| ID | Domaine (C32) | Scénario | Attendu | Statut | Couverture |' : '| ID | Énoncé | Statut | Couverture |');
    out.push(fam === 'C29' ? '|---|---|---|---|---|---|' : '|---|---|---|---|');
    for (const i of doc.items.filter((x) => x.famille === fam)) {
      const couv = [
        i.tests.length ? i.tests.map((t) => `\`${court(t)}\``).join('<br>') : '',
        i.via?.length ? `via ${i.via.join(', ')}` : '',
        i.preprod ? `préprod ${i.preprod}` : '',
        i.decision ? `décision : ${i.decision}` : '',
        i.ecart ? `écart ${i.ecart}` : '',
        i.note ? `*${i.note}*` : '',
      ].filter(Boolean).join('<br>');
      out.push(fam === 'C29'
        ? `| ${i.id} | ${cell(i.trace)} | ${cell(i.scenario)} | ${cell(i.attendu)} | ${LIBELLE[i.statut]} | ${cell(couv)} |`
        : `| ${i.id} | ${cell(i.scenario)} | ${LIBELLE[i.statut]} | ${cell(couv)} |`);
    }
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}
