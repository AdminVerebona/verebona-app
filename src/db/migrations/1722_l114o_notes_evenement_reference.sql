-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 1722 : NOTES / DESCRIPTION d'un événement de référence (lot 114O,
-- carte Trello #744, CDC « Opérations / Agenda V2.0 » §5, §14 ; AC42).
--
-- « Notes/Description éditables et non écrasées » (§14) et « les notes
-- utilisateur sont indépendantes de la synthèse factuelle IA » (§5). Le texte
-- est la PAROLE de l'utilisateur : rien ne l'écrit sinon son geste sur la page
-- (commande `setOperationNotes` de la façade métier). Aucun traitement
-- automatique (T1, T3, T4, reconstruction) ne le lit ni ne le remplace.
--
-- Trois colonnes sur la table EXISTANTE `business_operations` — aucune table
-- nouvelle (donc rien à déclarer dans le diagnostic, l'export de recette, le
-- transfert de bien ni le périmètre de reconstruction : la table y est déjà) :
--   · `user_notes`                le texte, borné comme celui d'un document
--                                 (`NOTES_MAX_LENGTH` = 5000, lot 113Z) ;
--   · `user_notes_updated_at`     quand il a été enregistré pour la dernière
--                                 fois (affiché sous le texte) ;
--   · `user_notes_author_user_id` qui l'a enregistré (journal, Duo).
--
-- AUCUNE donnée n'est écrite : aucun texte existant n'est recopié ici, aucune
-- provenance n'est supposée. Un événement de référence sans note garde
-- `NULL` — qui veut dire « aucune note », jamais « note effacée ».
-- Additive, idempotente, rejouable (IF NOT EXISTS partout ; contrainte reposée
-- seulement si elle manque).
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE business_operations ADD COLUMN IF NOT EXISTS user_notes TEXT;
ALTER TABLE business_operations ADD COLUMN IF NOT EXISTS user_notes_updated_at TIMESTAMPTZ;
ALTER TABLE business_operations ADD COLUMN IF NOT EXISTS user_notes_author_user_id INTEGER;

-- Contraintes : posées SEULEMENT si la table n'en porte pas déjà une du même nom. La recherche est bornée à
-- CETTE table (`conrelid`), et non au nom seul : le schéma déclaré (Drizzle) et la migration restent alignés,
-- et la migration rejouée sur un schéma neuf repose bien ce qui lui manque. Les noms sont ceux que produit la
-- déclaration Drizzle (contrôle `l39-o1-socle-operations`).
DO $$
BEGIN
  -- Texte utile seulement : jamais une chaîne vide (« aucune note » s'écrit NULL),
  -- jamais au-delà de la borne du champ « Notes / Description » existant.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'business_operations'::regclass AND conname = 'business_operations_user_notes_chk') THEN
    ALTER TABLE business_operations ADD CONSTRAINT business_operations_user_notes_chk
      CHECK (user_notes IS NULL OR char_length(btrim(user_notes)) BETWEEN 1 AND 5000);
  END IF;
  -- L'auteur suit son compte : utilisateur supprimé → la note reste, sans auteur.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'business_operations'::regclass AND conname = 'business_operations_user_notes_author_user_id_users_id_fk') THEN
    ALTER TABLE business_operations ADD CONSTRAINT business_operations_user_notes_author_user_id_users_id_fk
      FOREIGN KEY (user_notes_author_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
