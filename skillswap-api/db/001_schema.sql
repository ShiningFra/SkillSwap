-- =====================================================================
-- SkillSwap — schéma PostgreSQL du MVP (Lot 1)
-- Source : dossier de conception v1.2 (MLD) et règles de gestion RG1 à RG21
-- Version minimale testée : PostgreSQL 14 (gen_random_uuid() est natif depuis la 13)
-- Les énumérations sont des colonnes varchar contrôlées par CHECK, pour
-- pouvoir ajouter une valeur sans migration de type.
-- =====================================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- contrainte d'exclusion des créneaux (RG6)

-- ---------------------------------------------------------------------
-- Utilisateur
-- ---------------------------------------------------------------------
CREATE TABLE utilisateur (
    id                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    email                 varchar(254) NOT NULL,
    mot_de_passe_hash     varchar      NOT NULL,
    pseudo                varchar(40)  NOT NULL,
    bio                   text,
    ville                 varchar(80),
    mode_localisation     varchar(12)  NOT NULL DEFAULT 'AUCUNE',
    latitude              numeric(9,6),
    longitude             numeric(9,6),
    telephone             varchar(20),
    telephone_verifie_le  timestamptz,
    role                  varchar(10)  NOT NULL DEFAULT 'MEMBRE',
    statut                varchar(10)  NOT NULL DEFAULT 'ACTIF',
    majeur_confirme_le    timestamptz  NOT NULL,                       -- RG1
    cree_le               timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ck_utilisateur_mode   CHECK (mode_localisation IN ('AUCUNE','MANUELLE','AUTOMATIQUE')),
    CONSTRAINT ck_utilisateur_role   CHECK (role IN ('MEMBRE','ADMIN')),
    CONSTRAINT ck_utilisateur_statut CHECK (statut IN ('ACTIF','SUSPENDU','SUPPRIME')),
    CONSTRAINT ck_utilisateur_lat    CHECK (latitude  BETWEEN -90  AND 90),
    CONSTRAINT ck_utilisateur_lon    CHECK (longitude BETWEEN -180 AND 180),
    -- RG17 : numéro au format international sans séparateur ; une vérification suppose un numéro
    CONSTRAINT ck_utilisateur_tel    CHECK (telephone IS NULL OR telephone ~ '^\+[0-9]{8,15}$'),
    CONSTRAINT ck_utilisateur_tel_verifie CHECK (telephone_verifie_le IS NULL OR telephone IS NOT NULL),
    -- RG5 : des coordonnées n'existent qu'en mode AUTOMATIQUE, et toujours par paire
    CONSTRAINT ck_utilisateur_coord  CHECK (
        (mode_localisation = 'AUTOMATIQUE' AND latitude IS NOT NULL AND longitude IS NOT NULL)
     OR (mode_localisation <> 'AUTOMATIQUE' AND latitude IS NULL     AND longitude IS NULL))
);
CREATE UNIQUE INDEX ux_utilisateur_email ON utilisateur (lower(email));
-- RG17 : un numéro vérifié n'appartient qu'à un seul compte
CREATE UNIQUE INDEX ux_utilisateur_tel_verifie ON utilisateur (telephone) WHERE telephone_verifie_le IS NOT NULL;

