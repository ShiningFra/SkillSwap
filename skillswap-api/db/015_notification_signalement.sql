-- 015 : les administrateurs reçoivent une notification à chaque nouveau signalement.
SET client_encoding = 'UTF8';
ALTER TABLE notification DROP CONSTRAINT IF EXISTS ck_notification_type;
ALTER TABLE notification ADD CONSTRAINT ck_notification_type CHECK (type IN
    ('NOUVEAU_MESSAGE','NOUVELLE_SUGGESTION','SESSION_PROPOSEE','SESSION_ACCEPTEE','SESSION_REFUSEE','RAPPEL_AVIS','AVERTISSEMENT_ABSENCE','SUSPENSION','AVERTISSEMENT','LIEN_SESSION','NOUVEAU_SIGNALEMENT'));
