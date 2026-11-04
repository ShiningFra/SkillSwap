-- Données d'amorçage : catégories du référentiel (issues de l'enquête, Q21 et Q24)
INSERT INTO categorie (libelle) VALUES
 ('Soutien scolaire'),
 ('Informatique, code, bureautique'),
 ('Cuisine et pâtisserie'),
 ('Sport, danse, bien-être'),
 ('Langues'),
 ('Gestion, entrepreneuriat, finance personnelle'),
 ('Design, photo, vidéo'),
 ('Musique et instruments'),
 ('Bricolage, artisanat, réparation'),
 ('Couture, mode, coiffure, beauté')
ON CONFLICT (libelle) DO NOTHING;