-- RG17 : codes à usage unique envoyés par SMS (le code n'est jamais stocké en clair)
CREATE TABLE verification_telephone (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    utilisateur_id  uuid        NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
    telephone       varchar(20) NOT NULL,
    code_hash       varchar     NOT NULL,
    cree_le         timestamptz NOT NULL DEFAULT now(),
    expire_le       timestamptz NOT NULL,
    tentatives      smallint    NOT NULL DEFAULT 0,
    valide_le       timestamptz,
    CONSTRAINT ck_verif_tel_format     CHECK (telephone ~ '^\+[0-9]{8,15}$'),
    CONSTRAINT ck_verif_tel_expiration CHECK (expire_le > cree_le),
    CONSTRAINT ck_verif_tel_tentatives CHECK (tentatives BETWEEN 0 AND 5)
);
CREATE INDEX ix_verif_tel_utilisateur ON verification_telephone (utilisateur_id, cree_le DESC);

-- ---------------------------------------------------------------------
-- Référentiel de compétences
-- ---------------------------------------------------------------------
CREATE TABLE categorie (
    id       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    libelle  varchar(80) NOT NULL UNIQUE
);

CREATE TABLE competence (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    libelle       varchar(80) NOT NULL UNIQUE,
    categorie_id  uuid        NOT NULL REFERENCES categorie(id)
);
CREATE INDEX ix_competence_categorie ON competence (categorie_id);

-- RG3 : un membre déclare une compétence une seule fois, en offre OU en recherche
CREATE TABLE declaration_competence (
    utilisateur_id  uuid        NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
    competence_id   uuid        NOT NULL REFERENCES competence(id),
    sens            varchar(10) NOT NULL,
    niveau          varchar(15) NOT NULL,
    format          varchar(12) NOT NULL,
    description     text,
    preuve_url      varchar(500),                  -- RG18 : lien vers une réalisation, facultatif
    PRIMARY KEY (utilisateur_id, competence_id),
    CONSTRAINT ck_decl_sens   CHECK (sens   IN ('OFFERTE','RECHERCHEE')),
    CONSTRAINT ck_decl_niveau CHECK (niveau IN ('DEBUTANT','INTERMEDIAIRE','AVANCE')),
    CONSTRAINT ck_decl_format CHECK (format IN ('PRESENTIEL','DISTANCE','LES_DEUX')),
    -- RG18 : une preuve n'a de sens que sur une compétence offerte, et doit être un lien web
    CONSTRAINT ck_decl_preuve CHECK (preuve_url IS NULL OR (sens = 'OFFERTE' AND preuve_url ~* '^https?://'))
);
CREATE INDEX ix_decl_competence ON declaration_competence (competence_id, sens);

-- ---------------------------------------------------------------------
-- Créneaux de disponibilité
-- ---------------------------------------------------------------------
CREATE TABLE creneau (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    utilisateur_id  uuid        NOT NULL REFERENCES utilisateur(id),
    debut           timestamptz NOT NULL,
    fin             timestamptz NOT NULL,
    format          varchar(12) NOT NULL,
    prix_indicatif  integer,                       -- RG7 : en francs CFA, informatif
    statut          varchar(10) NOT NULL DEFAULT 'LIBRE',
    CONSTRAINT ck_creneau_fin     CHECK (fin > debut),                       -- RG6
    CONSTRAINT ck_creneau_format  CHECK (format IN ('PRESENTIEL','DISTANCE','LES_DEUX')),
    CONSTRAINT ck_creneau_statut  CHECK (statut IN ('LIBRE','RESERVE','ANNULE')),
    CONSTRAINT ck_creneau_prix    CHECK (prix_indicatif IS NULL OR prix_indicatif >= 0),
    -- RG6 : pas de chevauchement entre les créneaux non annulés d'un même membre
    CONSTRAINT ex_creneau_chevauchement EXCLUDE USING gist
        (utilisateur_id WITH =, tstzrange(debut, fin) WITH &&)
        WHERE (statut <> 'ANNULE')
);
CREATE INDEX ix_creneau_recherche ON creneau (statut, debut);

-- ---------------------------------------------------------------------
-- Conversations et messages
-- ---------------------------------------------------------------------
CREATE TABLE conversation (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    initiateur_id    uuid        NOT NULL REFERENCES utilisateur(id),
    destinataire_id  uuid        NOT NULL REFERENCES utilisateur(id),
    cree_le          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_conversation_distincts CHECK (initiateur_id <> destinataire_id)   -- RG2
);
-- RG2 : un seul fil par couple de membres, quel que soit l'initiateur
CREATE UNIQUE INDEX ux_conversation_couple ON conversation
    (LEAST(initiateur_id, destinataire_id), GREATEST(initiateur_id, destinataire_id));
CREATE INDEX ix_conversation_initiateur   ON conversation (initiateur_id);
CREATE INDEX ix_conversation_destinataire ON conversation (destinataire_id);

CREATE TABLE message (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id  uuid        NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    expediteur_id    uuid        NOT NULL REFERENCES utilisateur(id),
    contenu          text        NOT NULL,
    envoye_le        timestamptz NOT NULL DEFAULT now(),
    lu_le            timestamptz,
    CONSTRAINT ck_message_contenu CHECK (char_length(contenu) BETWEEN 1 AND 5000)
);
CREATE INDEX ix_message_fil ON message (conversation_id, envoye_le);

-- ---------------------------------------------------------------------
-- Sessions d'échange
-- ---------------------------------------------------------------------
CREATE TABLE session_echange (
    id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id          uuid        NOT NULL REFERENCES conversation(id),
    enseignant_id            uuid        NOT NULL REFERENCES utilisateur(id),
    apprenant_id             uuid        NOT NULL REFERENCES utilisateur(id),
    propose_par_id           uuid        NOT NULL REFERENCES utilisateur(id),
    competence_id            uuid        NOT NULL REFERENCES competence(id),
    creneau_id               uuid        REFERENCES creneau(id),
    date_heure               timestamptz NOT NULL,
    duree_min                integer     NOT NULL,
    format                   varchar(12) NOT NULL,
    lieu_type                varchar(15),                               -- RG20
    lieu_ou_lien             varchar(255),
    absent_id                uuid        REFERENCES utilisateur(id),     -- RG19
    contrepartie             varchar(25) NOT NULL,                      -- RG16
    statut                   varchar(15) NOT NULL DEFAULT 'PROPOSEE',
    cree_le                  timestamptz NOT NULL DEFAULT now(),
    confirme_enseignant_le   timestamptz,
    confirme_apprenant_le    timestamptz,
    realisee_le              timestamptz,
    CONSTRAINT ck_session_distincts  CHECK (enseignant_id <> apprenant_id),                          -- RG8
    CONSTRAINT ck_session_proposant  CHECK (propose_par_id IN (enseignant_id, apprenant_id)),        -- RG8
    CONSTRAINT ck_session_duree      CHECK (duree_min > 0),
    CONSTRAINT ck_session_format     CHECK (format IN ('PRESENTIEL','DISTANCE','LES_DEUX')),
    CONSTRAINT ck_session_contrepartie CHECK (contrepartie IN ('TROC','ARGENT_HORS_PLATEFORME','GRATUIT')),
    -- RG20 : le type de lieu ne concerne que les rencontres en présentiel
    CONSTRAINT ck_session_lieu_type  CHECK (lieu_type IS NULL OR
        (lieu_type IN ('PUBLIC','ESPACE_PARTAGE','DOMICILE') AND format <> 'DISTANCE')),
    -- RG19 : une absence est déclarée sur une session non réalisée, et concerne l'un des deux participants
    CONSTRAINT ck_session_absent     CHECK (absent_id IS NULL OR
        (statut = 'NON_REALISEE' AND absent_id IN (enseignant_id, apprenant_id))),
    CONSTRAINT ck_session_statut     CHECK (statut IN ('PROPOSEE','ACCEPTEE','REFUSEE','EXPIREE','ANNULEE','REALISEE','NON_REALISEE')),
    -- RG11 : REALISEE suppose les deux confirmations et une date de réalisation
    CONSTRAINT ck_session_realisee   CHECK (statut <> 'REALISEE' OR
        (confirme_enseignant_le IS NOT NULL AND confirme_apprenant_le IS NOT NULL AND realisee_le IS NOT NULL))
);
-- RG9 : un créneau n'a qu'une session active. Une proposition refusée, expirée ou
-- annulée libère le créneau, qui peut donc réapparaître dans plusieurs sessions.
CREATE UNIQUE INDEX ux_session_creneau_actif ON session_echange (creneau_id)
    WHERE creneau_id IS NOT NULL AND statut IN ('PROPOSEE','ACCEPTEE','REALISEE');
CREATE INDEX ix_session_expiration   ON session_echange (statut, cree_le);
CREATE INDEX ix_session_enseignant   ON session_echange (enseignant_id);
CREATE INDEX ix_session_apprenant    ON session_echange (apprenant_id);
CREATE INDEX ix_session_conversation ON session_echange (conversation_id);

-- ---------------------------------------------------------------------
-- Avis
-- ---------------------------------------------------------------------
CREATE TABLE avis (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   uuid        NOT NULL REFERENCES session_echange(id),
    auteur_id    uuid        NOT NULL REFERENCES utilisateur(id),
    cible_id     uuid        NOT NULL REFERENCES utilisateur(id),
    note         smallint    NOT NULL,
    commentaire  text,
    cree_le      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_avis_note      CHECK (note BETWEEN 1 AND 5),
    CONSTRAINT ck_avis_distincts CHECK (auteur_id <> cible_id),
    CONSTRAINT ux_avis_auteur_session UNIQUE (session_id, auteur_id)             -- RG11
);
CREATE INDEX ix_avis_cible ON avis (cible_id);   -- note moyenne (RG12)

-- ---------------------------------------------------------------------
-- Signalements, notifications, consentements
-- ---------------------------------------------------------------------
CREATE TABLE signalement (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    auteur_id      uuid        NOT NULL REFERENCES utilisateur(id),
    cible_id       uuid        NOT NULL REFERENCES utilisateur(id),
    message_id     uuid        REFERENCES message(id) ON DELETE SET NULL,
    moderateur_id  uuid        REFERENCES utilisateur(id),
    motif          varchar(30) NOT NULL,
    description    text,
    statut         varchar(10) NOT NULL DEFAULT 'OUVERT',
    decision       text,
    -- RG22 : gravité déduite du motif, pour trier la file de modération (jamais saisie)
    gravite        varchar(7)  GENERATED ALWAYS AS (CASE motif WHEN 'COMPORTEMENT_INAPPROPRIE' THEN 'HAUTE' WHEN 'FAUX_PROFIL' THEN 'MOYENNE' ELSE 'BASSE' END) STORED,
    cree_le        timestamptz NOT NULL DEFAULT now(),
    traite_le      timestamptz,
    CONSTRAINT ck_signalement_distincts CHECK (auteur_id <> cible_id),           -- RG13
    CONSTRAINT ck_signalement_motif  CHECK (motif IN ('FAUX_PROFIL','COMPORTEMENT_INAPPROPRIE','SPAM','AUTRE')),
    CONSTRAINT ck_signalement_statut CHECK (statut IN ('OUVERT','EN_COURS','TRAITE','REJETE')),
    CONSTRAINT ck_signalement_moderation CHECK (statut = 'OUVERT' OR moderateur_id IS NOT NULL),
    CONSTRAINT ck_signalement_cloture CHECK (statut NOT IN ('TRAITE','REJETE') OR traite_le IS NOT NULL)
);
CREATE INDEX ix_signalement_file ON signalement (statut, cree_le);
CREATE INDEX ix_signalement_cible ON signalement (cible_id);

CREATE TABLE notification (
    id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    utilisateur_id  uuid         NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
    type            varchar(25)  NOT NULL,
    contenu         varchar(255) NOT NULL,
    cree_le         timestamptz  NOT NULL DEFAULT now(),
    lu_le           timestamptz,
    CONSTRAINT ck_notification_type CHECK (type IN
        ('NOUVEAU_MESSAGE','NOUVELLE_SUGGESTION','SESSION_PROPOSEE','SESSION_ACCEPTEE','SESSION_REFUSEE','RAPPEL_AVIS','AVERTISSEMENT_ABSENCE','SUSPENSION'))
);
CREATE INDEX ix_notification_non_lues ON notification (utilisateur_id, lu_le);

CREATE TABLE consentement (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    utilisateur_id  uuid        NOT NULL REFERENCES utilisateur(id),
    finalite        varchar(30) NOT NULL,
    version_texte   varchar(20) NOT NULL,
    accorde_le      timestamptz NOT NULL DEFAULT now(),
    revoque_le      timestamptz,
    CONSTRAINT ck_consentement_finalite CHECK (finalite IN ('CGU','LOCALISATION')),
    CONSTRAINT ck_consentement_dates    CHECK (revoque_le IS NULL OR revoque_le >= accorde_le)
);
-- Un seul consentement actif par membre et par finalité
CREATE UNIQUE INDEX ux_consentement_actif ON consentement (utilisateur_id, finalite) WHERE revoque_le IS NULL;
CREATE INDEX ix_consentement_suivi ON consentement (utilisateur_id, finalite, revoque_le);

-- ---------------------------------------------------------------------
-- Règles qu'une contrainte déclarative ne peut pas exprimer : triggers
-- ---------------------------------------------------------------------

-- Un message est écrit par l'un des deux membres de la conversation
CREATE FUNCTION trg_message_verifier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM conversation c
                   WHERE c.id = NEW.conversation_id
                     AND NEW.expediteur_id IN (c.initiateur_id, c.destinataire_id)) THEN
        RAISE EXCEPTION 'expéditeur % étranger à la conversation %', NEW.expediteur_id, NEW.conversation_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER message_verifier BEFORE INSERT ON message
    FOR EACH ROW EXECUTE FUNCTION trg_message_verifier();

