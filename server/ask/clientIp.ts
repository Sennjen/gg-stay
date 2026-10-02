import { isIP } from 'node:net'

/**
 * Which client a request to `/api/ask` is charged to.
 *
 * On Vercel the platform names the client itself: `x-vercel-forwarded-for` first, then
 * `x-real-ip`, then the first hop of `x-forwarded-for` (which Vercel overwrites with the client's
 * address). Anywhere else every one of those headers is whatever the client chose to send, so
 * only the socket's own address counts — behind another proxy that means every client shares the
 * proxy's bucket, which is the safe way round.
 *
 * The key is the address for IPv4 and the /64 prefix for IPv6: one subscriber is normally given a
 * whole /64, and keying by the full address would hand them 2^64 fresh buckets — and let them push
 * everyone else's out of the bounded maps.
 */

export interface ClientAddressSource {
  header: (name: string) => string | undefined
  socketAddress: string | undefined
  onVercel: boolean
}

const VERCEL_HEADERS = ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for'] as const

export function clientAddressKey(source: ClientAddressSource): string {
  if (source.onVercel) {
    for (const name of VERCEL_HEADERS) {
      const firstHop = source.header(name)?.split(',')[0]
      const key = firstHop === undefined ? null : addressKey(firstHop)
      if (key) return key
    }
  }
  return (source.socketAddress && addressKey(source.socketAddress)) || 'unknown'
}

/** The bucket key of one address, or `null` when it is not an IP address. */
export function addressKey(raw: string): string | null {
  const address = raw.trim().replace(/%.*$/, '')
  const version = isIP(address)
  if (version === 4) return address
  if (version !== 6) return null
  const groups = hextets(address)
  // An IPv4 address written as IPv6 (`::ffff:a.b.c.d`) is that IPv4 address.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const high = groups[6]!
    const low = groups[7]!
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`
}

/** The eight 16-bit groups of a valid IPv6 address, `::` and a dotted IPv4 tail expanded. */
function hextets(address: string): number[] {
  let text = address
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', tail] = text.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  return groups.map((group) => parseInt(group, 16))
}
