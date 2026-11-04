-- Sécurité de l'API (CDC 7.6) : sessions de connexion, tentatives de connexion, journal d'audit.
-- À appliquer après 001_schema.sql.

-- ES4 : le jeton de session n'est jamais stocké, seulement son empreinte SHA-256.
CREATE TABLE session_connexion (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    utilisateur_id  uuid        NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
    jeton_hash      char(64)    NOT NULL UNIQUE,
    cree_le         timestamptz NOT NULL DEFAULT now(),
    expire_le       timestamptz NOT NULL,
    revoque_le      timestamptz,
    CONSTRAINT ck_session_connexion_duree CHECK (expire_le > cree_le)
);
CREATE INDEX ix_session_connexion_utilisateur ON session_connexion (utilisateur_id) WHERE revoque_le IS NULL;

-- ES3 : limitation des tentatives par compte et par IP. L'e-mail n'est conservé que sous forme d'empreinte.
CREATE TABLE tentative_connexion (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email_hash  char(64)    NOT NULL,
    ip          varchar(45) NOT NULL,
    reussie     boolean     NOT NULL,
    cree_le     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_tentative_email ON tentative_connexion (email_hash, cree_le DESC);
CREATE INDEX ix_tentative_ip    ON tentative_connexion (ip, cree_le DESC);

-- ES10 : journal d'audit. Jamais de mot de passe, de code, de jeton ni de coordonnées dans `detail`.
CREATE TABLE journal_audit (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    acteur_id   uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
    action      varchar(40) NOT NULL,
    cible       varchar(80),
    detail      jsonb       NOT NULL DEFAULT '{}',
    cree_le     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_journal_audit_date ON journal_audit (cree_le);
