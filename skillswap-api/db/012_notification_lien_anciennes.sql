-- 012 : rattache aux conversations les anciennes notifications de message (créées avant la colonne « lien »).
-- Pour chaque notification sans lien, on retient la conversation du destinataire où l'autre membre a écrit le plus près de la notification (±60 s).
UPDATE notification n
SET lien = '/messages/' || (
    SELECT m.conversation_id
    FROM message m
    JOIN conversation cv ON cv.id = m.conversation_id
    WHERE (cv.initiateur_id = n.utilisateur_id OR cv.destinataire_id = n.utilisateur_id)
      AND m.expediteur_id <> n.utilisateur_id
      AND m.envoye_le BETWEEN n.cree_le - interval '60 seconds' AND n.cree_le + interval '60 seconds'
    ORDER BY abs(extract(epoch FROM m.envoye_le - n.cree_le))
    LIMIT 1
)
WHERE n.type = 'NOUVEAU_MESSAGE' AND n.lien IS NULL
  AND EXISTS (
    SELECT 1 FROM message m JOIN conversation cv ON cv.id = m.conversation_id
    WHERE (cv.initiateur_id = n.utilisateur_id OR cv.destinataire_id = n.utilisateur_id)
      AND m.expediteur_id <> n.utilisateur_id
      AND m.envoye_le BETWEEN n.cree_le - interval '60 seconds' AND n.cree_le + interval '60 seconds');
