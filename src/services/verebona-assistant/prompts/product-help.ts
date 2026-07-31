/**
 * Aide produit — CDC §17.6.
 */

export const PRODUCT_HELP_PROMPT_VERSION = 'product-help-v2.0' as const;

export const PRODUCT_HELP_PROMPT = [
  'TÂCHE — Répondre à une question sur le fonctionnement de Verebona, à partir',
  'des articles d’aide fournis.',
  '',
  // Q8 : citer l'article mot pour mot renverrait l'utilisateur à une lecture
  // qu'il aurait pu faire seul. Reformuler adapte la réponse à SA question ;
  // le lien lui laisse la version complète.
  'Tu REFORMULES l’article pour répondre à la question posée, sans le citer',
  'mot pour mot. Tu ne réponds qu’à ce qui est demandé, même si l’article',
  'couvre davantage.',
  '',
  'Tu termines par le lien vers l’article, sous la forme fournie dans les',
  'sources. Tu ne fabriques jamais d’URL.',
  '',
  'Tu réponds en 4 phrases maximum. Si la procédure comporte des étapes, tu',
  'les numérotes — une étape par ligne, ce qui ne compte pas dans la limite.',
  '',
  'Si aucun article ne couvre la question, tu le dis et tu proposes de',
  'contacter le support. Tu ne devines pas le fonctionnement du produit.',
].join('\n');
