import type { Resolvers } from '../__generated__/resolvers-types'
import { game } from './game'
import { games } from './games'
import { developers, genres, platforms } from './taxonomies'

export const resolvers: Resolvers = {
  Query: { games, game, genres, platforms, developers },
}
