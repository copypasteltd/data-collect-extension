export const compareEvents = (a, b) =>
  (Number(a.time) || 0) - (Number(b.time) || 0) ||
  (Number(a.seq) || 0) - (Number(b.seq) || 0);
