import { classerParSimilarite } from './semantique.service';

const unitaire = (x: number, y: number) => {
  const n = Math.hypot(x, y);
  return [x / n, y / n];
};

describe('classerParSimilarite', () => {
  const cands = [
    { id: 'a', vecteur: unitaire(1, 0) },
    { id: 'b', vecteur: unitaire(1, 0.1) },
    { id: 'c', vecteur: unitaire(0, 1) },
  ];
  it('garde les plus proches et écarte le reste', () => {
    const r = classerParSimilarite(unitaire(1, 0.02), cands);
    expect(r.map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('ne renvoie rien quand rien n’est assez proche', () => {
    expect(classerParSimilarite(unitaire(0.6, 0.6), cands)).toEqual([]);
  });
});
