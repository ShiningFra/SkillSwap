SET client_encoding = 'UTF8';
-- 017 : réparation des accents abîmés (« dâ€™un » au lieu de « d’un », « PrÃ©paration »).
-- Cause : un script appliqué avec un client en WIN1252. La 013 ne repérait que « Ã » et « Â » ; l'apostrophe typographique
-- donne « â€™ », qui lui échappait, et la ligne saine réinsérée par la 013 créait un doublon dans le catalogue.
-- Pour chaque ligne abîmée : si la version saine existe déjà, on y rattache les déclarations et sessions puis on supprime
-- la ligne abîmée ; sinon on corrige le texte en place. Un texte légitime avec « â » échoue à la conversion et reste intact.
CREATE OR REPLACE FUNCTION pg_temp.remettre(t text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN convert_from(convert_to(t, 'WIN1252'), 'UTF8');
EXCEPTION WHEN OTHERS THEN
  RETURN t;
END $$;

DO $$
DECLARE r record; sain uuid; neuf text;
BEGIN
  FOR r IN SELECT id, libelle, synonymes FROM competence WHERE libelle ~ '[ÃÂâ]' OR synonymes ~ '[ÃÂâ]' LOOP
    neuf := pg_temp.remettre(r.libelle);
    SELECT id INTO sain FROM competence WHERE libelle = neuf AND id <> r.id;
    IF sain IS NOT NULL THEN
      UPDATE declaration_competence d SET competence_id = sain WHERE d.competence_id = r.id
        AND NOT EXISTS (SELECT 1 FROM declaration_competence x WHERE x.utilisateur_id = d.utilisateur_id
                         AND x.competence_id = sain AND x.sens = d.sens);
      DELETE FROM declaration_competence WHERE competence_id = r.id;
      UPDATE session_echange SET competence_id = sain WHERE competence_id = r.id;
      DELETE FROM competence WHERE id = r.id;
    ELSE
      UPDATE competence SET libelle = neuf, synonymes = pg_temp.remettre(r.synonymes) WHERE id = r.id;
    END IF;
  END LOOP;
  UPDATE categorie SET libelle = pg_temp.remettre(libelle) WHERE libelle ~ '[ÃÂâ]';
END $$;
