/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
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

export type Game = {
  ageRating?: Maybe<AgeRating>;
  cover?: Maybe<Image>;
  description?: Maybe<Scalars['String']['output']>;
  developers: Array<Taxonomy>;
  gameModes: Array<GameMode>;
  genres: Array<Taxonomy>;
  id: Scalars['ID']['output'];
  localisation?: Maybe<LocalisationInfo>;
  madeInUkraine: Scalars['Boolean']['output'];
  metacritic?: Maybe<Scalars['Int']['output']>;
  name: Scalars['String']['output'];
  platforms: Array<Taxonomy>;
  playtime?: Maybe<Scalars['Int']['output']>;
  publishers: Array<Taxonomy>;
  rating?: Maybe<Scalars['Float']['output']>;
  ratingsCount?: Maybe<Scalars['Int']['output']>;
  released?: Maybe<Scalars['String']['output']>;
  screenshots: Array<Image>;
  similar: Array<GameCard>;
  slug: Scalars['String']['output'];
  stores: Array<StoreOffer>;
  tags: Array<Taxonomy>;
  website?: Maybe<Scalars['String']['output']>;
};

export type GameCard = {
  cover?: Maybe<Image>;
  genres: Array<Taxonomy>;
  id: Scalars['ID']['output'];
  localisation?: Maybe<LocalisationInfo>;
  madeInUkraine: Scalars['Boolean']['output'];
  metacritic?: Maybe<Scalars['Int']['output']>;
  name: Scalars['String']['output'];
  platforms: Array<Taxonomy>;
  playtime?: Maybe<Scalars['Int']['output']>;
  price?: Maybe<PriceSummary>;
  rating?: Maybe<Scalars['Float']['output']>;
  released?: Maybe<Scalars['String']['output']>;
  slug: Scalars['String']['output'];
};

export type GameFilter = {
  ageRating?: InputMaybe<Array<AgeRating>>;
  developers?: InputMaybe<Array<Scalars['String']['input']>>;
  free?: InputMaybe<Scalars['Boolean']['input']>;
  gameModes?: InputMaybe<Array<GameMode>>;
  genres?: InputMaybe<Array<Scalars['String']['input']>>;
  madeInUkraine?: InputMaybe<Scalars['Boolean']['input']>;
  metacriticMin?: InputMaybe<Scalars['Int']['input']>;
  onSaleMinPercent?: InputMaybe<Scalars['Int']['input']>;
  platforms?: InputMaybe<Array<Scalars['Int']['input']>>;
  playtime?: InputMaybe<Playtime>;
  /** Index-backed fields: accepted and ignored until the nightly index exists. */
  priceMaxUah?: InputMaybe<Scalars['Int']['input']>;
  publishers?: InputMaybe<Array<Scalars['String']['input']>>;
  ratingMin?: InputMaybe<Scalars['Float']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  stores?: InputMaybe<Array<Scalars['String']['input']>>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
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

export type Localisation =
  | 'ANY'
  | 'AUDIO'
  | 'INTERFACE'
  | 'SUBTITLES';

export type LocalisationInfo = {
  audio: Scalars['Boolean']['output'];
  interface: Scalars['Boolean']['output'];
  source: Scalars['String']['output'];
  subtitles: Scalars['Boolean']['output'];
};

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
