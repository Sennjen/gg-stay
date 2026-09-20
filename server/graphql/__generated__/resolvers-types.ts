import type { GraphQLResolveInfo } from 'graphql';
import type { GraphQLContext } from '../context';
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type RequireFields<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
};

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

export type FeaturedGame = {
  clipSource?: Maybe<ClipSource>;
  clipUrl?: Maybe<Scalars['String']['output']>;
  game: GameCard;
};

export type Game = {
  ageRating?: Maybe<AgeRating>;
  cover?: Maybe<Image>;
  description?: Maybe<Scalars['String']['output']>;
  developers: Array<Taxonomy>;
  gameModes: Array<GameMode>;
  genres: Array<Taxonomy>;
  id: Scalars['ID']['output'];
  localisation?: Maybe<LocalisationInfo>;
  localizedDescription?: Maybe<LocalizedText>;
  madeInUkraine: Scalars['Boolean']['output'];
  metacritic?: Maybe<Scalars['Int']['output']>;
  name: Scalars['String']['output'];
  platformFamilies: Array<PlatformFamily>;
  platforms: Array<Taxonomy>;
  playtime?: Maybe<Scalars['Int']['output']>;
  publishers: Array<Taxonomy>;
  rating?: Maybe<Scalars['Float']['output']>;
  ratingsCount?: Maybe<Scalars['Int']['output']>;
  released?: Maybe<Scalars['String']['output']>;
  screenshots: Array<Image>;
  /** Index-backed field: always empty until the week 2 nightly index computes similarity. */
  similar: Array<GameCard>;
  slug: Scalars['String']['output'];
  stores: Array<StoreOffer>;
  tags: Array<Taxonomy>;
  website?: Maybe<Scalars['String']['output']>;
};


export type GameLocalizedDescriptionArgs = {
  locale: Scalars['String']['input'];
};

export type GameCard = {
  cover?: Maybe<Image>;
  genres: Array<Taxonomy>;
  id: Scalars['ID']['output'];
  localisation?: Maybe<LocalisationInfo>;
  madeInUkraine: Scalars['Boolean']['output'];
  metacritic?: Maybe<Scalars['Int']['output']>;
  name: Scalars['String']['output'];
  platformFamilies: Array<PlatformFamily>;
  platforms: Array<Taxonomy>;
  playtime?: Maybe<Scalars['Int']['output']>;
  price?: Maybe<PriceSummary>;
  rating?: Maybe<Scalars['Float']['output']>;
  released?: Maybe<Scalars['String']['output']>;
  screenshots: Array<Image>;
  slug: Scalars['String']['output'];
};

export type GameFilter = {
  ageRating?: InputMaybe<Array<AgeRating>>;
  developers?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Index-backed field: accepted and ignored until the nightly index exists. */
  free?: InputMaybe<Scalars['Boolean']['input']>;
  gameModes?: InputMaybe<Array<GameMode>>;
  genres?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Index-backed field: accepted and ignored until the nightly index exists. */
  madeInUkraine?: InputMaybe<Scalars['Boolean']['input']>;
  metacriticMin?: InputMaybe<Scalars['Int']['input']>;
  /** Index-backed field: accepted and ignored until the nightly index exists. */
  onSaleMinPercent?: InputMaybe<Scalars['Int']['input']>;
  platforms?: InputMaybe<Array<Scalars['Int']['input']>>;
  playtime?: InputMaybe<Playtime>;
  /** Index-backed field: accepted and ignored until the nightly index exists. */
  priceMaxUah?: InputMaybe<Scalars['Int']['input']>;
  publishers?: InputMaybe<Array<Scalars['String']['input']>>;
  ratingMin?: InputMaybe<Scalars['Float']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  stores?: InputMaybe<Array<Scalars['String']['input']>>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Index-backed field: accepted and ignored until the nightly index exists. */
  ukrainianLocalisation?: InputMaybe<Localisation>;
  upcoming?: InputMaybe<Scalars['Boolean']['input']>;
  yearFrom?: InputMaybe<Scalars['Int']['input']>;
  yearTo?: InputMaybe<Scalars['Int']['input']>;
};

export type GameMode =
  | 'LOCAL_COOP'
  | 'MULTIPLAYER'
  | 'ONLINE_COOP'
  | 'SINGLE';

export type GamePage = {
  hasNext: Scalars['Boolean']['output'];
  /** The index has not been refreshed for too long, so prices are withheld. */
  indexStale: Scalars['Boolean']['output'];
  /** ISO timestamp of the last index publication, when there is one. */
  indexUpdatedAt?: Maybe<Scalars['String']['output']>;
  indexedOnly: Scalars['Boolean']['output'];
  items: Array<GameCard>;
  page: Scalars['Int']['output'];
  pageSize: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
};

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

