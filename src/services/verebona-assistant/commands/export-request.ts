/**
 * Export demandé depuis l'Assistant — Trello #753, CDC T2 §9.10, §12.5 (`EXPORT_GENERATE`), §14.3 W28, D27.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE GÉNÉRATION DIRECTE, PAS UNE COMMANDE CONFIRMÉE
 *
 * Générer un export ne modifie aucune donnée métier : aucun plan, aucune
 * confirmation (D27). La demande est lancée tout de suite, HORS du flux des
 * commandes d'écriture, par la façade métier `export-request.facade` — le
 * même corps que `POST /api/assets/[id]/exports`. L'Assistant n'ajoute et ne
 * retire aucun droit : éligibilité du bien, offre (dossiers prêts à l'emploi
 * réservés aux offres qui y ont droit), dossier désactivé, seuils, plafond de
 * générations et limitation de débit sont ceux du service d'export, dont les
 * messages de refus sont repris tels quels.
 *
 *   · export de données brutes : ZIP produit dans la demande → lien de
 *     téléchargement (route existante, qui revérifie les droits à chaque clic) ;
 *   · dossier prêt à l'emploi : mis en file (présélections du service, comme
 *     une demande sans écran de préparation) → suivi dans les exports du bien.
 *
 * Reconnaissance SANS modèle et volontairement étroite : verbe d'action en
 * tête + export nommé. Toute autre phrase (« Comment exporter… ? ») rend
 * `null` et suit le parcours de réponse normal, comme avant.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { plain } from '../core/routing-text';
import { hrefBien } from '../core/entity-ref';
import { CARTE_EXPORT_EN_PREPARATION, CARTE_EXPORT_PRET } from '../core/export-card-state';
import { exportResultGroup, type ResultGroup } from '../core/result-groups';
import type { AssistantRequestInput } from '../types/contracts';
import {
  DOSSIER_CODES, DOSSIER_LABELS, DOSSIER_SHORT_LABELS, EXPORT_BRUT_CODE, EXPORT_BRUT_LABEL,
  isDossierEligibleForFamily, type ExportCode,
} from '@/services/exports/catalog';
import { debutUtile } from './parser';

// ── Reconnaissance (pure) ───────────────────────────────────────────────────

/** Brouillon d'une demande d'export : rien n'est lu ni lancé ici. */
export interface ExportDraft {
  /** Exports du catalogue désignés par la phrase : un seul = choisi ; plusieurs = à départager ; aucun = à demander. */
  codes: ExportCode[];
  /** Fichiers demandés avec le dossier (« en ZIP », « avec les fichiers »). Sans effet pour les données brutes (toujours un ZIP). */
  zip: boolean;
  /** Mots désignant le bien (« de la Clio »). */
  assetWords: string[];
  /** « de ce bien », « pour cette maison » : bien de la page ou de la conversation. */
  assetFromContext: boolean;
  /**
   * Passage 114AB (#753, W28) — CONTENU demandé par la phrase. Seul ce qui est DIT est posé ; une clé absente
   * laisse la présélection du service d'export (ce que faisait toute demande avant ce passage).
   *
   *   `photos`     : « avec / sans les photos » — pris en compte pour l'export des données brutes ET pour un
   *                  dossier prêt à l'emploi (option du tiroir historique, honorée par le service) ;
   *   `equipments` : « avec / sans les équipements » — seul l'export des données brutes sait le faire ; pour
   *                  un dossier, l'Assistant le DIT et ne lance rien (jamais une consigne ignorée en silence).
   */
  content: { photos?: boolean; equipments?: boolean };
}

/** « sans les photos » / « avec les photos » (et les équipements) : ce que la phrase dit du contenu (pure). */
function contenuDemande(reste: string): ExportDraft['content'] {
  const content: ExportDraft['content'] = {};
  const dit = (nom: string): boolean | undefined => {
    const sans = new RegExp(String.raw`\b(?:sans|hors|excepte|excepter|exclus|exclure|pas)\s+(?:les\s+|le\s+|la\s+|l'|de\s+|d')*${nom}`).test(reste);
    const avec = new RegExp(String.raw`\b(?:avec|incluant|inclus|inclure|y compris)\s+(?:les\s+|le\s+|la\s+|l'|ses\s+)*${nom}`).test(reste);
    return sans ? false : avec ? true : undefined;
  };
  const photos = dit('photos?');
  const equipements = dit('equipements?');
  if (photos !== undefined) content.photos = photos;
  if (equipements !== undefined) content.equipments = equipements;
  return content;
}

