-- Charge de modération (RG22, RG23) : gravité calculée et retrait du motif « absence sans prévenir »
-- (les absences passent par la déclaration d'absence, RG19 ; une contestation se fait avec le motif AUTRE).
-- À appliquer après 005_moderation.sql sur une base existante (sans effet sur une base créée avec la v1.7 du schéma).
BEGIN;
UPDATE signalement SET motif = 'AUTRE' WHERE motif = 'ABSENCE_SANS_PREVENIR';
ALTER TABLE signalement DROP CONSTRAINT ck_signalement_motif;
ALTER TABLE signalement ADD CONSTRAINT ck_signalement_motif CHECK (motif IN ('FAUX_PROFIL','COMPORTEMENT_INAPPROPRIE','SPAM','AUTRE'));
ALTER TABLE signalement ADD COLUMN IF NOT EXISTS gravite varchar(7) GENERATED ALWAYS AS
    (CASE motif WHEN 'COMPORTEMENT_INAPPROPRIE' THEN 'HAUTE' WHEN 'FAUX_PROFIL' THEN 'MOYENNE' ELSE 'BASSE' END) STORED;
COMMIT;