export type Image = {
  height?: Maybe<Scalars['Int']['output']>;
  url: Scalars['String']['output'];
  width?: Maybe<Scalars['Int']['output']>;
};

export type Landing = {
  carousel: Array<GameCard>;
  featured?: Maybe<FeaturedGame>;
  newReleases: Array<GameCard>;
  topRated: Array<GameCard>;
  totalGames: Scalars['Int']['output'];
};

/** Steam reports supported languages and full audio only, so localisation has two levels. */
export type Localisation =
  | 'ANY'
  | 'AUDIO'
  | 'TEXT';

export type LocalisationInfo = {
  /** The game is voiced in Ukrainian. */
  audio: Scalars['Boolean']['output'];
  source: Scalars['String']['output'];
  /** The interface or the subtitles are available in Ukrainian. */
  text: Scalars['Boolean']['output'];
};

export type LocalizedText = {
  language: Scalars['String']['output'];
  source: DescriptionSource;
  text: Scalars['String']['output'];
};

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

export type PriceSummary = {
  bestStore: Scalars['String']['output'];
  bestUah: Scalars['Int']['output'];
  discountPercent: Scalars['Int']['output'];
  isFree: Scalars['Boolean']['output'];
  updatedAt: Scalars['String']['output'];
};

export type Query = {
  developers: Array<Taxonomy>;
  game?: Maybe<Game>;
  games: GamePage;
  genres: Array<Taxonomy>;
  landing: Landing;
  platforms: Array<Taxonomy>;
};


export type QueryDevelopersArgs = {
  search: Scalars['String']['input'];
};


export type QueryGameArgs = {
  slug: Scalars['String']['input'];
};


export type QueryGamesArgs = {
  filter?: InputMaybe<GameFilter>;
  page?: InputMaybe<Scalars['Int']['input']>;
  pageSize?: InputMaybe<Scalars['Int']['input']>;
  sort?: InputMaybe<GameSort>;
};

export type StoreOffer = {
  discountPercent?: Maybe<Scalars['Int']['output']>;
  priceUah?: Maybe<Scalars['Int']['output']>;
  regularPriceUah?: Maybe<Scalars['Int']['output']>;
  store: Scalars['String']['output'];
  updatedAt?: Maybe<Scalars['String']['output']>;
  url: Scalars['String']['output'];
};

export type Taxonomy = {
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  slug: Scalars['String']['output'];
};



export type ResolverTypeWrapper<T> = Promise<T> | T;


export type ResolverWithResolve<TResult, TParent, TContext, TArgs> = {
  resolve: ResolverFn<TResult, TParent, TContext, TArgs>;
};
export type Resolver<TResult, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> = ResolverFn<TResult, TParent, TContext, TArgs> | ResolverWithResolve<TResult, TParent, TContext, TArgs>;

export type ResolverFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => Promise<TResult> | TResult;

export type SubscriptionSubscribeFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => AsyncIterable<TResult> | Promise<AsyncIterable<TResult>>;

export type SubscriptionResolveFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;

export interface SubscriptionSubscriberObject<TResult, TKey extends string, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<{ [key in TKey]: TResult }, TParent, TContext, TArgs>;
  resolve?: SubscriptionResolveFn<TResult, { [key in TKey]: TResult }, TContext, TArgs>;
}

export interface SubscriptionResolverObject<TResult, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<any, TParent, TContext, TArgs>;
  resolve: SubscriptionResolveFn<TResult, any, TContext, TArgs>;
}

export type SubscriptionObject<TResult, TKey extends string, TParent, TContext, TArgs> =
  | SubscriptionSubscriberObject<TResult, TKey, TParent, TContext, TArgs>
  | SubscriptionResolverObject<TResult, TParent, TContext, TArgs>;

export type SubscriptionResolver<TResult, TKey extends string, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> =
  | ((...args: any[]) => SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>)
  | SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>;

export type TypeResolveFn<TTypes, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (
  parent: TParent,
  context: TContext,
  info: GraphQLResolveInfo
) => Maybe<TTypes> | Promise<Maybe<TTypes>>;

export type IsTypeOfResolverFn<T = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>> = (obj: T, context: TContext, info: GraphQLResolveInfo) => boolean | Promise<boolean>;

export type NextResolverFn<T> = () => Promise<T>;

