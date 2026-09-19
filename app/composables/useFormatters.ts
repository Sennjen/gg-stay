import { formatDate, formatDecimal, formatNumber } from '~/utils/format'

export function useFormatters() {
  const { localeProperties } = useI18n()
  const tag = computed(() => localeProperties.value.language ?? 'uk-UA')
  return {
    formatDate: (iso?: string | null) => formatDate(iso, tag.value),
    formatNumber: (value: number) => formatNumber(value, tag.value),
    formatDecimal: (value: number, fractionDigits = 1) =>
      formatDecimal(value, tag.value, fractionDigits),
  }
}
