/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import type { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';
export type AgeRating =
  | 'PEGI3'
  | 'PEGI7'
  | 'PEGI12'
  | 'PEGI16'
  | 'PEGI18';

export type ClipSource =
  | 'RAWG'
  | 'STEAM';

export type DescriptionSource =
  | 'RAWG'
  | 'STEAM';

export type GameFilter = {
  ageRating?: Array<AgeRating> | null | undefined;
  developers?: Array<string> | null | undefined;
  /** Index-backed field: accepted and ignored until the nightly index exists. */
  free?: boolean | null | undefined;
  gameModes?: Array<GameMode> | null | undefined;
  genres?: Array<string> | null | undefined;
  /** Index-backed field: accepted and ignored until the nightly index exists. */
  madeInUkraine?: boolean | null | undefined;
  metacriticMin?: number | null | undefined;
  /** Index-backed field: accepted and ignored until the nightly index exists. */
  onSaleMinPercent?: number | null | undefined;
  platforms?: Array<number> | null | undefined;
  playtime?: Playtime | null | undefined;
  /** Index-backed field: accepted and ignored until the nightly index exists. */
  priceMaxUah?: number | null | undefined;
  publishers?: Array<string> | null | undefined;
  ratingMin?: number | null | undefined;
  search?: string | null | undefined;
  stores?: Array<string> | null | undefined;
  tags?: Array<string> | null | undefined;
  /** Index-backed field: accepted and ignored until the nightly index exists. */
  ukrainianLocalisation?: Localisation | null | undefined;
  upcoming?: boolean | null | undefined;
  yearFrom?: number | null | undefined;
  yearTo?: number | null | undefined;
};

export type GameMode =
  | 'LOCAL_COOP'
  | 'MULTIPLAYER'
  | 'ONLINE_COOP'
  | 'SINGLE';

export type GameSort =
  | 'DISCOUNT_DESC'
  | 'METACRITIC_DESC'
  | 'NAME_ASC'
  | 'POPULARITY_DESC'
  | 'PRICE_ASC'
  | 'PRICE_DESC'
  | 'RATING_DESC'
  | 'RELEASED_ASC'
  | 'RELEASED_DESC';

/** Steam reports supported languages and full audio only, so localisation has two levels. */
export type Localisation =
  | 'ANY'
  | 'AUDIO'
  | 'TEXT';

export type PlatformFamily =
  | 'MOBILE'
  | 'NINTENDO'
  | 'OTHER'
  | 'PC'
  | 'PLAYSTATION'
  | 'XBOX';

export type Playtime =
  | 'LONG'
  | 'MEDIUM'
  | 'SHORT';

export type GameQueryVariables = Exact<{
  slug: string;
  locale: string;
}>;


export type GameQuery = { game: { id: string, slug: string, name: string, released: string | null, rating: number | null, ratingsCount: number | null, metacritic: number | null, playtime: number | null, ageRating: AgeRating | null, gameModes: Array<GameMode>, website: string | null, platformFamilies: Array<PlatformFamily>, localizedDescription: { text: string, language: string, source: DescriptionSource } | null, cover: { url: string } | null, screenshots: Array<{ url: string, width: number | null, height: number | null }>, platforms: Array<{ id: string, slug: string, name: string }>, genres: Array<{ id: string, slug: string, name: string }>, developers: Array<{ id: string, slug: string, name: string }>, publishers: Array<{ id: string, slug: string, name: string }>, stores: Array<{ store: string, url: string, priceUah: number | null, regularPriceUah: number | null, discountPercent: number | null, updatedAt: string | null }>, localisation: { text: boolean, audio: boolean, source: string } | null } | null };

export type GamesQueryVariables = Exact<{
  filter?: GameFilter | null | undefined;
  sort?: GameSort | null | undefined;
  page?: number | null | undefined;
  pageSize?: number | null | undefined;
}>;


export type GamesQuery = { games: { total: number, page: number, pageSize: number, items: Array<{ id: string, slug: string, name: string, released: string | null, metacritic: number | null, platformFamilies: Array<PlatformFamily>, cover: { url: string } | null, screenshots: Array<{ url: string }>, price: { bestUah: number, regularUah: number | null, discountPercent: number, isFree: boolean, updatedAt: string } | null, localisation: { text: boolean, audio: boolean, source: string } | null }> } };

export type RingGameCardFragment = { id: string, slug: string, name: string, cover: { url: string } | null };

export type RowGameCardFragment = { id: string, slug: string, name: string, released: string | null, metacritic: number | null, platformFamilies: Array<PlatformFamily>, cover: { url: string } | null, screenshots: Array<{ url: string }>, price: { bestUah: number, regularUah: number | null, discountPercent: number, isFree: boolean, updatedAt: string } | null, localisation: { text: boolean, audio: boolean, source: string } | null };

export type LandingQueryVariables = Exact<{ [key: string]: never; }>;


export type LandingQuery = { landing: { totalGames: number, featured: { clipUrl: string | null, clipSource: ClipSource | null, game: { slug: string, name: string, cover: { url: string } | null } } | null, carousel: Array<{ id: string, slug: string, name: string, cover: { url: string } | null }>, newReleases: Array<{ id: string, slug: string, name: string, released: string | null, metacritic: number | null, platformFamilies: Array<PlatformFamily>, cover: { url: string } | null, screenshots: Array<{ url: string }>, price: { bestUah: number, regularUah: number | null, discountPercent: number, isFree: boolean, updatedAt: string } | null, localisation: { text: boolean, audio: boolean, source: string } | null }>, topRated: Array<{ id: string, slug: string, name: string, released: string | null, metacritic: number | null, platformFamilies: Array<PlatformFamily>, cover: { url: string } | null, screenshots: Array<{ url: string }>, price: { bestUah: number, regularUah: number | null, discountPercent: number, isFree: boolean, updatedAt: string } | null, localisation: { text: boolean, audio: boolean, source: string } | null }> } };

export type CatalogTaxonomiesQueryVariables = Exact<{ [key: string]: never; }>;


export type CatalogTaxonomiesQuery = { genres: Array<{ id: string, slug: string, name: string }> };

export type DevelopersQueryVariables = Exact<{
  search: string;
}>;


export type DevelopersQuery = { developers: Array<{ id: string, slug: string, name: string }> };

export const RingGameCardFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RingGameCard"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"GameCard"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"cover"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]}}]} as unknown as DocumentNode<RingGameCardFragment, unknown>;
export const RowGameCardFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RowGameCard"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"GameCard"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"released"}},{"kind":"Field","name":{"kind":"Name","value":"metacritic"}},{"kind":"Field","name":{"kind":"Name","value":"cover"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"Field","name":{"kind":"Name","value":"screenshots"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"Field","name":{"kind":"Name","value":"platformFamilies"}},{"kind":"Field","name":{"kind":"Name","value":"price"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"bestUah"}},{"kind":"Field","name":{"kind":"Name","value":"regularUah"}},{"kind":"Field","name":{"kind":"Name","value":"discountPercent"}},{"kind":"Field","name":{"kind":"Name","value":"isFree"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"localisation"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"audio"}},{"kind":"Field","name":{"kind":"Name","value":"source"}}]}}]}}]} as unknown as DocumentNode<RowGameCardFragment, unknown>;
export const GameDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Game"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"slug"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"locale"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"game"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"slug"},"value":{"kind":"Variable","name":{"kind":"Name","value":"slug"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"localizedDescription"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"locale"},"value":{"kind":"Variable","name":{"kind":"Name","value":"locale"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"language"}},{"kind":"Field","name":{"kind":"Name","value":"source"}}]}},{"kind":"Field","name":{"kind":"Name","value":"released"}},{"kind":"Field","name":{"kind":"Name","value":"rating"}},{"kind":"Field","name":{"kind":"Name","value":"ratingsCount"}},{"kind":"Field","name":{"kind":"Name","value":"metacritic"}},{"kind":"Field","name":{"kind":"Name","value":"playtime"}},{"kind":"Field","name":{"kind":"Name","value":"ageRating"}},{"kind":"Field","name":{"kind":"Name","value":"gameModes"}},{"kind":"Field","name":{"kind":"Name","value":"website"}},{"kind":"Field","name":{"kind":"Name","value":"cover"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"Field","name":{"kind":"Name","value":"screenshots"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}}]}},{"kind":"Field","name":{"kind":"Name","value":"platformFamilies"}},{"kind":"Field","name":{"kind":"Name","value":"platforms"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"genres"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"developers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"publishers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}},{"kind":"Field","name":{"kind":"Name","value":"stores"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"store"}},{"kind":"Field","name":{"kind":"Name","value":"url"}},{"kind":"Field","name":{"kind":"Name","value":"priceUah"}},{"kind":"Field","name":{"kind":"Name","value":"regularPriceUah"}},{"kind":"Field","name":{"kind":"Name","value":"discountPercent"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"localisation"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"audio"}},{"kind":"Field","name":{"kind":"Name","value":"source"}}]}}]}}]}}]} as unknown as DocumentNode<GameQuery, GameQueryVariables>;
export const GamesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Games"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"filter"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"GameFilter"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"sort"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"GameSort"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"page"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"pageSize"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"games"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"filter"},"value":{"kind":"Variable","name":{"kind":"Name","value":"filter"}}},{"kind":"Argument","name":{"kind":"Name","value":"sort"},"value":{"kind":"Variable","name":{"kind":"Name","value":"sort"}}},{"kind":"Argument","name":{"kind":"Name","value":"page"},"value":{"kind":"Variable","name":{"kind":"Name","value":"page"}}},{"kind":"Argument","name":{"kind":"Name","value":"pageSize"},"value":{"kind":"Variable","name":{"kind":"Name","value":"pageSize"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"total"}},{"kind":"Field","name":{"kind":"Name","value":"page"}},{"kind":"Field","name":{"kind":"Name","value":"pageSize"}},{"kind":"Field","name":{"kind":"Name","value":"items"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"released"}},{"kind":"Field","name":{"kind":"Name","value":"metacritic"}},{"kind":"Field","name":{"kind":"Name","value":"cover"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"Field","name":{"kind":"Name","value":"screenshots"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"Field","name":{"kind":"Name","value":"platformFamilies"}},{"kind":"Field","name":{"kind":"Name","value":"price"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"bestUah"}},{"kind":"Field","name":{"kind":"Name","value":"regularUah"}},{"kind":"Field","name":{"kind":"Name","value":"discountPercent"}},{"kind":"Field","name":{"kind":"Name","value":"isFree"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"localisation"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"audio"}},{"kind":"Field","name":{"kind":"Name","value":"source"}}]}}]}}]}}]}}]} as unknown as DocumentNode<GamesQuery, GamesQueryVariables>;
export const LandingDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Landing"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"landing"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"featured"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"clipUrl"}},{"kind":"Field","name":{"kind":"Name","value":"clipSource"}},{"kind":"Field","name":{"kind":"Name","value":"game"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"slug"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"cover"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"carousel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"RingGameCard"}}]}},{"kind":"Field","name":{"kind":"Name","value":"newReleases"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"RowGameCard"}}]}},{"kind":"Field","name":{"kind":"Name","value":"topRated"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"RowGameCard"}}]}},{"kind":"Field","name":{"kind":"Name","value":"totalGames"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RingGameCard"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"GameCard"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"cover"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"url"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"RowGameCard"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"GameCard"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"released"}},{"kind":"Field","name":{"kind":"Name","value":"metacritic"}},{"kind":"Field","name":{"kind":"Name","value":"cover"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"Field","name":{"kind":"Name","value":"screenshots"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"url"}}]}},{"kind":"Field","name":{"kind":"Name","value":"platformFamilies"}},{"kind":"Field","name":{"kind":"Name","value":"price"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"bestUah"}},{"kind":"Field","name":{"kind":"Name","value":"regularUah"}},{"kind":"Field","name":{"kind":"Name","value":"discountPercent"}},{"kind":"Field","name":{"kind":"Name","value":"isFree"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"localisation"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"audio"}},{"kind":"Field","name":{"kind":"Name","value":"source"}}]}}]}}]} as unknown as DocumentNode<LandingQuery, LandingQueryVariables>;
export const CatalogTaxonomiesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"CatalogTaxonomies"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"genres"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]} as unknown as DocumentNode<CatalogTaxonomiesQuery, CatalogTaxonomiesQueryVariables>;
export const DevelopersDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Developers"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"search"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"developers"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"search"},"value":{"kind":"Variable","name":{"kind":"Name","value":"search"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]} as unknown as DocumentNode<DevelopersQuery, DevelopersQueryVariables>;