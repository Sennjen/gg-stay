import { Kind } from 'graphql'
import type { DocumentNode, FragmentDefinitionNode, SelectionSetNode } from 'graphql'

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

// THE ANALYSIS ITSELF MUST BE CHEAPER THAN THE QUERY IT REJECTS. A limiter that walks a document
// naively is a better denial-of-service than the one it blocks: a chain of N fragments that each
// spread the next one twice expands to 2^N paths, so a 700-byte document could pin the single Node
// thread for ~170 ms (and, one fragment further along, overflow the stack into an HTTP 500 —
// exactly the shape this plugin promises never to return). Three things keep the cost linear:
//
//  1. Nothing is parsed until the raw text is under `MAX_QUERY_BYTES` and the document holds at
//     most `MAX_FRAGMENTS` fragments. Both are checked before any structural work.
//  2. Every fragment's contribution is computed ONCE and memoised by name, in dependency order,
//     so a fragment referenced from a thousand places is still walked once.
//  3. Every walk is iterative with an explicit stack and saturating counters, so no document —
//     however nested — can overflow the call stack or make a counter grow without bound.
//
// The result is O(size of the document), with no path through it that allocates more than the
// document itself.

/** Longest raw query text accepted, in UTF-8 bytes. The app's largest document is under 1 KB. */
export const MAX_QUERY_BYTES = 8_192
/** Most fragment definitions accepted in one document. The app ships two. */
export const MAX_FRAGMENTS = 64
/**
 * Deepest run of nested brackets accepted in the RAW TEXT, before parsing.
 *
 * graphql-js's parser is recursive descent, so a document nested deeply enough overflows the call
 * stack inside `parse()` itself — as a `RangeError`, not a syntax error, and well within a byte
 * budget that leaves room for roughly 2 700 levels of `f{f{f{…}}}`. That is a crash in a dependency
 * before any of this module's own analysis gets to run, so the only place to stop it is on the
 * string. 50 is two orders of magnitude below where the parser is in danger and an order of
 * magnitude above anything this app writes: its deepest document nests 5 levels, and
 * `queryLimits.test.ts` checks every shipped `.graphql` file against this scanner.
 */
export const MAX_NESTING_DEPTH = 50

/** Root fields whose resolvers each reach an upstream API. */
const UPSTREAM_ROOT_FIELDS = new Set(['game', 'games', 'landing'])
const INTROSPECTION_FIELDS = new Set(['__schema', '__type'])

export const QUERY_TOO_COMPLEX = 'QUERY_TOO_COMPLEX'
export const INTROSPECTION_DISABLED = 'INTROSPECTION_DISABLED'

export interface QueryLimitViolation {
  code: typeof QUERY_TOO_COMPLEX | typeof INTROSPECTION_DISABLED
  message: string
}

/**
 * What one selection set contributes when it sits at the root of an operation, plus how deep it
 * goes. Counters saturate one past their limit: the exact value stops mattering once a limit is
 * broken, and a saturating counter cannot be driven to a large number by a small document.
 */
interface Cost {
  /** Root-level fields contributed, saturating at `MAX_ROOT_FIELDS + 1`. */
  rootFields: number
  /** Occurrences per upstream root field, each saturating at `MAX_ALIASED_UPSTREAM_FIELDS + 1`. */
  upstream: Map<string, number>
  /** Whether `__schema` or `__type` appears at root level. */
  introspection: boolean
  /** Deepest field nesting below this selection set, saturating at `MAX_DEPTH + 1`. */
  depth: number
}

const ROOT_FIELD_CEILING = MAX_ROOT_FIELDS + 1
const UPSTREAM_CEILING = MAX_ALIASED_UPSTREAM_FIELDS + 1
const DEPTH_CEILING = MAX_DEPTH + 1

const emptyCost = (): Cost => ({
  rootFields: 0,
  upstream: new Map(),
  introspection: false,
  depth: 0,
})

function addUpstream(into: Map<string, number>, name: string, times: number) {
  into.set(name, Math.min((into.get(name) ?? 0) + times, UPSTREAM_CEILING))
}

function fragmentsOf(document: DocumentNode): Map<string, FragmentDefinitionNode> {
  const map = new Map<string, FragmentDefinitionNode>()
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) map.set(definition.name.value, definition)
  }
  return map
}

