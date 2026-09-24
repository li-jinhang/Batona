export function newestSessionsFirst(sessions) {
  return [...sessions].sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}