const VERBE = /^(?:exporte|exporter|genere|generer|prepare|preparer|telecharge|telecharger|cree|creer|produis|produire|constitue|constituer|fais|faire)(?:[- ](?:moi|nous))?\b/;
const VERBE_EXPORT = /^(?:exporte|exporter)\b/;
/** Nom qui désigne un export (sans lui, « prépare un rappel… » n'est pas une demande d'export). */
const NOM_EXPORT = /\b(?:dossiers?|kits?|carnets?|exports?|zip|donnees brutes)\b/;

/** Mots sans valeur pour désigner un export ou un bien (mots-outils, noms génériques des exports). */
const GENERIQUES = new Set([
  'de', 'du', 'des', 'd', 'la', 'le', 'les', 'l', 'un', 'une', 'a', 'au', 'aux', 'en', 'et', 'ou', 'pour', 'sur', 'avec', 'dans',
  'mon', 'ma', 'mes', 'notre', 'votre', 'ce', 'cet', 'cette', 'moi', 'nous', 'stp', 'svp', 'merci', 'bien', 'biens',
  'dossier', 'dossiers', 'kit', 'kits', 'export', 'exports', 'mise', 'jour', 'format', 'pdf', 'zip', 'fichier', 'fichiers',
  'tout', 'tous', 'toute', 'toutes', 'maintenant', 'complete', 'pret', 'prete', 'emploi',
]);

const mots = (s: string): string[] => plain(s).split(/[^a-z0-9]+/).filter(Boolean);

/** Mots distinctifs de chaque export, tirés des libellés du CATALOGUE des exports (aucune liste locale de types). */
const MOTS_PAR_EXPORT: ReadonlyArray<{ code: ExportCode; mots: ReadonlySet<string> }> = [
  { code: EXPORT_BRUT_CODE, sources: [EXPORT_BRUT_LABEL, EXPORT_BRUT_CODE] },
  ...DOSSIER_CODES.map((code) => ({ code, sources: [DOSSIER_LABELS[code], DOSSIER_SHORT_LABELS[code], code] })),
].map(({ code, sources }) => ({
  code: code as ExportCode,
  mots: new Set(sources.flatMap((s) => mots(s.replace(/_/g, ' '))).filter((m) => !GENERIQUES.has(m) && (m.length >= 4 || m === 'cil'))),
}));

/** Deux mots se valent s'ils sont égaux ou si l'un prolonge l'autre (« brut » / « brutes », « complet » / « complète »). */
const memeMot = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

/**
 * « Exporte les données brutes de la Clio », « Génère le dossier complet de la maison », « Prépare le kit de mise
 * en vente de la Clio en ZIP », « Peux-tu télécharger le dossier de location de l'appartement » (pure, testée).
 * `null` : la phrase n'est pas une demande d'export — question, phrase sans verbe d'action en tête, ou sans export nommé.
 */
