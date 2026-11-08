-- Diagnostic : indique les migrations manquantes de ta base. Lancer : psql <base> -f db/verifier_base.sql
SET client_encoding = 'UTF8';
SELECT migration, CASE WHEN ok THEN 'ok' ELSE 'MANQUANTE -> appliquer ce fichier' END AS etat FROM (VALUES
  ('003_securite.sql', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'journal_audit')),
  ('005_moderation.sql', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'signalement' AND column_name = 'statut')),
  ('006_moderation_charge.sql', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'signalement' AND column_name = 'gravite')),
  ('007_suppression_compte.sql', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_utilisateur_statut' AND pg_get_constraintdef(oid) LIKE '%SUPPRIME%')),
  ('008_reinitialisation_mdp.sql', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'reinitialisation_mdp')),
  ('009_administrateurs.sql', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'utilisateur' AND column_name = 'mdp_provisoire')),
  ('010_notification_lien.sql', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'notification' AND column_name = 'lien')),
  ('011_push.sql', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'push_abonnement')),
  ('013_competences_catalogue.sql', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'competence' AND column_name = 'synonymes')),
  ('014_parametres.sql', EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'parametre')),
  ('015_notification_signalement.sql', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_notification_type' AND pg_get_constraintdef(oid) LIKE '%NOUVEAU_SIGNALEMENT%'))
) AS t(migration, ok);
SELECT 'accents abîmés dans le catalogue : ' || count(*) || CASE WHEN count(*) > 0 THEN ' -> relancer 013_competences_catalogue.sql' ELSE ' (aucun)' END AS encodage
  FROM competence WHERE libelle ~ '[ÃÂ]';
