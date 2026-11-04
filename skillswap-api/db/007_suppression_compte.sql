-- RG14 : suppression de compte par anonymisation. Ajoute le statut SUPPRIME.
-- À appliquer après 006_moderation_charge.sql.
ALTER TABLE utilisateur DROP CONSTRAINT ck_utilisateur_statut;
ALTER TABLE utilisateur ADD CONSTRAINT ck_utilisateur_statut CHECK (statut IN ('ACTIF','SUSPENDU','SUPPRIME'));