/** Every fragment name spread anywhere inside `selectionSet`, found without recursion. */
function spreadNames(selectionSet: SelectionSetNode): string[] {
  const names: string[] = []
  const stack: SelectionSetNode[] = [selectionSet]
  while (stack.length > 0) {
    const set = stack.pop()!
    for (const selection of set.selections) {
      if (selection.kind === Kind.FRAGMENT_SPREAD) names.push(selection.name.value)
      else if (selection.selectionSet) stack.push(selection.selectionSet)
    }
  }
  return names
}

/**
 * The cost of one selection set, with every fragment spread answered from `memo`. Iterative: the
 * stack holds (selection set, depth below the operation root, whether we are still at root level).
 */
function costOf(selectionSet: SelectionSetNode, memo: Map<string, Cost>): Cost {
  const cost = emptyCost()
  const stack: { set: SelectionSetNode; base: number; atRoot: boolean }[] = [
    { set: selectionSet, base: 0, atRoot: true },
  ]

  while (stack.length > 0) {
    const { set, base, atRoot } = stack.pop()!
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        const name = selection.name.value
        if (atRoot) {
          cost.rootFields = Math.min(cost.rootFields + 1, ROOT_FIELD_CEILING)
          if (UPSTREAM_ROOT_FIELDS.has(name)) addUpstream(cost.upstream, name, 1)
          if (INTROSPECTION_FIELDS.has(name)) cost.introspection = true
        }
        const here = Math.min(base + 1, DEPTH_CEILING)
        if (here > cost.depth) cost.depth = here
        // Past the depth ceiling the exact figure stops mattering, so stop descending.
        if (selection.selectionSet && here < DEPTH_CEILING) {
          stack.push({ set: selection.selectionSet, base: here, atRoot: false })
        }
        continue
      }

      if (selection.kind === Kind.INLINE_FRAGMENT) {
        // An inline fragment is a type condition, not a level: its fields sit where it does.
        stack.push({ set: selection.selectionSet, base, atRoot })
        continue
      }

      // A fragment spread: one map lookup, however many times it is spread.
      const fragment = memo.get(selection.name.value)
      if (!fragment) continue
      const here = Math.min(base + fragment.depth, DEPTH_CEILING)
      if (here > cost.depth) cost.depth = here
      if (!atRoot) continue
      cost.rootFields = Math.min(cost.rootFields + fragment.rootFields, ROOT_FIELD_CEILING)
      for (const [name, count] of fragment.upstream) addUpstream(cost.upstream, name, count)
      cost.introspection ||= fragment.introspection
    }
  }

  return cost
}

/**
 * Costs every fragment exactly once, in dependency order, with an explicit stack.
 *
 * A fragment that takes part in a cycle is costed as empty: a cyclic document is invalid GraphQL
 * and yoga's own validation rejects it a moment later, so the only job here is not to loop.
 */
function costFragments(fragments: Map<string, FragmentDefinitionNode>): Map<string, Cost> {
  const memo = new Map<string, Cost>()
  const visiting = new Set<string>()
  const deps = new Map<string, string[]>()

  for (const [name, fragment] of fragments) {
    deps.set(name, spreadNames(fragment.selectionSet))
  }

  for (const root of fragments.keys()) {
    if (memo.has(root)) continue
    // `expanded` marks the second visit to a frame: its dependencies are costed by then.
    const stack: { name: string; expanded: boolean }[] = [{ name: root, expanded: false }]
    while (stack.length > 0) {
      const frame = stack.pop()!
      if (memo.has(frame.name)) continue

      if (frame.expanded) {
        visiting.delete(frame.name)
        const fragment = fragments.get(frame.name)
        memo.set(frame.name, fragment ? costOf(fragment.selectionSet, memo) : emptyCost())
        continue
      }

      visiting.add(frame.name)
      stack.push({ name: frame.name, expanded: true })
      for (const dependency of deps.get(frame.name) ?? []) {
        // Already costed, or part of a cycle we are inside: either way, nothing to push.
        if (memo.has(dependency) || visiting.has(dependency) || !fragments.has(dependency)) continue
        stack.push({ name: dependency, expanded: false })
      }
    }
    // A fragment left in `visiting` was reached only through a cycle; cost it as empty.
    for (const name of visiting) if (!memo.has(name)) memo.set(name, emptyCost())
    visiting.clear()
  }

  return memo
}

function utf8ByteLength(value: string): number {
  return typeof Buffer === 'undefined'
    ? new TextEncoder().encode(value).length
    : Buffer.byteLength(value, 'utf8')
}

