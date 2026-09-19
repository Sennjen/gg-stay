import { Kind } from 'graphql'
import type {
  DefinitionNode,
  DocumentNode,
  FragmentDefinitionNode,
  SelectionSetNode,
} from 'graphql'

// The BFF is a public, unauthenticated endpoint, and every root `game` field costs three upstream
// calls (detail + stores + screenshots) through a per-instance rate limiter. Without a cost limit
// one anonymous request can reserve hundreds of limiter slots and delay every other request the
// same instance serves, besides spending the upstream quota. The schema is deliberately
// non-recursive, so depth is already bounded by design — breadth (aliased root fields) is the
// vector these limits close.
//
// The numbers are sized off this app's own documents, with headroom: the widest one (Landing)
// uses 1 root field and reaches depth 5; the deepest reaches depth 5 as well. `queryLimits.test.ts`
// re-checks every shipped document against these limits so a new document cannot silently
// outgrow them.
export const MAX_ROOT_FIELDS = 12
export const MAX_DEPTH = 7
export const MAX_ALIASED_UPSTREAM_FIELDS = 3

/** Root fields whose resolvers each reach an upstream API. */
const UPSTREAM_ROOT_FIELDS = new Set(['game', 'games', 'landing'])

export const QUERY_TOO_COMPLEX = 'QUERY_TOO_COMPLEX'
export const INTROSPECTION_DISABLED = 'INTROSPECTION_DISABLED'

export interface QueryLimitViolation {
  code: typeof QUERY_TOO_COMPLEX | typeof INTROSPECTION_DISABLED
  message: string
}

function fragmentsOf(document: DocumentNode): Map<string, FragmentDefinitionNode> {
  const map = new Map<string, FragmentDefinitionNode>()
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) map.set(definition.name.value, definition)
  }
  return map
}

/**
 * Deepest field nesting reachable from `selectionSet`, following fragment spreads. `seen` guards
 * against a fragment cycle: a cyclic document is invalid anyway, but this runs before validation,
 * so it must not hang on one.
 */
function depthOf(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  seen: ReadonlySet<string> = new Set(),
): number {
  let deepest = 0
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const below = selection.selectionSet ? depthOf(selection.selectionSet, fragments, seen) : 0
      deepest = Math.max(deepest, 1 + below)
      continue
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      deepest = Math.max(deepest, depthOf(selection.selectionSet, fragments, seen))
      continue
    }
    const name = selection.name.value
    if (seen.has(name)) continue
    const fragment = fragments.get(name)
    if (!fragment) continue
    deepest = Math.max(deepest, depthOf(fragment.selectionSet, fragments, new Set([...seen, name])))
  }
  return deepest
}

/** Root-level fields of an operation, with fragment spreads on the operation type expanded. */
function rootFieldNames(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  seen: ReadonlySet<string> = new Set(),
): string[] {
  const names: string[] = []
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      names.push(selection.name.value)
      continue
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      names.push(...rootFieldNames(selection.selectionSet, fragments, seen))
      continue
    }
    const name = selection.name.value
    if (seen.has(name)) continue
    const fragment = fragments.get(name)
    if (!fragment) continue
    names.push(...rootFieldNames(fragment.selectionSet, fragments, new Set([...seen, name])))
  }
  return names
}

function usesIntrospection(
  definition: DefinitionNode,
  fragments: Map<string, FragmentDefinitionNode>,
): boolean {
  if (definition.kind !== Kind.OPERATION_DEFINITION) return false
  return rootFieldNames(definition.selectionSet, fragments).some(
    (name) => name === '__schema' || name === '__type',
  )
}

/**
 * Checks a parsed document against the cost limits above. Returns the first violation, or `null`
 * when the document is within budget. Pure and synchronous: no schema, no network, no I/O — it
 * runs before anything reaches a resolver, which is the point.
 */
export function checkQueryLimits(
  document: DocumentNode,
  options: { allowIntrospection: boolean },
): QueryLimitViolation | null {
  const fragments = fragmentsOf(document)

  for (const definition of document.definitions) {
    if (!options.allowIntrospection && usesIntrospection(definition, fragments)) {
      return {
        code: INTROSPECTION_DISABLED,
        message: 'Introspection is disabled',
      }
    }
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue

    const depth = depthOf(definition.selectionSet, fragments)
    if (depth > MAX_DEPTH) {
      return {
        code: QUERY_TOO_COMPLEX,
        message: `Query is too deep (${depth} levels, maximum ${MAX_DEPTH})`,
      }
    }

    const names = rootFieldNames(definition.selectionSet, fragments)
    if (names.length > MAX_ROOT_FIELDS) {
      return {
        code: QUERY_TOO_COMPLEX,
        message: `Query selects too many root fields (${names.length}, maximum ${MAX_ROOT_FIELDS})`,
      }
    }

    const counts = new Map<string, number>()
    for (const name of names) {
      if (!UPSTREAM_ROOT_FIELDS.has(name)) continue
      const next = (counts.get(name) ?? 0) + 1
      if (next > MAX_ALIASED_UPSTREAM_FIELDS) {
        return {
          code: QUERY_TOO_COMPLEX,
          message: `Query repeats the "${name}" field too many times (maximum ${MAX_ALIASED_UPSTREAM_FIELDS})`,
        }
      }
      counts.set(name, next)
    }
  }

  return null
}