export type DirectiveResolverFn<TResult = Record<PropertyKey, never>, TParent = Record<PropertyKey, never>, TContext = Record<PropertyKey, never>, TArgs = Record<PropertyKey, never>> = (
  next: NextResolverFn<TResult>,
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;





/** Mapping between all available schema types and the resolvers types */
export type ResolversTypes = {
  AgeRating: AgeRating;
  Boolean: ResolverTypeWrapper<Scalars['Boolean']['output']>;
  ClipSource: ClipSource;
  DescriptionSource: DescriptionSource;
  FeaturedGame: ResolverTypeWrapper<FeaturedGame>;
  Float: ResolverTypeWrapper<Scalars['Float']['output']>;
  Game: ResolverTypeWrapper<Game>;
  GameCard: ResolverTypeWrapper<GameCard>;
  GameFilter: GameFilter;
  GameMode: GameMode;
  GamePage: ResolverTypeWrapper<GamePage>;
  GameSort: GameSort;
  ID: ResolverTypeWrapper<Scalars['ID']['output']>;
  Image: ResolverTypeWrapper<Image>;
  Int: ResolverTypeWrapper<Scalars['Int']['output']>;
  Landing: ResolverTypeWrapper<Landing>;
  Localisation: Localisation;
  LocalisationInfo: ResolverTypeWrapper<LocalisationInfo>;
  LocalizedText: ResolverTypeWrapper<LocalizedText>;
  PlatformFamily: PlatformFamily;
  Playtime: Playtime;
  PriceSummary: ResolverTypeWrapper<PriceSummary>;
  Query: ResolverTypeWrapper<Record<PropertyKey, never>>;
  StoreOffer: ResolverTypeWrapper<StoreOffer>;
  String: ResolverTypeWrapper<Scalars['String']['output']>;
  Taxonomy: ResolverTypeWrapper<Taxonomy>;
};

/** Mapping between all available schema types and the resolvers parents */
export type ResolversParentTypes = {
  Boolean: Scalars['Boolean']['output'];
  FeaturedGame: FeaturedGame;
  Float: Scalars['Float']['output'];
  Game: Game;
  GameCard: GameCard;
  GameFilter: GameFilter;
  GamePage: GamePage;
  ID: Scalars['ID']['output'];
  Image: Image;
  Int: Scalars['Int']['output'];
  Landing: Landing;
  LocalisationInfo: LocalisationInfo;
  LocalizedText: LocalizedText;
  PriceSummary: PriceSummary;
  Query: Record<PropertyKey, never>;
  StoreOffer: StoreOffer;
  String: Scalars['String']['output'];
  Taxonomy: Taxonomy;
};

export type FeaturedGameResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['FeaturedGame'] = ResolversParentTypes['FeaturedGame']> = {
  clipSource?: Resolver<Maybe<ResolversTypes['ClipSource']>, ParentType, ContextType>;
  clipUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  game?: Resolver<ResolversTypes['GameCard'], ParentType, ContextType>;
};

export type GameResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Game'] = ResolversParentTypes['Game']> = {
  ageRating?: Resolver<Maybe<ResolversTypes['AgeRating']>, ParentType, ContextType>;
  cover?: Resolver<Maybe<ResolversTypes['Image']>, ParentType, ContextType>;
  description?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  developers?: Resolver<Array<ResolversTypes['Taxonomy']>, ParentType, ContextType>;
  gameModes?: Resolver<Array<ResolversTypes['GameMode']>, ParentType, ContextType>;
  genres?: Resolver<Array<ResolversTypes['Taxonomy']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  localisation?: Resolver<Maybe<ResolversTypes['LocalisationInfo']>, ParentType, ContextType>;
  localizedDescription?: Resolver<Maybe<ResolversTypes['LocalizedText']>, ParentType, ContextType, RequireFields<GameLocalizedDescriptionArgs, 'locale'>>;
  madeInUkraine?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  metacritic?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  platformFamilies?: Resolver<Array<ResolversTypes['PlatformFamily']>, ParentType, ContextType>;
  platforms?: Resolver<Array<ResolversTypes['Taxonomy']>, ParentType, ContextType>;
  playtime?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  publishers?: Resolver<Array<ResolversTypes['Taxonomy']>, ParentType, ContextType>;
  rating?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  ratingsCount?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  released?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  screenshots?: Resolver<Array<ResolversTypes['Image']>, ParentType, ContextType>;
  similar?: Resolver<Array<ResolversTypes['GameCard']>, ParentType, ContextType>;
  slug?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  stores?: Resolver<Array<ResolversTypes['StoreOffer']>, ParentType, ContextType>;
  tags?: Resolver<Array<ResolversTypes['Taxonomy']>, ParentType, ContextType>;
  website?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
};

