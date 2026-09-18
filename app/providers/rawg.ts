import { defineProvider } from '@nuxt/image/runtime'
import { rawgImageUrl } from '../utils/rawgImage'

export default defineProvider({
  getImage: (src, { modifiers }) => ({
    url: rawgImageUrl(src, Number(modifiers?.width) || undefined),
  }),
})