-- RG17 : seul un membre dont le téléphone est vérifié peut ouvrir une conversation
CREATE FUNCTION trg_conversation_verifier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM utilisateur u
                   WHERE u.id = NEW.initiateur_id AND u.telephone_verifie_le IS NOT NULL) THEN
        RAISE EXCEPTION 'téléphone non vérifié pour le membre %', NEW.initiateur_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER conversation_verifier BEFORE INSERT ON conversation
    FOR EACH ROW EXECUTE FUNCTION trg_conversation_verifier();

-- RG8 : une session relie les deux membres de sa conversation ; la compétence est offerte
-- par l'enseignant ; le créneau éventuel appartient à l'enseignant
CREATE FUNCTION trg_session_verifier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM conversation c
                   WHERE c.id = NEW.conversation_id
                     AND ((c.initiateur_id = NEW.enseignant_id AND c.destinataire_id = NEW.apprenant_id)
                       OR (c.initiateur_id = NEW.apprenant_id  AND c.destinataire_id = NEW.enseignant_id))) THEN
        RAISE EXCEPTION 'la session doit relier les deux membres de la conversation %', NEW.conversation_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT count(*) FROM utilisateur u
         WHERE u.id IN (NEW.enseignant_id, NEW.apprenant_id) AND u.telephone_verifie_le IS NOT NULL) <> 2 THEN
        RAISE EXCEPTION 'RG17 : les deux participants doivent avoir un téléphone vérifié'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM declaration_competence d
                   WHERE d.utilisateur_id = NEW.enseignant_id
                     AND d.competence_id = NEW.competence_id AND d.sens = 'OFFERTE') THEN
        RAISE EXCEPTION 'la compétence % n''est pas offerte par l''enseignant', NEW.competence_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.creneau_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM creneau k
                   WHERE k.id = NEW.creneau_id AND k.utilisateur_id = NEW.enseignant_id) THEN
        RAISE EXCEPTION 'le créneau % n''appartient pas à l''enseignant', NEW.creneau_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER session_verifier BEFORE INSERT ON session_echange
    FOR EACH ROW EXECUTE FUNCTION trg_session_verifier();

