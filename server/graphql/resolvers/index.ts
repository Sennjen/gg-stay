import type { Resolvers } from '../__generated__/resolvers-types'
import { dealOfTheDay } from './dealOfTheDay'
import { game } from './game'
import { localizedDescription } from './gameFields'
import { games } from './games'
import { landing } from './landing'
import { similar } from './similar'
import { developers, genres, platforms } from './taxonomies'

export const resolvers: Resolvers = {
  Query: { games, game, genres, platforms, developers, landing, dealOfTheDay },
  Game: { localizedDescription, similar },
}
