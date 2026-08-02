/**
 * Adaptateur de corpus — sert les fixtures au pipeline complet.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI IL FALLAIT EN PASSER PAR LÀ
 *
 * Le harnais précédent appelait `AiGateway.execute` directement. Il ne
 * traversait donc jamais `entrypoint.ts`, seul endroit où
 * `AI_UNIFIED_SOURCE_ANALYSIS` aiguille.
 *
 * Conséquence observée : les deux campagnes ont rendu des résultats
 * identiques à un champ près — 4 conformes, 15 erreurs de type des deux
 * côtés. Elles exécutaient le même code, et seul le libellé changeait.
 *
 * Ce que ce harnais mesurait — prompts et passerelle — reste utile : c'est
 * lui qui a validé le vocabulaire des champs, 6 champs corrects sur 83
 * devenus 61. Mais il ne peut pas arbitrer une bascule de moteur.
 *
 * ── CE QUE CET ADAPTATEUR CHANGE ──────────────────────────────────────────
 *
 * Il sert le contenu d'une fixture là où l'adaptateur de fichier irait
 * chercher un objet dans le stockage. Tout le reste du pipeline s'exécute :
 * regroupement, extraction, classification, entités, catégorie, persistance,
 * événements aval.
 *
 * Le drapeau est donc réellement traversé, et les deux moteurs peuvent enfin
 * être comparés.
 *
 * ── PAS DE STOCKAGE, ET C'EST VOULU ───────────────────────────────────────
 *
 * Téléverser 28 fixtures pour chaque campagne coûterait du temps, laisserait
 * des objets à purger, et ferait dépendre la mesure d'un service tiers. Le
 * contenu des fixtures est déjà en mémoire : le servir directement mesure la
 * même chose, sans ces aléas.
 *
 * Ce qui n'est PAS mesuré en contrepartie : la lecture du stockage,
 * l'extraction bureautique et le rendu PDF. Ces étapes précèdent le point de
 * bascule et sont communes aux deux moteurs — les écarter ne fausse pas la
 * comparaison.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { SourceAdapter, AdapterPrepareInput } from './source-adapter.port';
import type { SourceInput } from '../types';

/** Contenu servi pour un identifiant de source donné, le temps d'une campagne. */
const fixtures = new Map<number, { contenu: string; nomFichier: string }>();

/**
 * Déclare le contenu d'une source de corpus.
 *
 * Appelé juste avant l'analyse. La table est vidée entre deux campagnes :
 * un reliquat ferait analyser le document d'un cas précédent sous
 * l'identifiant d'un autre — et l'écart passerait pour une régression du
 * moteur.
 */
export function declarerFixture(sourceId: number, contenu: string, nomFichier: string): void {
  fixtures.set(sourceId, { contenu, nomFichier });
}

export function viderFixtures(): void {
  fixtures.clear();
}

export class CorpusSourceAdapter implements SourceAdapter {
  // `future_source` figure déjà au contrat : l'employer évite d'élargir
  // `SourceType` pour un usage de recette, ce qui obligerait chaque
  // exhaustivité de `switch` à traiter un cas qui n'existe pas en production.
  readonly sourceType = 'future_source' as const;

  async prepare(input: AdapterPrepareInput): Promise<SourceInput> {
    const manquants = input.sourceIds.filter((id) => !fixtures.has(id));
    if (manquants.length > 0) {
      // Échouer franchement : servir un contenu vide ferait passer le défaut
      // pour une incapacité du moteur à extraire.
      throw new Error(
        `[corpus-adapter] Aucune fixture déclarée pour ${manquants.join(', ')}. ` +
        'Appeler `declarerFixture` avant l\'analyse.',
      );
    }

    const contenus = input.sourceIds.map((id) => fixtures.get(id)!);

    return {
      sourceType: 'future_source',
      sourceIds: input.sourceIds,
      accountId: input.accountId,
      userId: input.userId,
      mimeTypes: contenus.map(() => 'text/plain'),
      displayNames: contenus.map((c) => c.nomFichier),
      // Le contenu est déjà textuel : ni extraction bureautique ni rendu PDF,
      // comme pour un lien web.
      extractedContent: contenus.map((c) => c.contenu).join('\n\n---\n\n'),
      linkedAssetId: input.linkedAssetId ?? null,
      // Une campagne ne rejoue pas une analyse antérieure : une version neuve
      // force un traitement complet plutôt qu'une reprise de propositions
      // existantes (§6.3).
      sourceVersion: Date.now(),
    };
  }

  // Rien à libérer : aucune ressource temporaire n'a été créée.
}