-- RG11 : un avis suit une session REALISEE, entre ses deux participants
CREATE FUNCTION trg_avis_verifier() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s session_echange%ROWTYPE;
BEGIN
    SELECT * INTO s FROM session_echange WHERE id = NEW.session_id;
    IF s.statut IS DISTINCT FROM 'REALISEE' THEN
        RAISE EXCEPTION 'avis impossible : la session % n''est pas réalisée', NEW.session_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF NOT ((NEW.auteur_id = s.enseignant_id AND NEW.cible_id = s.apprenant_id)
         OR (NEW.auteur_id = s.apprenant_id  AND NEW.cible_id = s.enseignant_id)) THEN
        RAISE EXCEPTION 'l''auteur et la cible doivent être les deux participants de la session %', NEW.session_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER avis_verifier BEFORE INSERT ON avis
    FOR EACH ROW EXECUTE FUNCTION trg_avis_verifier();

-- ---------------------------------------------------------------------
-- Fonctions utilitaires (côté serveur uniquement : RG4)
-- ---------------------------------------------------------------------
-- Distance à vol d'oiseau en km (formule de haversine)
CREATE FUNCTION distance_km(lat1 double precision, lon1 double precision,
                            lat2 double precision, lon2 double precision)
RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT 2 * 6371 * asin(sqrt(
        power(sin(radians(lat2 - lat1) / 2), 2)
      + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)))
