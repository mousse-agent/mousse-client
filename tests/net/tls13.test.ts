// @vitest-environment node
import { createPrivateKey } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { b64url } from '../../src/net/bytes'
import { generateTransportKey, type TransportKey } from '../../src/net/cert'
import { StreamEndpoint } from '../../src/net/stream'
import { connectTls } from '../../src/net/tls13/client'
import { expandLabel } from '../../src/net/tls13/keySchedule'
import { p256 } from '@noble/curves/nist.js'

const LABEL = 'EXPORTER-mousse-net-enroll'

function pem(label: string, der: Uint8Array): string {
  const lines = Buffer.from(der).toString('base64').match(/.{1,64}/g)!.join('\n')
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`
}

function nodeKey(key: TransportKey) {
  const point = p256.getPublicKey(key.secretKey, false)
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64url(key.secretKey),
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33)),
    },
  }).export({ type: 'pkcs8', format: 'pem' })
}

const servers: tls.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

async function startServer(serverKey: TransportKey, onSocket: (socket: tls.TLSSocket) => void): Promise<number> {
  const server = tls.createServer(
    {
      key: nodeKey(serverKey),
      cert: pem('CERTIFICATE', serverKey.certificate),
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      requestCert: true,
      rejectUnauthorized: false,
    },
    onSocket,
  )
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as net.AddressInfo).port
}

function tcpStream(port: number): Promise<StreamEndpoint> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const endpoint = new StreamEndpoint(
      (bytes) => socket.write(bytes),
      () => socket.end(),
    )
    socket.on('data', (data) => endpoint.deliver(new Uint8Array(data)))
    socket.on('close', () => endpoint.end())
    socket.on('error', (error) => endpoint.end(error))
    socket.once('connect', () => resolve(endpoint))
    socket.once('error', reject)
  })
}

describe('TLS 1.3 client against node:tls', () => {
  it('derives HKDF-Expand-Label like RFC 8448', () => {
    // RFC 8448 simple 1-RTT: early secret -> derived.
    const early = Buffer.from('33ad0a1c607ec03b09e6cd9893680ce210adf300aa1f2660e1b22e10f170f92a', 'hex')
    const emptyHash = Buffer.from('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'hex')
    expect(Buffer.from(expandLabel(early, 'derived', emptyHash, 32)).toString('hex')).toBe(
      '6f2615a108c702c5678f54fc9dbab69716c076189c48250cebeac3576c3611ba',
    )
  })

  it('completes mutual TLS, matches the exporter, and moves data both ways', async () => {
    const serverKey = generateTransportKey()
    const clientKey = generateTransportKey()
    let serverResolve!: (value: { exporter: string; peerSpki: string; socket: tls.TLSSocket }) => void
    const serverSide = new Promise<{ exporter: string; peerSpki: string; socket: tls.TLSSocket }>(
      (resolve) => (serverResolve = resolve),
    )
    const port = await startServer(serverKey, (socket) => {
      const peer = socket.getPeerX509Certificate()!
      serverResolve({
        exporter: b64url(socket.exportKeyingMaterial(32, LABEL, Buffer.alloc(0))),
        peerSpki: b64url(peer.publicKey.export({ type: 'spki', format: 'der' })),
        socket,
      })
      socket.write('echo:')
      socket.on('data', (data) => socket.write(data))
    })

    const channel = await connectTls(await tcpStream(port), { transport: clientKey, expectedServerSpki: serverKey.spki })
    const server = await serverSide
    expect(server.socket.getProtocol()).toBe('TLSv1.3')
    expect(server.socket.getCipher().standardName).toBe('TLS_AES_128_GCM_SHA256')
    expect(server.peerSpki).toBe(b64url(clientKey.spki))
    expect(b64url(channel.exportKeyingMaterial(LABEL, 32))).toBe(server.exporter)
    expect(b64url(channel.peerSpki)).toBe(b64url(serverKey.spki))

    const received: Uint8Array[] = []
    let total = 0
    const big = new Uint8Array(100_000).map((_, i) => i & 0xff)
    const done = new Promise<void>((resolve) =>
      channel.listen({
        data: (bytes) => {
          received.push(bytes)
          total += bytes.length
          if (total >= big.length + 5) resolve()
        },
        close: () => {},
      }),
    )
    channel.write(big)
    await done
    const joined = Buffer.concat(received)
    expect(joined.subarray(0, 5).toString()).toBe('echo:')
    expect(total).toBe(big.length + 5)
    expect(Buffer.compare(joined.subarray(5), Buffer.from(big))).toBe(0)

    const closed = new Promise<void>((resolve) => server.socket.on('end', () => resolve()))
    channel.close()
    await closed
  })

  it('rejects a server whose key does not match the pin', async () => {
    const serverKey = generateTransportKey()
    const port = await startServer(serverKey, () => {})
    await expect(
      connectTls(await tcpStream(port), {
        transport: generateTransportKey(),
        expectedServerSpki: generateTransportKey().spki,
      }),
    ).rejects.toMatchObject({ code: 'peer_key_mismatch' })
  })

  it('times out when the server never answers', async () => {
    const server = net.createServer(() => {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    await expect(
      connectTls(await tcpStream(port), {
        transport: generateTransportKey(),
        expectedServerSpki: generateTransportKey().spki,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' })
    server.close()
  })
})
