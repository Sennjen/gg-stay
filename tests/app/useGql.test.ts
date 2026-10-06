import { describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent, ref, type Ref } from 'vue'
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

  /**
   * `request` is how a page asks its operation again without its own state moving — the game
   * page does, for an answer that came back partial (`useRetryWhilePartial`).
   */
  describe('asked again through `request`', () => {
    let round = 0
    let failing = false

    async function mountEcho(variables: Ref<EchoVars>) {
      round = 0
      failing = false
      registerEndpoint('/api/graphql', {
        method: 'POST',
        handler: async (event) => {
          const body = (await readBody(event)) as { variables: EchoVars }
          round += 1
          if (failing) {
            return {
              data: null,
              errors: [{ message: 'Upstream', extensions: { code: 'UPSTREAM_TIMEOUT' } }],
            }
          }
          return { data: { echo: `echo:${body.variables.value}:${round}` } }
        },
      })

      let query!: Awaited<ReturnType<typeof useGql<EchoData, EchoVars>>>
      const TestComponent = defineComponent({
        async setup() {
          query = await useGql(EchoDocument, variables)
          return { data: query.data, errorCode: query.errorCode }
        },
        template: `<div>{{ data?.echo }}|{{ errorCode }}</div>`,
      })
      const wrapper = await mountSuspended(TestComponent)
      return { wrapper, query }
    }

    it('answers with new data and leaves what the page shows alone', async () => {
      const { wrapper, query } = await mountEcho(ref({ value: 'a' }))
      expect(wrapper.text()).toBe('echo:a:1|')

      expect(await query.request()).toEqual({ echo: 'echo:a:2' })
      await wrapper.vm.$nextTick()
      expect(wrapper.text()).toBe('echo:a:1|')
      expect(query.status.value).toBe('success')
    })

    it('fails by rejecting, with the answer’s code, and shows the page no error', async () => {
      const { wrapper, query } = await mountEcho(ref({ value: 'a' }))
      failing = true

      await expect(query.request()).rejects.toMatchObject({
        statusCode: 502,
        data: { code: 'UPSTREAM_TIMEOUT' },
      })
      await wrapper.vm.$nextTick()
      expect(wrapper.text()).toBe('echo:a:1|')
      expect(query.errorCode.value).toBeNull()
    })

    it('asks for what the variables are now, under a key that names them', async () => {
      const variables = ref<EchoVars>({ value: 'a' })
      const { query } = await mountEcho(variables)
      const before = query.key.value
      expect(before).toContain('Echo')

      variables.value = { value: 'b' }
      expect(query.key.value).not.toBe(before)
      expect(await query.request()).toMatchObject({ echo: expect.stringMatching(/^echo:b:/) })
    })
  })
})
