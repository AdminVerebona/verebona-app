-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0123 — Gabarits de fin d'analyse de lot
--
-- ── UN LOT RÉUSSI ÉTAIT MUET ──────────────────────────────────────────────
--
-- La migration 0077 a posé `notif_document_batch_failed`, mais aucun gabarit
-- pour les deux autres issues que `lot-notification.ts` sait produire :
--
--   DOCUMENT_BATCH_COMPLETED          tout s'est bien passé
--   DOCUMENT_BATCH_PARTIALLY_FAILED   une partie du lot a échoué
--   DOCUMENT_BATCH_FAILED             ✅ posé par 0077
--
-- Conséquence : l'utilisateur dépose dix documents, l'analyse aboutit, et il
-- n'en sait rien. Seul l'échec lui parvenait — l'application ne parlait que
-- pour annoncer une mauvaise nouvelle.
--
-- ── POURQUOI TROIS MESSAGES ET NON UN ─────────────────────────────────────
--
-- « Vos documents ont été analysés » et « certains n'ont pas pu l'être »
-- appellent des suites différentes : consulter, ou reprendre. Les confondre
-- obligerait l'utilisateur à ouvrir l'application pour savoir laquelle
-- s'applique.
--
-- Les corps restent volontairement génériques — `{{body}}` — car le texte
-- réel est composé par `lot-notification.ts`, qui connaît le décompte.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO email_templates (type, subject, body, placeholders, updated_at) VALUES
  ('DOCUMENT_BATCH_COMPLETED',
   'Vos documents ont été analysés',
   E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}',
   '["title","body","actionUrl"]', NOW()),

  ('DOCUMENT_BATCH_PARTIALLY_FAILED',
   'Analyse de vos documents : certains n''ont pas abouti',
   E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}',
   '["title","body","actionUrl"]', NOW()),

  ('DOCUMENT_BATCH_FAILED',
   'Analyse de vos documents',
   E'{{body}}\n\nAccéder à Verebona : {{actionUrl}}',
   '["title","body","actionUrl"]', NOW())

-- Rejouable : `type` porte un index unique. `DO UPDATE` et non `DO NOTHING`,
-- pour qu'une correction de libellé se propage.
ON CONFLICT (type) DO UPDATE
  SET subject = EXCLUDED.subject,
      body = EXCLUDED.body,
      placeholders = EXCLUDED.placeholders,
      updated_at = NOW();
