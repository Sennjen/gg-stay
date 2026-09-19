import type { TypedDocumentNode } from '@graphql-typed-document-node/core'
import type { OperationDefinitionNode } from 'graphql'
import { printDocument } from '~/utils/printDocument'
import { stableStringify } from '~/utils/stableStringify'

interface GraphQLResponse<TData> {
  data?: TData | null
  errors?: { message: string; extensions?: { code?: string } }[]
}

function operationName(document: TypedDocumentNode<unknown, never>): string {
  const operation = document.definitions.find(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === 'OperationDefinition',
  )
  return operation?.name?.value ?? 'anonymous'
}

/** The only place pages talk to the GraphQL BFF. */
export async function useGql<TData, TVars extends Record<string, unknown>>(
  document: TypedDocumentNode<TData, TVars>,
  variables: MaybeRefOrGetter<TVars>,
) {
  const name = operationName(document as TypedDocumentNode<unknown, never>)
  const key = computed(() => `gql:${name}:${stableStringify(toValue(variables))}`)

  const { data, error, status, refresh } = await useAsyncData(key, async () => {
    // Printed here rather than in setup: on a hydrated first load this handler never runs, so the
    // printer chunk stays off the critical path (see ~/utils/printDocument).
    const query = await printDocument(document as TypedDocumentNode<unknown, never>)
    const response = await $fetch<GraphQLResponse<TData>>('/api/graphql', {
      method: 'POST',
      body: { query, variables: toValue(variables) },
    })
    const code = response.errors?.[0]?.extensions?.code
    if (response.errors?.length) {
      throw createError({
        statusCode: code === 'NOT_FOUND' ? 404 : 502,
        statusMessage: code ?? 'UPSTREAM_ERROR',
        data: { code: code ?? 'UPSTREAM_ERROR' },
      })
    }
    return response.data ?? null
  })

  const errorCode = computed<string | null>(() => {
    if (!error.value) return null
    const payload = error.value.data as { code?: string } | undefined
    return payload?.code ?? error.value.statusMessage ?? 'UPSTREAM_ERROR'
  })

  return { data, errorCode, status, refresh: () => refresh() }
}