export function parseExportRequest(message: string): ExportDraft | null {
  const entier = plain(message).trim();
  // Demande polie (« peux-tu … ») : le verbe d'action vient après.
  const debut = debutUtile(entier);
  const m = entier.slice(debut).replace(/\s+/g, ' ').trim();
  const poli = debut > 0;
  // Une question n'est jamais une demande d'export (« Exporter le dossier complet, c'est possible ? »).
  if (/\?\s*$/.test(m) && !poli) return null;
  const verbe = m.match(VERBE);
  if (!verbe) return null;
  const reste = m.slice(verbe[0].length).replace(/[.!?]+\s*$/, '').trim();
  if (!reste) return null;

  const tous = mots(reste);
  // Score de chaque export : nombre de ses mots distinctifs présents dans la phrase.
  const scores = MOTS_PAR_EXPORT.map((e) => ({ code: e.code, n: [...e.mots].filter((x) => tous.some((t) => memeMot(t, x))).length }));
  const max = Math.max(0, ...scores.map((s) => s.n));
  const codes = max > 0 ? scores.filter((s) => s.n === max).map((s) => s.code) : [];
  // Sans export reconnu : seulement « exporte … » ou un nom d'export explicite (« prépare un dossier pour la Clio »).
  if (codes.length === 0 && !VERBE_EXPORT.test(m) && !NOM_EXPORT.test(reste)) return null;

  const assetFromContext = /\b(?:ce|cet|cette)\s+[a-z]/.test(reste);
  const motsExports = new Set(MOTS_PAR_EXPORT.flatMap((e) => [...e.mots]));
  const sansContexte = reste.replace(/\b(?:ce|cet|cette)\s+[a-z0-9'-]+/g, ' ');
  const assetWords = assetFromContext ? [] : mots(sansContexte)
    .filter((w) => w.length >= 3 && !GENERIQUES.has(w) && !/^\d+$/.test(w) && ![...motsExports].some((x) => memeMot(w, x)))
    .slice(0, 4);
  const content = contenuDemande(reste);
  // Les mots du contenu (« photos », « équipements ») ne désignent pas le bien.
  const retenus = Object.keys(content).length
    ? assetWords.filter((w) => !/^(?:photos?|equipements?|sans|avec|hors|inclus|incluant)$/.test(w))
    : assetWords;
  return { codes, zip: /\b(?:zip|fichiers?)\b/.test(reste), assetWords: retenus, assetFromContext, content };
}

// ── Exécution ───────────────────────────────────────────────────────────────

/** Bien du compte, tel que la demande le désigne. */
type BienExport = { id: number; name: string; category: string };

/** Issue de la façade d'export, réduite à ce que l'Assistant en dit (voir `export-request.facade`). */
export type ExportIssue =
  | { kind: 'invalid_type' }
  | { kind: 'raw_ready'; downloadHref: string | null }
  | { kind: 'raw_failed'; message: string }
  /**
   * Passage 114AA (#753) : `generationId` identifie la génération mise en file — la carte « En préparation » le
   * porte, pour que l'état soit RELU quand l'utilisateur revient dans la conversation ou envoie un message
   * (`core/export-card-state.ts`). Sans lui, la carte resterait « En préparation » pour toujours.
   */
  | { kind: 'queued'; reused: boolean; warnings: string[]; generationId: number }
  | { kind: 'refused'; status: number; message: string };

/** Accès de la commande : compte, biens, façade d'export. Injectable pour les tests ; `sqlExportDeps` en production. */
export interface ExportDeps {
  /** Biens du compte désignés par des mots (jamais un autre compte). */
  findAssets(accountId: number, words: string[]): Promise<Array<{ id: number; name: string; city?: string | null }>>;
  /** Bien du compte, par identifiant (bien de la page ou de la conversation). */
  getAsset(accountId: number, id: number): Promise<{ id: number; name: string } | null>;
  /** Famille du bien (éligibilité des dossiers). */
  getAssetCategory(accountId: number, id: number): Promise<string | null>;
  /** Limitation de débit des demandes d'export : `null` si la demande peut partir, sinon le message du service. */
  rateLimited(userId: number): string | null;
  /**
   * Lance la demande par la façade métier partagée avec la route. `null` : bien inaccessible.
   * Passage 114AB : `content` — ce que la phrase dit du contenu ; vide, les présélections du service.
   */
  request(p: {
    accountId: number; userId: number; assetId: number; code: ExportCode; zip: boolean;
    content: { photos?: boolean; equipments?: boolean };
  }): Promise<ExportIssue | null>;
  /** Durée de conservation d'un export généré, en jours. */
  retentionDays: number;
  /** Message du service quand le bien n'est pas accessible. */
  assetNotFoundMessage: string;
}

/** Réponse de l'Assistant à une demande d'export. */
export interface ExportAnswer {
  /** `done` : demande lancée ; `need_info` : précision demandée, rien n'est lancé ; `refused` : refus du service d'export. */
  kind: 'done' | 'need_info' | 'refused';
  message: string;
  /** Carte affichée sous la réponse (téléchargement, ou suivi dans les exports du bien). */
  resultGroups?: ResultGroup[];
  /** Bien dont l'espace d'export est proposé en bouton (refus à corriger dans la préparation du dossier). */
  exportAreaAssetId?: number | null;
  /** Export demandé (trace). */
  code?: ExportCode;
}

/** Libellé d'un export, celui du catalogue. */
export const exportLabel = (code: ExportCode): string => (code === EXPORT_BRUT_CODE ? EXPORT_BRUT_LABEL : DOSSIER_LABELS[code]);

const nomBien = (a: { name: string; city?: string | null }) => (a.city ? `${a.name} (${a.city})` : a.name);

/** Refus que l'utilisateur peut lever depuis la préparation du dossier (seuils, sélection, blocs à compléter). */
const REFUS_A_PREPARER = new Set([409, 422]);

/**
 * Passage 114AB (W28) : ce que la réponse dit du contenu retenu — seulement ce que la phrase a demandé
 * (textes à valider par le PO). Contenu non précisé : rien n'est ajouté à la réponse.
 */
function phraseContenu(content: ExportDraft['content']): string {
  const dites = [
    ...(content.photos === false ? ['Les photos ne sont pas incluses.'] : []),
    ...(content.photos === true ? ['Les photos sont incluses.'] : []),
    ...(content.equipments === false ? ['Les équipements ne sont pas inclus.'] : []),
    ...(content.equipments === true ? ['Les équipements sont inclus.'] : []),
  ];
  return dites.length ? ` ${dites.join(' ')}` : '';
}

/**
 * Traite une demande d'export : `null` si le message n'en est pas une. Aucune confirmation : la génération est
 * lancée dès que l'export et le bien sont établis ; sinon UNE question, et rien n'est lancé.
 */
export async function answerExportRequest(input: AssistantRequestInput, deps: ExportDeps): Promise<ExportAnswer | null> {
  const draft = parseExportRequest(input.message);
  if (!draft) return null;
  const acc = input.accountId;

  // ── Bien : désigné par des mots, sinon celui de la conversation ou de la page ; jamais choisi au hasard.
  let bien: { id: number; name: string; city?: string | null } | null = null;
  if (draft.assetWords.length) {
    const found = await deps.findAssets(acc, draft.assetWords);
    if (found.length === 0) return { kind: 'need_info', message: 'Je n’ai pas trouvé ce bien dans votre compte. Pour quel bien voulez-vous cet export ?' };
    if (found.length > 1) {
      return { kind: 'need_info', message: `Plusieurs biens correspondent : ${found.slice(0, 5).map(nomBien).join(', ')}. Précisez lequel dans votre demande.` };
    }
    bien = found[0];
  } else {
    const id = input.reference?.type === 'asset' ? input.reference.id : Number(input.pageContext?.assetId) || null;
    bien = id ? await deps.getAsset(acc, id) : null;
    if (!bien) return { kind: 'need_info', message: 'Pour quel bien voulez-vous cet export ?' };
  }
  const category = await deps.getAssetCategory(acc, bien.id);
  if (category == null) return { kind: 'refused', message: deps.assetNotFoundMessage };
  const cible: BienExport = { id: bien.id, name: bien.name, category };

  // ── Export : celui que la phrase nomme ; plusieurs possibles ou aucun → question, avec les exports de CE bien.
  if (draft.codes.length !== 1) {
    const possibles: ExportCode[] = draft.codes.length > 1
      ? draft.codes
      : [EXPORT_BRUT_CODE, ...DOSSIER_CODES.filter((c) => isDossierEligibleForFamily(c, cible.category))];
    return {
      kind: 'need_info',
      message: `Quel export voulez-vous pour ${cible.name} ? ${possibles.map((c) => `« ${exportLabel(c)} »`).join(', ')}.`,
    };
  }
  const code = draft.codes[0];
  const label = exportLabel(code);

  // Passage 114AB (W28) : une consigne de contenu que le dossier ne sait pas honorer est DITE, et rien n'est
  // lancé — jamais un export silencieusement différent de ce qui a été demandé.
  if (code !== EXPORT_BRUT_CODE && draft.content.equipments !== undefined) {
    return {
      kind: 'need_info', code,
      message: `Pour choisir les équipements d’un dossier prêt à l’emploi, passez par l’onglet « Exports » de ${cible.name}. Rien n’a été lancé.`,
      exportAreaAssetId: cible.id,
    };
  }

  const limite = deps.rateLimited(input.userId);
  if (limite) return { kind: 'refused', message: limite, code };

  const issue = await deps.request({ accountId: acc, userId: input.userId, assetId: cible.id, code, zip: draft.zip, content: draft.content });
  if (!issue) return { kind: 'refused', message: deps.assetNotFoundMessage, code };

  switch (issue.kind) {
    case 'invalid_type':
      return { kind: 'refused', message: `L’export « ${label} » n’est pas disponible.`, code };
    case 'raw_failed':
      return { kind: 'refused', message: issue.message, code };
    case 'refused':
      return {
        kind: 'refused', code,
        message: `« ${label} » pour ${cible.name} n’a pas été lancé. ${issue.message}`,
        exportAreaAssetId: REFUS_A_PREPARER.has(issue.status) ? cible.id : null,
      };
    case 'raw_ready':
      return {
        kind: 'done', code,
        message: `L’export « ${label} » de ${cible.name} est prêt. Il reste disponible ${deps.retentionDays} jours dans les exports de ce bien.${phraseContenu(draft.content)}`,
        resultGroups: [exportResultGroup({
          id: `asset_${cible.id}`, title: label, subtitle: cible.name, status: CARTE_EXPORT_PRET,
          // Carte identifiée par le BIEN : s'il est supprimé, la relecture de l'historique retire le lien (§19.10).
          // Lien de la route de téléchargement existante (droits revérifiés à chaque clic) ; à défaut, les exports du bien.
          href: issue.downloadHref ?? hrefBien(cible.id, 'exports'),
        })],
      };
    case 'queued': {
      const debut = issue.reused
        ? `Le dossier « ${label} » de ${cible.name} est déjà en cours de préparation.`
        : `Le dossier « ${label} » de ${cible.name} est en cours de préparation.`;
      return {
        kind: 'done', code,
        message: [`${debut} Vous le retrouverez, dès qu’il sera prêt, dans les exports de ce bien.${phraseContenu(draft.content)}`, ...issue.warnings].join(' '),
        resultGroups: [exportResultGroup({
          // Passage 114AA : carte identifiée par la GÉNÉRATION — son état est relu au retour dans la
          // conversation (« En préparation » → « Prêt », avec son lien) sans aucune tâche de fond.
          id: `export_${issue.generationId}`, title: label, subtitle: cible.name,
          status: CARTE_EXPORT_EN_PREPARATION, href: hrefBien(cible.id, 'exports'),
        })],
      };
    }
  }
}

// ── Accès de production ─────────────────────────────────────────────────────

/** Lien de téléchargement admis dans une carte : uniquement la route de téléchargement des exports. */
export function safeExportDownloadHref(href: unknown): string | null {
  return typeof href === 'string' && /^\/api\/export-generations\/[A-Za-z0-9_-]{1,80}\/download\?file=(?:zip|pdf)$/.test(href) ? href : null;
}

/** Accès réels : biens du compte (mêmes lectures que les commandes), façade d'export partagée avec la route. */
export async function sqlExportDeps(): Promise<ExportDeps> {
  const [{ sqlLookup }, facade, access, limit, errors, storage, { pgClient }] = await Promise.all([
    import('./plan.service'),
    import('@/services/exports/export-request.facade'),
    import('@/services/exports/export-access'),
    import('@/services/exports/v12/generation/rate-limit'),
    import('@/services/exports/export-errors'),
    import('@/services/exports/v12/storage'),
    import('@/db'),
  ]);
  return {
    findAssets: (accountId, words) => sqlLookup.findAssets(accountId, words),
    getAsset: (accountId, id) => sqlLookup.getAsset(accountId, id),
    async getAssetCategory(accountId, id) {
      const rows = (await pgClient.unsafe(
        `SELECT category FROM assets WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [id, accountId] as never[],
      )) as unknown as Array<{ category: string | null }>;
      return rows[0]?.category ?? null;
    },
    rateLimited(userId) {
      return limit.exportRateLimitState(userId).allowed ? null : limit.EXPORT_RATE_LIMITED_MESSAGE;
    },
    async request({ accountId, userId, assetId, code, zip, content }) {
      // Même contrôle d'accès que la route : bien du compte courant, non supprimé.
      const asset = await access.findAccessibleAssetForExport({ userId, currentAccountId: accountId }, assetId);
      if (!asset) return null;
      // Passage 114AB (W28) : le contenu demandé est transmis dans `options`, le champ du tiroir historique —
      // le service en fait la sélection (`choicesFromLegacyOptions`). Rien n'est posé qui n'ait été dit : sans
      // consigne, `options` n'est pas envoyé et les présélections du service s'appliquent, comme avant.
      const options: Record<string, boolean> = {
        ...(content.photos !== undefined ? { includePhotos: content.photos } : {}),
        ...(content.equipments !== undefined ? { includeEquipments: content.equipments } : {}),
      };
      const issue = await facade.requestExportForAsset({
        asset, userId,
        body: {
          exportType: code, requestedOutputs: [zip ? 'ZIP' : 'PDF'],
          ...(Object.keys(options).length ? { options } : {}),
        },
      });
      switch (issue.kind) {
        case 'invalid_type': return { kind: 'invalid_type' };
        case 'raw_ready': return { kind: 'raw_ready', downloadHref: safeExportDownloadHref(issue.dto.downloadZipUrl) };
        case 'raw_failed': return { kind: 'raw_failed', message: errors.EXPORT_ERROR_MESSAGES.GENERATION_FAILED };
        case 'queued': return { kind: 'queued', reused: issue.reused, warnings: issue.warnings.map((w) => w.message), generationId: issue.dto.id };
        case 'refused': return { kind: 'refused', status: issue.status, message: issue.message };
      }
    },
    retentionDays: storage.EXPORT_RETENTION_DAYS,
    assetNotFoundMessage: errors.EXPORT_ERROR_MESSAGES.ASSET_NOT_FOUND,
  };
}
