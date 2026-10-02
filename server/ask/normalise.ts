/**
 * The form of a query that keys the response cache and the recorded answers: Unicode-composed,
 * whitespace collapsed, lower-cased. Two queries that differ only in case or spacing are one
 * question, one cache entry and one recorded answer.
 */
export function normaliseQuery(query: string): string {
  return query.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('uk')
}
