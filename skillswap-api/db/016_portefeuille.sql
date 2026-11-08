SET client_encoding = 'UTF8';
-- 016 : Lot 1bis, portefeuille (solde reflété), séquestre et grand livre.
-- Les montants sont des entiers en FCFA (XAF). Le solde n'est jamais modifié sans une écriture au grand livre,
-- dans la même transaction ; l'argent réel reste chez le prestataire agréé (CinetPay/Notchpay).

CREATE TABLE IF NOT EXISTS portefeuille (
    utilisateur_id uuid        PRIMARY KEY REFERENCES utilisateur(id),
    disponible     bigint      NOT NULL DEFAULT 0,
    sequestre      bigint      NOT NULL DEFAULT 0,
    maj_le         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_portefeuille_disponible CHECK (disponible >= 0),
    CONSTRAINT ck_portefeuille_sequestre  CHECK (sequestre >= 0)
);

-- Opérations avec le prestataire : recharge (encaissement) ou retrait (transfert vers Mobile Money).
CREATE TABLE IF NOT EXISTS transaction_externe (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    utilisateur_id uuid        NOT NULL REFERENCES utilisateur(id),
    sens           varchar(10) NOT NULL,
    montant        bigint      NOT NULL,
    operateur      varchar(10) NOT NULL,
    numero_masque  varchar(20),
    statut         varchar(10) NOT NULL DEFAULT 'EN_ATTENTE',
    reference      varchar(60) NOT NULL UNIQUE,   -- identifiant côté prestataire : sert d'idempotence aux webhooks
    cree_le        timestamptz NOT NULL DEFAULT now(),
    termine_le     timestamptz,
    CONSTRAINT ck_txext_sens    CHECK (sens IN ('RECHARGE','RETRAIT')),
    CONSTRAINT ck_txext_montant CHECK (montant > 0),
    CONSTRAINT ck_txext_operateur CHECK (operateur IN ('MTN','ORANGE')),
    CONSTRAINT ck_txext_statut  CHECK (statut IN ('EN_ATTENTE','REUSSIE','ECHOUEE'))
);
CREATE INDEX IF NOT EXISTS ix_txext_utilisateur ON transaction_externe (utilisateur_id, cree_le DESC);

ALTER TABLE session_echange ADD COLUMN IF NOT EXISTS prix integer;
ALTER TABLE session_echange ADD COLUMN IF NOT EXISTS paiement varchar(10) NOT NULL DEFAULT 'AUCUN';
ALTER TABLE session_echange DROP CONSTRAINT IF EXISTS ck_session_contrepartie;
ALTER TABLE session_echange ADD CONSTRAINT ck_session_contrepartie
    CHECK (contrepartie IN ('TROC','ARGENT_HORS_PLATEFORME','GRATUIT','ARGENT_PLATEFORME'));
ALTER TABLE session_echange DROP CONSTRAINT IF EXISTS ck_session_paiement;
ALTER TABLE session_echange ADD CONSTRAINT ck_session_paiement
    CHECK (paiement IN ('AUCUN','SEQUESTRE','LIBERE','REMBOURSE'));
ALTER TABLE session_echange DROP CONSTRAINT IF EXISTS ck_session_prix;
ALTER TABLE session_echange ADD CONSTRAINT ck_session_prix
    CHECK ((contrepartie = 'ARGENT_PLATEFORME') = (prix IS NOT NULL) AND (prix IS NULL OR prix > 0));

-- Grand livre : une ligne par mouvement, jamais modifiée ni supprimée.
CREATE TABLE IF NOT EXISTS ecriture_portefeuille (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    utilisateur_id   uuid        NOT NULL REFERENCES utilisateur(id),
    type             varchar(15) NOT NULL,
    delta_disponible bigint      NOT NULL DEFAULT 0,
    delta_sequestre  bigint      NOT NULL DEFAULT 0,
    session_id       uuid        REFERENCES session_echange(id),
    transaction_id   uuid        REFERENCES transaction_externe(id),
    cree_le          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_ecriture_type CHECK (type IN
        ('RECHARGE','RETRAIT','RETRAIT_ANNULE','SEQUESTRE','LIBERATION','RECEPTION','REMBOURSEMENT'))
);
CREATE INDEX IF NOT EXISTS ix_ecriture_utilisateur ON ecriture_portefeuille (utilisateur_id, cree_le DESC);

CREATE OR REPLACE FUNCTION trg_ecriture_immuable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'le grand livre est immuable' USING ERRCODE = 'check_violation';
END $$;
DROP TRIGGER IF EXISTS ecriture_immuable ON ecriture_portefeuille;
CREATE TRIGGER ecriture_immuable BEFORE UPDATE OR DELETE ON ecriture_portefeuille
    FOR EACH ROW EXECUTE FUNCTION trg_ecriture_immuable();

INSERT INTO parametre (cle) VALUES ('portefeuille') ON CONFLICT (cle) DO NOTHING;

ALTER TABLE notification DROP CONSTRAINT IF EXISTS ck_notification_type;
ALTER TABLE notification ADD CONSTRAINT ck_notification_type CHECK (type IN
    ('NOUVEAU_MESSAGE','NOUVELLE_SUGGESTION','SESSION_PROPOSEE','SESSION_ACCEPTEE','SESSION_REFUSEE','RAPPEL_AVIS','AVERTISSEMENT_ABSENCE','SUSPENSION','AVERTISSEMENT','LIEN_SESSION','NOUVEAU_SIGNALEMENT',
     'PAIEMENT_SEQUESTRE','PAIEMENT_RECU','PAIEMENT_REMBOURSE','RECHARGE_CONFIRMEE'));
