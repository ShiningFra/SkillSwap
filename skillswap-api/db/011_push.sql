-- 011 : abonnements Web Push (notifications sur l'appareil) et signal de nouvelle notification.
CREATE TABLE IF NOT EXISTS push_abonnement (
    id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    utilisateur_id  uuid         NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
    endpoint        text         NOT NULL UNIQUE,
    cle_p256dh      varchar(120) NOT NULL,
    cle_auth        varchar(60)  NOT NULL,
    cree_le         timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ck_push_endpoint CHECK (endpoint ~ '^https://' AND length(endpoint) <= 600)
);
CREATE INDEX IF NOT EXISTS ix_push_utilisateur ON push_abonnement (utilisateur_id);

-- À chaque nouvelle notification validée, l'API est prévenue (LISTEN/NOTIFY) et envoie le push.
CREATE OR REPLACE FUNCTION notifier_nouvelle_notification() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('nouvelle_notification', NEW.id::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tg_notification_push ON notification;
CREATE TRIGGER tg_notification_push AFTER INSERT ON notification
    FOR EACH ROW EXECUTE FUNCTION notifier_nouvelle_notification();
