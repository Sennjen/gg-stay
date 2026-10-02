/**
 * The RAWG tags that say what a game feels like or what kind of game it is: mood, setting and
 * sub-genre. `/api/ask` lets the model pick from these for words the catalog has no filter for
 * ("горор", "roguelike", "затишна"), and the index keeps one facet per tag (`f:tag:{slug}`).
 *
 * Chosen from the English tags RAWG puts on the indexed games — the corpus in
 * `tests/fixtures/index/similarCorpus.ts` lists them with RAWG's catalog counts, from `horror`
 * (~45 000 games) down to `noir` (~700) — keeping the ones that describe the game itself and
 * leaving out camera and technical tags (`first-person`, `ray-tracing`), store features and game
 * modes, and series or place tags that only name a franchise (`chernobyl`, `sherlock-holmes`). A
 * handful RAWG uses widely but the corpus does not carry (`roguelike`, `roguelite`,
 * `metroidvania`, `souls-like`, `cyberpunk`, `space`, `turn-based`) are added by name.
 *
 * Sorted, so every prompt and every plan that lists them is the same bytes.
 */
export const MOOD_TAGS = [
  'atmospheric',
  'choices-matter',
  'cinematic',
  'comedy',
  'crafting',
  'cute',
  'cyberpunk',
  'dark',
  'dark-fantasy',
  'detective',
  'difficult',
  'dystopian',
  'emotional',
  'exploration',
  'fantasy',
  'farming',
  'funny',
  'historical',
  'horror',
  'interactive-fiction',
  'life-sim',
  'lovecraftian',
  'medieval',
  'metroidvania',
  'multiple-endings',
  'mystery',
  'noir',
  'open-world',
  'pixel-graphics',
  'platformer',
  'post-apocalyptic',
  'psychological-horror',
  'puzzle',
  'relaxing',
  'retro',
  'roguelike',
  'roguelite',
  'sandbox',
  'sci-fi',
  'souls-like',
  'space',
  'stealth',
  'story-rich',
  'survival',
  'survival-horror',
  'tactical',
  'turn-based',
  'zombies',
] as const
export type MoodTag = (typeof MOOD_TAGS)[number]

const MOOD_TAG_SET: ReadonlySet<string> = new Set(MOOD_TAGS)

export function isMoodTag(slug: string): slug is MoodTag {
  return MOOD_TAG_SET.has(slug)
}
