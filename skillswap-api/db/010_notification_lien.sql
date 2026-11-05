-- 010 : une notification peut mener à l'écran concerné (conversation, session). Chemin relatif de l'application uniquement.
ALTER TABLE notification ADD COLUMN IF NOT EXISTS lien varchar(120);
ALTER TABLE notification DROP CONSTRAINT IF EXISTS ck_notification_lien;
ALTER TABLE notification ADD CONSTRAINT ck_notification_lien CHECK (lien IS NULL OR lien ~ '^/[a-z0-9/_-]*$');
