SET client_encoding = 'UTF8';
-- 014 : paramètres et interrupteurs de fonctionnalités, pilotés depuis l'administration.
-- Une fonctionnalité désactivée est annoncée aux membres comme « en révision » (message modifiable).
CREATE TABLE IF NOT EXISTS parametre (
    cle          varchar(40) PRIMARY KEY,
    actif        boolean     NOT NULL DEFAULT true,
    message      varchar(200),
    modifie_par  uuid        REFERENCES utilisateur(id) ON DELETE SET NULL,
    modifie_le   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO parametre (cle) VALUES
    ('verification_telephone'),
    ('inscriptions'),
    ('propositions_competences'),
    ('recherche_semantique'),
    ('sessions_distance'),
    ('notifications_push')
ON CONFLICT (cle) DO NOTHING;

-- Une clé absente vaut « actif » : une base sans cette ligne garde le comportement d'origine.
CREATE OR REPLACE FUNCTION parametre_actif(k text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce((SELECT actif FROM parametre WHERE cle = k), true) $$;

-- RG17 : la vérification du téléphone n'est exigée que tant que le paramètre « verification_telephone » est actif.
CREATE OR REPLACE FUNCTION trg_conversation_verifier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF parametre_actif('verification_telephone') AND NOT EXISTS (SELECT 1 FROM utilisateur u
                   WHERE u.id = NEW.initiateur_id AND u.telephone_verifie_le IS NOT NULL) THEN
        RAISE EXCEPTION 'téléphone non vérifié pour le membre %', NEW.initiateur_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION trg_session_verifier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM conversation c
                   WHERE c.id = NEW.conversation_id
                     AND ((c.initiateur_id = NEW.enseignant_id AND c.destinataire_id = NEW.apprenant_id)
                       OR (c.initiateur_id = NEW.apprenant_id  AND c.destinataire_id = NEW.enseignant_id))) THEN
        RAISE EXCEPTION 'la session doit relier les deux membres de la conversation %', NEW.conversation_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF parametre_actif('verification_telephone') AND (SELECT count(*) FROM utilisateur u
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
