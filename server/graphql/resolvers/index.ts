import type { Resolvers } from '../__generated__/resolvers-types'
import { game } from './game'
import { localizedDescription } from './gameFields'
import { games } from './games'
import { landing } from './landing'
import { developers, genres, platforms } from './taxonomies'

export const resolvers: Resolvers = {
  Query: { games, game, genres, platforms, developers, landing },
  Game: { localizedDescription },
}
