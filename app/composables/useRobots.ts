import { robotsFor } from '~/utils/seo'

/**
 * The robots rule for a page, as the deployment allows it: a preview deployment (Vercel's
 * `VERCEL_ENV=preview`, read at build time into `public.previewDeployment`) is never indexed.
 */
export function useRobots(): (rule: string) => string {
  const previewDeployment = Boolean(useRuntimeConfig().public.previewDeployment)
  return (rule) => robotsFor(rule, previewDeployment)
}
