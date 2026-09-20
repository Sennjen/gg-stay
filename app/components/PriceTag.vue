<script setup lang="ts">
/** The subset of `PriceSummary` this component reads — kept structural so both the card's and the
 * game page's generated GraphQL types satisfy it without an explicit cast. */
export interface PriceTagPrice {
  bestUah: number
  regularUah?: number | null
  discountPercent: number
  isFree: boolean
}

const props = defineProps<{ price: PriceTagPrice | null }>()
const { t } = useI18n()
const { formatUah } = useFormatters()

// A discount is only rendered as "new price / old price" when there is an old price to show — a
// discount percentage with no regular price falls back to a plain price rather than a chip with
// nothing to strike through.
const onSale = computed(
  () =>
    !!props.price &&
    !props.price.isFree &&
    props.price.discountPercent > 0 &&
    props.price.regularUah != null,
)
</script>

<template>
  <p v-if="price" data-test="price" class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
    <span v-if="price.isFree" class="font-medium text-fg">{{ t('price.free') }}</span>
    <template v-else-if="onSale">
      <span
        class="font-numeric inline-flex items-center rounded-chip bg-sale px-1.5 py-0.5 text-xs font-semibold text-on-sale"
      >
        −{{ price.discountPercent }}%
      </span>
      <span class="font-numeric font-medium text-fg">{{ formatUah(price.bestUah) }}</span>
      <span class="sr-only">{{ t('price.was') }}</span>
      <s class="font-numeric text-fg-2">{{ formatUah(price.regularUah!) }}</s>
    </template>
    <span v-else class="font-numeric text-fg">{{ formatUah(price.bestUah) }}</span>
  </p>
</template>
