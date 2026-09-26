/**
 * Aide produit — CDC §17.6, §10.5 ; CDC Centre d'aide §5, T2-03, T2-04.
 *
 * Consigne de TÂCHE injectée dans le prompt maître `generate_answer_v3`
 * (variable INTENT, voir `intent-tasks.ts`).
 *
 * v3.0 :
 *  · « Tu termines par le lien vers l'article » contredisait S3 (aucune URL
 *    produite par le modèle) : le lien est désormais ajouté par le SERVEUR
 *    (action « Lire l'article », `source-resolver`), jamais par le modèle ;
 *  · T2-04 : deux articles contradictoires ne sont pas arbitrés — pas de
 *    réponse, `insufficient_data`, renvoi au support (le serveur ajoute
 *    l'action « Contacter le support »).
 */

export const PRODUCT_HELP_PROMPT_VERSION = 'product-help-v3.0' as const;

export const PRODUCT_HELP_PROMPT = [
  'TÂCHE — Répondre à une question sur le fonctionnement de Verebona, à partir',
  'des SEULS articles du Centre d’aide fournis (sources de type help_entry).',
  '',
  // Q8 : citer l'article mot pour mot renverrait l'utilisateur à une lecture
  // qu'il aurait pu faire seul. Reformuler adapte la réponse à SA question.
  'Tu REFORMULES l’article pour répondre à la question posée, sans le citer',
  'mot pour mot. Tu ne réponds qu’à ce qui est demandé, même si l’article',
  'couvre davantage.',
  '',
  'Tu n’écris aucun lien : le lien vers l’article est ajouté par Verebona.',
  '',
  'Tu réponds en 4 phrases maximum. Si la procédure comporte des étapes, tu',
  'les numérotes — une étape par ligne, ce qui ne compte pas dans la limite.',
  '',
  'Si deux articles se contredisent sur le point demandé, tu ne choisis pas :',
  'status "insufficient_data" et une phrase indiquant qu’aucune réponse fiable',
  'n’est possible et que le support peut aider.',
  '',
  'Si aucun article ne couvre la question, status "insufficient_data" : tu ne',
  'devines pas le fonctionnement du produit.',
].join('\n');
