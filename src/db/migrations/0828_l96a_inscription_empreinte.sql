-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 0828 : empreinte d'INSCRIPTION (lot 96A, CDC 18 Q9 / P1).
--
-- `users.signup_nonce` : valeur aléatoire posée à la création d'une
-- inscription e-mail + mot de passe NON VÉRIFIÉE. Elle entre dans la
-- signature du lien d'activation : un lien est attaché à UNE inscription
-- précise, jamais à la seule adresse. Une inscription remplacée (nouvelle
-- ligne, ou même ligne réinscrite avec un autre mot de passe) a une autre
-- empreinte : ses anciens liens ne l'activent pas.
--
-- NULL pour toutes les lignes existantes (comptes actifs, inscriptions en
-- attente émises avant ce lot) : leurs liens restent signés comme avant —
-- et l'activation exige désormais, dans tous les cas, le mot de passe choisi
-- à l'inscription. Comptes Google / Apple : jamais concernés (créés actifs).
-- Secret de parcours : jamais exporté (diagnostic, RGPD).
--
-- Additive et idempotente ; métadonnée seulement (aucune ligne réécrite).
-- Retour arrière : ALTER TABLE users DROP COLUMN IF EXISTS signup_nonce.
-- ──────────────────────────────────────────────────────────────────────────────
SET LOCAL lock_timeout = '5s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_nonce TEXT;
