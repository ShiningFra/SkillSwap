-- Modération : ajoute le type de notification « AVERTISSEMENT » (décision « avertir » d'un administrateur).
-- À appliquer après 003_securite.sql. Sans effet sur les données existantes.
ALTER TABLE notification DROP CONSTRAINT ck_notification_type;
ALTER TABLE notification ADD CONSTRAINT ck_notification_type CHECK (type IN
    ('NOUVEAU_MESSAGE','NOUVELLE_SUGGESTION','SESSION_PROPOSEE','SESSION_ACCEPTEE','SESSION_REFUSEE','RAPPEL_AVIS','AVERTISSEMENT_ABSENCE','SUSPENSION','AVERTISSEMENT'));
