// vue-i18n ships a Germanic pluralisation rule by default (zero | singular | plural), which does
// not match Ukrainian's one/few/many system. Without this, "2 оцінки" and "5 оцінок" would both
// fall back to the same plural form as "оцінок".
function ukrainianPluralRule(choice: number, choicesLength: number): number {
  if (choicesLength < 3) return choice === 1 ? 0 : 1
  const mod10 = choice % 10
  const mod100 = choice % 100
  if (mod10 === 1 && mod100 !== 11) return 0
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1
  return 2
}

export default defineI18nConfig(() => ({
  pluralRules: {
    uk: ukrainianPluralRule,
  },
}))
