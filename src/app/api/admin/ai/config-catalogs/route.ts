/**
 * GET /api/admin/ai/config-catalogs — CDC BO IA §2.1, §15.1, SCR-02 à SCR-06.
 *
 * Tout ce dans quoi l'administrateur choisit : modèles, niveaux de raisonnement,
 * garde-fous, déclencheurs, et la liste des traitements avec leur nature.
 *
 * ── POURQUOI UNE SEULE ROUTE ───────────────────────────────────────────────
 * Ces listes viennent du code et ne changent qu'à une mise en production. Les
 * dupliquer côté client les ferait diverger du référentiel au premier ajout
 * d'opération ; les servir en cinq routes ferait cinq allers-retours pour
 * afficher un onglet.
 *
 * Les modèles portent leur disponibilité ET leur tarif séparément : ce sont
 * deux causes de refus distinctes, qui appellent deux gestes différents —
 * changer de modèle, ou rafraîchir la grille tarifaire.
 *
 * ── LOT 32B : UNE LISTE PAR TRAITEMENT ──────────────────────────────────────
 * `modelsByTreatment[Tx]` = `usableModelsForTreatment(Tx)` : SEULE liste des
 * sélecteurs principal / repli 1 / repli 2 du BO. `excludedByTreatment` ne
 * sert qu'à nommer une valeur ENREGISTRÉE qui n'est plus utilisable
 * (« gemini-X — indisponible (déprécié) ») ; ce n'est jamais un choix. La
 * liste globale `models` est conservée pour les écrans qui la lisent.
 * Aucun appel fournisseur : catalogue, tarifs et état opérationnel sont lus.
 *
 * ── LOT 35B : CATALOGUE DYNAMIQUE ───────────────────────────────────────────
 * Les modèles découverts chez Google et qualifiés automatiquement y figurent
 * sans modification du code ; chaque entrée porte son statut (Preview
 * visible) et `priced` (tarif inconnu : proposé quand même).
 */
import { NextRequest, NextResponse } from 'next/server';
import { GEMINI_PUBLIC_CATALOG } from '@/services/ai/gateway/pricing/gemini-public-catalog';
import { getCachedPrice } from '@/services/ai/gateway/pricing/pricing.repository';
import { listGuardrails, listTriggers, TRIGGER_CATALOG } from '@/services/ai/config/catalogs';
import { DEFAULT_TRIGGERS } from '@/services/ai/queue/triggers';
import { TREATMENTS, TREATMENT_DEFINITIONS } from '@/services/ai/config/treatments';
import { REASONING_LEVELS, GUARDRAIL_REACTIONS } from '@/services/ai/config/config-types';
import { masterPromptForTreatment } from '@/services/ai/config/prompt-architecture';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';
import { selectableModels } from '@/services/ai/provider/model-catalog.service';
import {
  loadUsableModelsContext, usableModelsByTreatment, excludedModelsByTreatment,
} from '@/services/ai/registry/usable-models';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  try {
    // E-04, PROV-UI-06 : disponibilité lue dans le catalogue du fournisseur
    // (dernier rafraîchissement) ; un modèle indisponible n'est plus
    // sélectionnable. Jamais rafraîchi : catalogue du code, comme avant.
    const ctx = await loadUsableModelsContext();
    const state = ctx.catalog;
    const selectable = selectableModels(GEMINI_PUBLIC_CATALOG.map((e) => e.model), state as never);
    const names = [...new Set([...GEMINI_PUBLIC_CATALOG.map((e) => e.model), ...state.models.map((m: { model: string }) => m.model)])];
    const models = names.map((model) => {
      const price = getCachedPrice('gemini', model);
      return {
        model,
        available: selectable.has(model),
        priced: price !== null,
        // `verified` distingue la grille du compte, opposable à la facture, du
        // tarif public — juste, mais sans les remises éventuelles.
        verified: price?.verified ?? false,
      };
    });

    return NextResponse.json({
      models,
      // Lot 32B : listes des sélecteurs, par traitement (source unique).
      modelsByTreatment: usableModelsByTreatment(ctx),
      excludedByTreatment: excludedModelsByTreatment(ctx),
      catalogRefreshedAt: state.refreshedAt,
      reasoningLevels: REASONING_LEVELS,
      guardrailReactions: GUARDRAIL_REACTIONS,
      // Lot 16b : `master` seule architecture (`steps` retiré).
      promptArchitectures: ['master'],
      // Catalogue COMPLET (libellés, applicabilité, retraits) : le BO affiche
      // les déclencheurs enregistrés qui ne s'appliquent plus au traitement,
      // pour qu'ils restent visibles et supprimables (ticket BO IA / T4).
      triggerCatalog: TRIGGER_CATALOG.map((d) => ({
        code: d.code, label: d.label, kind: d.kind, treatments: d.treatments ?? null, retired: d.retired ?? false,
      })),
      treatments: TREATMENTS.map((t) => ({
        ...TREATMENT_DEFINITIONS[t],
        guardrails: listGuardrails(t),
        // Vide pour T2 et T5 : synchrones, hors file globale (GEN-004).
        // Texte d'aide propre au traitement (`help`), sans exposer la table entière.
        triggers: TREATMENT_DEFINITIONS[t].batch
          ? listTriggers(t).map(({ code, label, kind, help }) => ({ code, label, kind, help: help?.[t] ?? null }))
          : [],
        // Déclencheurs appliqués quand la liste est VIDE (queue/triggers.ts) :
        // le BO l'explique — une liste vide ne coupe pas les exécutions.
        defaultTriggers: (DEFAULT_TRIGGERS as Record<string, readonly string[]>)[t] ?? [],
        // CDC 15 D-04 : master déclaré au registre. Lot 16b : tous les
        // traitements en master seul, sans choix d'architecture ni commutateur.
        master: masterPromptForTreatment(t),
      })),
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/config-catalogs');
  }
}