/**
 * Rejects a raw query that is too long to be worth parsing. Called before `parse()`, so an
 * oversized body never reaches the parser at all.
 *
 * The cap is on UTF-8 BYTES, which is what a request actually costs to receive — measuring
 * `String.length` would let a body padded with three-byte characters carry ~24 KB under an 8 KB
 * cap. A UTF-8 encoding is never shorter than the string's UTF-16 code-unit count, so anything
 * longer than the cap is already over it and is rejected without being encoded; only a string
 * already known to be short is measured exactly, which is where a multi-byte character can still
 * tip it over.
 */
export function checkQueryLength(query: string): QueryLimitViolation | null {
  const bytes = query.length > MAX_QUERY_BYTES ? query.length : utf8ByteLength(query)
  if (bytes <= MAX_QUERY_BYTES) return null
  return {
    code: QUERY_TOO_COMPLEX,
    message: `Query is too long (over ${MAX_QUERY_BYTES} bytes)`,
  }
}

/**
 * Rejects a raw query whose brackets nest deeper than the parser is safe with. One linear pass over
 * the string, before `parse()`.
 *
 * It is a real GraphQL lexer for the three constructs where a bracket is not a bracket — `#`
 * comments, `"…"` strings and `"""…"""` block strings — because a conservative scanner that
 * counted them would reject legitimate queries: a search term is user input and may hold any
 * number of braces. `{}`, `()` and `[]` share one counter: what matters is the parser's recursion,
 * and every one of them recurses.
 */
export function checkNestingDepth(query: string): QueryLimitViolation | null {
  let depth = 0
  let index = 0

  while (index < query.length) {
    const char = query[index]

    if (char === '#') {
      // A comment runs to the end of the line; nothing in it is syntax.
      while (index < query.length && query[index] !== '\n' && query[index] !== '\r') index++
      continue
    }

    if (char === '"') {
      if (query.startsWith('"""', index)) {
        // Block string: ends at the next unescaped `"""` (the only escape inside one is `\\"""`).
        index += 3
        while (index < query.length) {
          if (query[index] === '\\' && query.startsWith('"""', index + 1)) {
            index += 4
            continue
          }
          if (query.startsWith('"""', index)) {
            index += 3
            break
          }
          index++
        }
        continue
      }
      index++
      while (index < query.length && query[index] !== '"') {
        // A backslash escapes the next character, including a closing quote.
        index += query[index] === '\\' ? 2 : 1
      }
      index++
      continue
    }

    if (char === '{' || char === '(' || char === '[') {
      depth++
      if (depth > MAX_NESTING_DEPTH) {
        return {
          code: QUERY_TOO_COMPLEX,
          message: `Query is nested too deeply (maximum ${MAX_NESTING_DEPTH} levels)`,
        }
      }
    } else if (char === '}' || char === ')' || char === ']') {
      // Never below zero: an unbalanced document is a syntax error for the parser to report.
      if (depth > 0) depth--
    }
    index++
  }

  return null
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
  if (fragments.size > MAX_FRAGMENTS) {
    return {
      code: QUERY_TOO_COMPLEX,
      message: `Query defines too many fragments (${fragments.size}, maximum ${MAX_FRAGMENTS})`,
    }
  }

  const memo = costFragments(fragments)

  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue
    const cost = costOf(definition.selectionSet, memo)

    if (!options.allowIntrospection && cost.introspection) {
      return { code: INTROSPECTION_DISABLED, message: 'Introspection is disabled' }
    }
    if (cost.depth > MAX_DEPTH) {
      return {
        code: QUERY_TOO_COMPLEX,
        message: `Query is too deep (maximum ${MAX_DEPTH} levels)`,
      }
    }
    if (cost.rootFields > MAX_ROOT_FIELDS) {
      return {
        code: QUERY_TOO_COMPLEX,
        message: `Query selects too many root fields (maximum ${MAX_ROOT_FIELDS})`,
      }
    }
    for (const [name, count] of cost.upstream) {
      if (count > MAX_ALIASED_UPSTREAM_FIELDS) {
        return {
          code: QUERY_TOO_COMPLEX,
          message: `Query repeats the "${name}" field too many times (maximum ${MAX_ALIASED_UPSTREAM_FIELDS})`,
        }
      }
    }
  }

  return null
}
