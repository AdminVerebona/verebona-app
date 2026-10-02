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
 */
import { NextRequest, NextResponse } from 'next/server';
import { GEMINI_PUBLIC_CATALOG } from '@/services/ai/gateway/pricing/gemini-public-catalog';
import { getCachedPrice, getCacheState, loadPricingCache } from '@/services/ai/gateway/pricing/pricing.repository';
import { listGuardrails, listTriggers } from '@/services/ai/config/catalogs';
import { TREATMENTS, TREATMENT_DEFINITIONS, isMasterOnlyTreatment } from '@/services/ai/config/treatments';
import { REASONING_LEVELS, GUARDRAIL_REACTIONS, PROMPT_ARCHITECTURES } from '@/services/ai/config/config-types';
import { masterPromptForTreatment, MASTER_ROLLOUT_SWITCH } from '@/services/ai/config/prompt-architecture';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';
import { getCatalogState, selectableModels } from '@/services/ai/provider/model-catalog.service';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  try {
    if (getCacheState().loadedAt === null) await loadPricingCache();

    // E-04, PROV-UI-06 : disponibilité lue dans le catalogue du fournisseur
    // (dernier rafraîchissement) ; un modèle indisponible n'est plus
    // sélectionnable. Jamais rafraîchi : catalogue du code, comme avant.
    const state = await getCatalogState().catch(() => ({ refreshedAt: null, models: [] as never[] }));
    const selectable = selectableModels(GEMINI_PUBLIC_CATALOG.map((e) => e.model), state);
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
      catalogRefreshedAt: state.refreshedAt,
      reasoningLevels: REASONING_LEVELS,
      guardrailReactions: GUARDRAIL_REACTIONS,
      promptArchitectures: PROMPT_ARCHITECTURES,
      treatments: TREATMENTS.map((t) => ({
        ...TREATMENT_DEFINITIONS[t],
        guardrails: listGuardrails(t),
        // Vide pour T2 et T5 : synchrones, hors file globale (GEN-004).
        triggers: TREATMENT_DEFINITIONS[t].batch ? listTriggers(t) : [],
        // CDC 15 D-04 : master déclaré au registre, sinon `null` (architecture
        // « master » non proposée pour ce traitement).
        // Commutateur d'environnement qui conditionne en plus le master
        // (T1 : AI_T1_ANALYSIS_MODE) ; `null` : la version suffit (T3, D-04).
        master: masterPromptForTreatment(t)
          ? {
            ...masterPromptForTreatment(t)!, rolloutSwitch: MASTER_ROLLOUT_SWITCH[t] ?? null,
            // Lot 16b : T2, T4, T5 et T6 sans architecture `steps` (choix non proposé).
            masterOnly: isMasterOnlyTreatment(t),
          }
          : null,
      })),
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/config-catalogs');
  }
}
