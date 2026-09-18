import { describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent, ref } from 'vue'
import type { TypedDocumentNode } from '@graphql-typed-document-node/core'
import { readBody } from 'h3'
import { useGql } from '~/composables/useGql'

interface EchoVars {
  value: string
}
interface EchoData {
  echo: string
}

// A minimal, valid document: enough for `print()` and operation-name lookup.
const EchoDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'Echo' },
      variableDefinitions: [],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [{ kind: 'Field', name: { kind: 'Name', value: 'echo' } }],
      },
    },
  ],
} as unknown as TypedDocumentNode<EchoData, EchoVars>

/**
 * Proves the `useAsyncData` key form used in `useGql` (a `computed` key) is
 * reactive: changing the variables must trigger a new fetch and must not
 * serve the previous key's cached result as the new one.
 */
describe('useGql', () => {
  it('refetches and does not reuse stale data when variables change', async () => {
    const calls: EchoVars[] = []
    registerEndpoint('/api/graphql', {
      method: 'POST',
      handler: async (event) => {
        const body = (await readBody(event)) as { variables: EchoVars }
        calls.push(body.variables)
        return { data: { echo: `echo:${body.variables.value}` } }
      },
    })

    const variables = ref<EchoVars>({ value: 'a' })
    const TestComponent = defineComponent({
      async setup() {
        const { data } = await useGql(EchoDocument, variables)
        return { data }
      },
      template: `<div>{{ data?.echo }}</div>`,
    })

    const wrapper = await mountSuspended(TestComponent)
    expect(wrapper.text()).toBe('echo:a')
    expect(calls).toEqual([{ value: 'a' }])

    variables.value = { value: 'b' }
    await new Promise((resolve) => setTimeout(resolve, 50))
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toBe('echo:b')
    expect(calls).toEqual([{ value: 'a' }, { value: 'b' }])
  })
})