export type GameCardResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GameCard'] = ResolversParentTypes['GameCard']> = {
  cover?: Resolver<Maybe<ResolversTypes['Image']>, ParentType, ContextType>;
  genres?: Resolver<Array<ResolversTypes['Taxonomy']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  localisation?: Resolver<Maybe<ResolversTypes['LocalisationInfo']>, ParentType, ContextType>;
  madeInUkraine?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  metacritic?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  platformFamilies?: Resolver<Array<ResolversTypes['PlatformFamily']>, ParentType, ContextType>;
  platforms?: Resolver<Array<ResolversTypes['Taxonomy']>, ParentType, ContextType>;
  playtime?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  price?: Resolver<Maybe<ResolversTypes['PriceSummary']>, ParentType, ContextType>;
  rating?: Resolver<Maybe<ResolversTypes['Float']>, ParentType, ContextType>;
  released?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  screenshots?: Resolver<Array<ResolversTypes['Image']>, ParentType, ContextType>;
  slug?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type GamePageResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['GamePage'] = ResolversParentTypes['GamePage']> = {
  hasNext?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  indexStale?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  indexUpdatedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  indexedOnly?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  items?: Resolver<Array<ResolversTypes['GameCard']>, ParentType, ContextType>;
  page?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  pageSize?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  total?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
};

export type ImageResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Image'] = ResolversParentTypes['Image']> = {
  height?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  url?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  width?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
};

export type LandingResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Landing'] = ResolversParentTypes['Landing']> = {
  carousel?: Resolver<Array<ResolversTypes['GameCard']>, ParentType, ContextType>;
  featured?: Resolver<Maybe<ResolversTypes['FeaturedGame']>, ParentType, ContextType>;
  newReleases?: Resolver<Array<ResolversTypes['GameCard']>, ParentType, ContextType>;
  topRated?: Resolver<Array<ResolversTypes['GameCard']>, ParentType, ContextType>;
  totalGames?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
};

export type LocalisationInfoResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['LocalisationInfo'] = ResolversParentTypes['LocalisationInfo']> = {
  audio?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  source?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  text?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
};

export type LocalizedTextResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['LocalizedText'] = ResolversParentTypes['LocalizedText']> = {
  language?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  source?: Resolver<ResolversTypes['DescriptionSource'], ParentType, ContextType>;
  text?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type PriceSummaryResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['PriceSummary'] = ResolversParentTypes['PriceSummary']> = {
  bestStore?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  bestUah?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  discountPercent?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  isFree?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  updatedAt?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type QueryResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Query'] = ResolversParentTypes['Query']> = {
  developers?: Resolver<Array<ResolversTypes['Taxonomy']>, ParentType, ContextType, RequireFields<QueryDevelopersArgs, 'search'>>;
  game?: Resolver<Maybe<ResolversTypes['Game']>, ParentType, ContextType, RequireFields<QueryGameArgs, 'slug'>>;
  games?: Resolver<ResolversTypes['GamePage'], ParentType, ContextType, RequireFields<QueryGamesArgs, 'page' | 'pageSize' | 'sort'>>;
  genres?: Resolver<Array<ResolversTypes['Taxonomy']>, ParentType, ContextType>;
  landing?: Resolver<ResolversTypes['Landing'], ParentType, ContextType>;
  platforms?: Resolver<Array<ResolversTypes['Taxonomy']>, ParentType, ContextType>;
};

export type StoreOfferResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['StoreOffer'] = ResolversParentTypes['StoreOffer']> = {
  discountPercent?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  priceUah?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  regularPriceUah?: Resolver<Maybe<ResolversTypes['Int']>, ParentType, ContextType>;
  store?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  updatedAt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  url?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type TaxonomyResolvers<ContextType = GraphQLContext, ParentType extends ResolversParentTypes['Taxonomy'] = ResolversParentTypes['Taxonomy']> = {
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  slug?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type Resolvers<ContextType = GraphQLContext> = {
  FeaturedGame?: FeaturedGameResolvers<ContextType>;
  Game?: GameResolvers<ContextType>;
  GameCard?: GameCardResolvers<ContextType>;
  GamePage?: GamePageResolvers<ContextType>;
  Image?: ImageResolvers<ContextType>;
  Landing?: LandingResolvers<ContextType>;
  LocalisationInfo?: LocalisationInfoResolvers<ContextType>;
  LocalizedText?: LocalizedTextResolvers<ContextType>;
  PriceSummary?: PriceSummaryResolvers<ContextType>;
  Query?: QueryResolvers<ContextType>;
  StoreOffer?: StoreOfferResolvers<ContextType>;
  Taxonomy?: TaxonomyResolvers<ContextType>;
};

