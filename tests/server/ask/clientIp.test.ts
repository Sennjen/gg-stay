import { describe, expect, it } from 'vitest'
import { addressKey, clientAddressKey } from '../../../server/ask/clientIp'

/** The request headers as h3 hands them over: lower-case names, possibly missing. */
const headers =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    values[name]

describe('the client address on Vercel', () => {
  const onVercel = (values: Record<string, string>, socket = '10.0.0.1') =>
    clientAddressKey({ header: headers(values), socketAddress: socket, onVercel: true })

  it("takes Vercel's own header first", () => {
    expect(
      onVercel({
        'x-vercel-forwarded-for': '203.0.113.7',
        'x-real-ip': '198.51.100.2',
        'x-forwarded-for': '192.0.2.9',
      }),
    ).toBe('203.0.113.7')
  })

  it('ignores an x-forwarded-for the client sent when the Vercel header is present', () => {
    expect(
      onVercel({
        'x-forwarded-for': '1.2.3.4, 203.0.113.7',
        'x-vercel-forwarded-for': '203.0.113.7',
      }),
    ).toBe('203.0.113.7')
  })

  it('falls back to x-real-ip, then to the first hop of x-forwarded-for', () => {
    expect(onVercel({ 'x-real-ip': '198.51.100.2', 'x-forwarded-for': '192.0.2.9' })).toBe(
      '198.51.100.2',
    )
    expect(onVercel({ 'x-forwarded-for': '192.0.2.9, 10.0.0.2' })).toBe('192.0.2.9')
  })

  it('skips a header that is not an address', () => {
    expect(onVercel({ 'x-vercel-forwarded-for': 'garbage', 'x-real-ip': '198.51.100.2' })).toBe(
      '198.51.100.2',
    )
  })

  it('uses the socket address when no header names one', () => {
    expect(onVercel({})).toBe('10.0.0.1')
  })
})

describe('the client address elsewhere', () => {
  it('never trusts a forwarding header a client can set itself', () => {
    expect(
      clientAddressKey({
        header: headers({
          'x-vercel-forwarded-for': '203.0.113.7',
          'x-real-ip': '198.51.100.2',
          'x-forwarded-for': '192.0.2.9',
        }),
        socketAddress: '127.0.0.1',
        onVercel: false,
      }),
    ).toBe('127.0.0.1')
  })

  it('is "unknown" when there is no address at all', () => {
    expect(
      clientAddressKey({ header: headers({}), socketAddress: undefined, onVercel: false }),
    ).toBe('unknown')
  })
})

describe('addressKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    [' 203.0.113.7 ', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:abcd:12:1:2:3:4', '2001:db8:abcd:12::/64'],
    ['2001:db8:abcd:12::99', '2001:db8:abcd:12::/64'],
    ['2001:DB8:ABCD:0012:ffff::1', '2001:db8:abcd:12::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['not an address', null],
    ['', null],
  ])('keys %j as %j', (raw, expected) => {
    expect(addressKey(raw)).toBe(expected)
  })

  it('puts every address of one /64 in one bucket', () => {
    const keys = new Set(
      ['2001:db8:1:2::1', '2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2:dead:beef::'].map(
        addressKey,
      ),
    )
    expect(keys.size).toBe(1)
    expect(addressKey('2001:db8:1:3::1')).not.toBe(addressKey('2001:db8:1:2::1'))
  })
})
