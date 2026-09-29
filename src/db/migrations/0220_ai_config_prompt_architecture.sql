-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0220 : architecture des prompts et texte master par traitement dans
-- la version de configuration IA (CDC 15 §29 étape 14, §29.1 ; décisions D-03, D-04).
--
--   · steps  (défaut) : étapes historiques, un prompt technique par opération,
--                       précédé du préambule administrable (`prompt`) ;
--   · master          : prompt maître unique du traitement, texte dans
--                       `master_prompt` (vide : fichier du dépôt).
--
-- master_prompt (NULL) : texte COMPLET du prompt maître du traitement (D-03),
-- DISTINCT du préambule `prompt`, qui continue de servir aux étapes quelle que
-- soit l'architecture. NULL/vide : fichier `tN_master_vK.txt` du dépôt.
--
-- La bascule se fait par version (Brouillon → À tester → Validée/Active),
-- jamais en éditant une Active : contrôle applicatif
-- (`config/prompt-architecture#checkPromptArchitectureChange`).
--
-- NOT NULL DEFAULT 'steps' : toutes les lignes existantes gardent exactement
-- leur comportement. Défaut constant ⇒ PostgreSQL ≥ 11 n'écrit pas la table
-- (modification de catalogue seule).
--
-- VERROUS (appliquée au démarrage) : verrou ACCESS EXCLUSIVE borné à 5 s par
-- `lock_timeout`. Dépassé : la migration échoue, est signalée (/api/health) et
-- retentée au prochain démarrage ; en attendant, le code lit `steps` sans
-- master et refuse d'enregistrer `master` ou un texte master (contrôle `config-version.repository`
-- #hasPromptArchitectureColumn, comme 0217). `SET LOCAL` et non `SET` : le
-- fichier est une requête multi-instructions, donc UNE transaction implicite ;
-- le réglage s'arrête avec elle et ne fuit pas sur la connexion du pool.
--
-- CONTRAINTE : instruction séparée, nommée et idempotente (bloc DO), posée
-- NOT VALID puis validée — la validation ne prend qu'un verrou SHARE UPDATE
-- EXCLUSIVE, et la table (6 lignes par version) est de toute façon petite.
--
-- Idempotente : ADD COLUMN IF NOT EXISTS, contrainte créée si absente.
-- ──────────────────────────────────────────────────────────────────────────────

SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_config_entries
  ADD COLUMN IF NOT EXISTS prompt_architecture TEXT NOT NULL DEFAULT 'steps',
  ADD COLUMN IF NOT EXISTS master_prompt       TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ai_config_entries_prompt_architecture_check'
       AND conrelid = 'ai_config_entries'::regclass
  ) THEN
    ALTER TABLE ai_config_entries
      ADD CONSTRAINT ai_config_entries_prompt_architecture_check
      CHECK (prompt_architecture IN ('steps', 'master')) NOT VALID;
  END IF;
END
$$;

ALTER TABLE ai_config_entries
  VALIDATE CONSTRAINT ai_config_entries_prompt_architecture_check;

COMMENT ON COLUMN ai_config_entries.prompt_architecture IS
  'Architecture des prompts du traitement (CDC 15 D-04) : steps (étapes historiques) | master (prompt maître unique, texte dans master_prompt, D-03).';

COMMENT ON COLUMN ai_config_entries.master_prompt IS
  'Texte complet du prompt maître du traitement (CDC 15 D-03), distinct du préambule des étapes. NULL : fichier du dépôt.';