$$;

-- Distance arrondie à l'entier supérieur, jamais moins de 1 km : « à 3 km »
CREATE FUNCTION distance_approximative_km(lat1 double precision, lon1 double precision,
                                          lat2 double precision, lon2 double precision)
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT GREATEST(1, ceil(distance_km(lat1, lon1, lat2, lon2)))::integer
$$;

-- Vue : note moyenne et nombre d'avis par membre (RG12)
CREATE VIEW v_reputation AS
    SELECT cible_id AS utilisateur_id,
           round(avg(note)::numeric, 2) AS note_moyenne,
           count(*)                     AS nb_avis
    FROM avis GROUP BY cible_id;

-- Vue : indicateur de concrétisation (RG15) = sessions réalisées / conversations
CREATE VIEW v_indicateur_concretisation AS
    SELECT (SELECT count(*) FROM session_echange WHERE statut = 'REALISEE') AS sessions_realisees,
           (SELECT count(*) FROM conversation)                              AS conversations,
           CASE WHEN (SELECT count(*) FROM conversation) = 0 THEN NULL
                ELSE round(100.0 * (SELECT count(*) FROM session_echange WHERE statut = 'REALISEE')
                                 / (SELECT count(*) FROM conversation), 1) END AS taux_pourcent;

-- RG19 : absences déclarées sur les 90 derniers jours, par membre. Le seuil d'avertissement
-- (1re absence) et de suspension (3 absences, valeur proposée) se règle dans l'application.
CREATE VIEW v_absences AS
    SELECT absent_id AS utilisateur_id,
           count(*)  AS nb_absences_90j,
           max(date_heure) AS derniere_absence
    FROM session_echange
    WHERE absent_id IS NOT NULL AND date_heure >= now() - interval '90 days'
    GROUP BY absent_id;

-- RG21 : une compétence offerte est « confirmée » par l'usage lorsqu'au moins 3 sessions
-- réalisées sur cette compétence ont reçu l'avis de l'apprenant, avec une moyenne d'au moins 4.
-- Les seuils (3 et 4) sont des valeurs de départ, ajustables ici.
CREATE VIEW v_competence_confirmee AS
    SELECT d.utilisateur_id,
           d.competence_id,
           (d.preuve_url IS NOT NULL)            AS preuve_fournie,
           count(a.id)                           AS nb_avis_apprenants,
           round(avg(a.note)::numeric, 2)        AS note_moyenne,
           (count(a.id) >= 3 AND avg(a.note) >= 4) AS confirmee
    FROM declaration_competence d
    LEFT JOIN session_echange s
           ON s.enseignant_id = d.utilisateur_id AND s.competence_id = d.competence_id AND s.statut = 'REALISEE'
    LEFT JOIN avis a
           ON a.session_id = s.id AND a.auteur_id = s.apprenant_id AND a.cible_id = s.enseignant_id
    WHERE d.sens = 'OFFERTE'
    GROUP BY d.utilisateur_id, d.competence_id, d.preuve_url;

COMMIT;
