/**
 * Loopback test ports that Node's `fetch` refuses to dial, and a listen() that
 * never picks one.
 *
 * Node's bundled undici rejects 82 "bad ports" before opening a socket — the
 * RFC 1700 list (7 = echo, 5060 = SIP, 6667 = IRC, …). That check lives inside
 * `fetch`, so `new Request('http://127.0.0.1:5060/')` is fine while the same
 * URL through fetch throws `TypeError: fetch failed [cause]: Error: bad port`.
 *
 * Test fixtures call `listen(0, '127.0.0.1')` and then fetch themselves. On
 * Linux the dynamic range starts at 32768, so no fixture can ever land on one of
 * these; on Windows it starts at **1024**, and the OS hands out ports
 * sequentially — measured: 400 consecutive `listen(0)` calls covered
 * 5044…5444, which contains 5060 and 5061. A single suite run usually misses
 * them; the full run (dozens of fixtures, ports marching upward) hits them
 * ~50% of the time, as an intermittent `eac-auth` failure whose stack
 * (`fetch failed` → `bad port`) says nothing about the fixture.
 *
 * So: pick a port, and if it is one of the refused ones, close and pick again.
 * Retries are cheap (the list has 19 entries above 1024 out of ~16K assignable)
 * and this keeps every `listen(0)` site identical to what it was before.
 */

/** Ports below 1024 need privileges to bind, so only these can ever be handed out. */
const REFUSED_ABOVE_PRIVILEGED = [
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]

/**
 * The refused list as the running Node actually defines it.
 *
 * Read from the bundled undici source rather than hardcoded, because the list
 * belongs to that dependency and a hand-copied one silently drifts. There is no
 * public API for it: undici's copy is not exposed through
 * `process.getBuiltinModule` (measured: `internal/deps/undici/undici` comes back
 * `undefined`), so `process.binding('natives')` is the only route. It is
 * DEP0111, and on Node 24 that warning is printed only under
 * `--pending-deprecation` (measured) — a test fixture is the right place to
 * take that risk over a hand-maintained list of 82 numbers.
 *
 * The literal above stays as a floor. When the internals cannot be read the
 * helper says so on stderr instead of silently narrowing to the literal: a
 * suite that later fails on `bad port` should be traceable to this line.
 */
function refusedFromNode() {
  try {
    const natives = process.binding('natives')
    const source = natives['internal/deps/undici/undici']
    if (typeof source !== 'string') {
      console.warn('loopback-port: this Node does not expose undici internals; falling back to the built-in list')
      return []
    }
    // Undici writes it as `var badPorts = (\n /** @type {const} */\n [ "1", … ];`,
    // so the initialiser is not a bare array literal — anchored on the name and the
    // first `];` instead of on `= [`, which matched nothing on Node 24.
    const table = source.match(/var badPorts[\s\S]*?\];/)
    if (table === null) {
      console.warn('loopback-port: the shape of undici\'s badPorts changed; falling back to the built-in list')
      return []
    }
    return [...table[0].matchAll(/"([0-9]+)"/g)].map(match => Number(match[1]))
  } catch (error) {
    console.warn(`loopback-port: could not read undici's badPorts (${error?.message ?? error}); falling back to the built-in list`)
    return []
  }
}

const REFUSED_PORTS = new Set([...REFUSED_ABOVE_PRIVILEGED, ...refusedFromNode()])

/** @param {number} port @returns {boolean} */
function isFetchRefusedPort(port) {
  return REFUSED_PORTS.has(port)
}

/**
 * `server.listen(0, host)` that skips ports `fetch` would refuse.
 *
 * @param {import('node:net').Server} server - an http, https or net server that is not listening yet.
 * @param {string} [host] - bind address; defaults to the loopback the fixtures use.
 * @param {number} [attempts] - how many ports to try before giving up.
 * @returns {Promise<number>} the bound port.
 */
export async function listenLoopback(server, host = '127.0.0.1', attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((resolve, reject) => {
      const onError = error => { server.off('error', onError); reject(error) }
      server.once('error', onError)
      server.listen(0, host, () => { server.off('error', onError); resolve() })
    })
    const port = server.address().port
    if (!isFetchRefusedPort(port)) return port
    // A refused port is open and usable by sockets; only fetch vetoes it. Close
    // before retrying so the next listen() is not a second bind on the same port.
    await new Promise(resolve => server.close(resolve))
  }
  throw new Error(`listenLoopback: ${attempts} ports in a row were ones fetch refuses; the fixture cannot reach itself`)
}
