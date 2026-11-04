-- Mot de passe oublié : jetons de réinitialisation à usage unique.
-- À appliquer après 007_suppression_compte.sql.
-- Le jeton n'est jamais stocké, seulement son empreinte SHA-256 (comme les sessions, ES4).
CREATE TABLE reinitialisation_mdp (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    utilisateur_id  uuid        NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
    jeton_hash      char(64)    NOT NULL UNIQUE,
    cree_le         timestamptz NOT NULL DEFAULT now(),
    expire_le       timestamptz NOT NULL,
    utilise_le      timestamptz,
    CONSTRAINT ck_reinit_duree CHECK (expire_le > cree_le)
);
CREATE INDEX ix_reinit_utilisateur ON reinitialisation_mdp (utilisateur_id, cree_le DESC);
