-- Compétences d'exemple pour le développement (à ne pas appliquer en production).
INSERT INTO competence (libelle, categorie_id)
SELECT v.libelle, c.id
FROM (VALUES
  ('Python', 'Informatique, code, bureautique'),
  ('Excel', 'Informatique, code, bureautique'),
  ('Anglais', 'Langues'),
  ('Français', 'Langues'),
  ('Cuisine camerounaise', 'Cuisine et pâtisserie'),
  ('Mathématiques', 'Soutien scolaire'),
  ('Photographie', 'Design, photo, vidéo'),
  ('Guitare', 'Musique et instruments')
) AS v(libelle, categorie)
JOIN categorie c ON c.libelle = v.categorie
ON CONFLICT (libelle) DO NOTHING;
