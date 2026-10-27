/**
 * One lane turn: post a body, decide what the answer is, and hand back decoded
 * `data:` payloads.
 *
 * ## Why this module exists
 *
 * Four lanes already import the same three primitives (`readHead`, `sniffBody`,
 * `replayStream` — all exported from `src/http.js`), and then each re-writes the
 * same ~40-line orchestration around them:
 *
 * | lane | poster |
 * |---|---|
 * | `src/http.js` | `postStreamed` |
 * | `src/eac.js` | `postSealedStreamed` |
 * | `src/kilo.js` | `postKiloStreamed` |
 * | `src/aggregate.js` | `postAggregateStreamed` |
 *
 * The orchestration is identical in all four: post → abort check → retry-after
 * conversion → non-2xx classification → empty body check → sniff the head →
 * branch empty/sse/json → fold a JSON body → emit. Only the *transport* and the
 * *classifier* differ, so those are the two things this module takes as input.
 *
 * ## Why the interface stays small
 *
 * The seven transport differences between the lanes (entry shape, `redirect`,
 * `duplex`, hand-computed `content-length`, abort wiring, the Response shim,
 * pre-classification text transforms) all collapse into two parameters:
 * `transport` absorbs the first six, `classify` absorbs the last. Nothing else
 * about a lane reaches this surface.
 *
 * ## What is deliberately NOT here
 *
 * The HTML-front-proxy wording stays with each lane. Four lanes word that
 * sentence differently on purpose (the free lane explains WAF/body-size for a
 * long conversation, the aggregate lane names the provider), and unifying user
 * copy is a product decision, not a refactor. Only the *test* for it is shared.
 *
 * @module src/lane-turn
 */
import {
  classifyStreamFailure,
  isHtmlFrontProxyPage,
  readHead,
  readSse,
  replayStream,
  sniffBody,
  UpstreamError,
  CODE,
} from './http.js'

/** Bytes spent deciding what the body is; replayed in front of the stream. */
export const SNIFF_BYTES = 4096

/**
 * A lane's transport, normalised to the shape this module needs.
 *
 * `src/eac.js` already builds exactly this shape by hand
 * (`laneFetch`, its own Response subset over `node:http`), which is the
 * evidence that this is the right seam rather than a hypothetical one.
 *
 * @typedef {(url: string, init: {
 *   method: string,
 *   headers: Record<string, string>,
 *   body: string,
 *   signal?: AbortSignal,
 * }) => Promise<LaneResponse>} LaneTransport
 */

/**
 * The subset of a `Response` this module reads.
 *
 * Narrow on purpose: `src/eac.js` serves its own implementation, so anything
 * wider would force it to fake members nothing reads.
 *
 * @typedef {object} LaneResponse
 * @property {boolean} ok
 * @property {number} status
 * @property {{ get(name: string): string | null }} headers
 * @property {ReadableStream<Uint8Array> | null} body
 * @property {() => Promise<string>} text
 */

/**
 * Fold the whole body into text, continuing on the head's own decoder so a
 * character split across the sniff boundary still decodes.
 *
 * Hoisted from `src/http.js`'s private `readRemainder`, which was the only lane
 * that had it; the other three inlined the same loop.
 *
 * @param {{ text: string, done: boolean, reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder }} head
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
export async function readRemainder(head, signal) {
  let text = head.text
  try {
    if (!head.done) {
      while (true) {
        const row = await head.reader.read()
        if (row.done) break
        if (row.value !== undefined) text += head.decoder.decode(row.value, { stream: true })
      }
    }
  } catch (error) {
    await head.reader.cancel().catch(() => {})
    throw classifyStreamFailure(error, signal)
  }
  return text + head.decoder.decode()
}

/**
 * Convert a provider's `Retry-After` header to milliseconds.
 *
 * Named for the header, not for `aggregate.js`'s private `retryAfterMs(response)`,
 * which takes the whole Response — that lane keeps its own helper.
 *
 * @param {string | null | undefined} header
 * @returns {number | undefined}
 */
export function retryAfterHeaderMs(header) {
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1000) : undefined
}

/**
 * Drive one lane turn.
 *
 * @param {object} options
 * @param {LaneTransport} options.transport - resolves the lane's own transport
 * @param {string} options.url
 * @param {Record<string, string>} options.headers
 * @param {string} options.body - already serialised
 * @param {AbortSignal} [options.signal]
 * @param {(frame: string) => void} options.onData - one `data:` payload, in order
 * @param {(status: number, rawText: string, retryAt: number | undefined) => Error} options.classify
 *   Refusal classifier. Takes the **raw text**, not a parsed payload: `kilo`
 *   and `aggregate` classify the wire text (the latter after redaction), and
 *   `http.js` parses first — so the text is the only common input.
 * @param {(error: unknown) => Error} [options.describeTransportFailure]
 *   Wraps a thrown transport error. Each lane names itself in that sentence.
 * @param {(text: string) => string} [options.transformText]
 *   Applied to the folded body before `JSON.parse` and before `classify`.
 *   `aggregate` uses it to redact the provider's key.
 * @param {(payload: unknown) => void} [options.onJson]
 *   Called instead of `onData(JSON.stringify(payload))` when a lane's wire wants
 *   frames synthesised from one document (`aggregate`).
 * @param {(text: string, status: number) => Error} [options.describeHtmlPage]
 *   Builds the front-proxy error. Each lane keeps its own wording.
 * @param {number} [options.timeoutMs] - idle budget handed to the shared readers
 * @returns {Promise<{ status: number }>}
 */
export async function laneTurn({
  transport,
  url,
  headers,
  body,
  signal,
  onData,
  classify,
  describeTransportFailure,
  transformText,
  onJson,
  describeHtmlPage,
  timeoutMs,
}) {
  let response
  try {
    response = await transport(url, { method: 'POST', headers, body, signal })
  } catch (error) {
    if (signal?.aborted === true || error?.name === 'AbortError') {
      throw new UpstreamError('request aborted', CODE.aborted)
    }
    throw describeTransportFailure === undefined
      ? new UpstreamError(`model request failed: ${error?.message ?? error}`, CODE.transport)
      : describeTransportFailure(error)
  }

  const setRetry = retryAfterHeaderMs(response.headers.get('retry-after'))
  if (!response.ok) {
    const refusal = await response.text().catch(() => '')
    // The transform runs here too: a refusal body can echo the credential, and
    // `aggregate`'s classifier is what redacts it on the way into the message.
    throw classify(response.status, transformText === undefined ? refusal : transformText(refusal), setRetry)
  }
  if (response.body === null) throw new UpstreamError('model stream returned no body', CODE.empty)

  const head = await readHead(response.body, SNIFF_BYTES, { signal, timeoutMs })
  const shape = sniffBody(head.text)
  if (shape === 'empty') throw new UpstreamError('model stream returned no body', CODE.empty)
  if (shape === 'sse') {
    await readSse(replayStream(head), onData, signal, timeoutMs)
    return { status: response.status }
  }

  // A lane that answered a stream request with one JSON document.
  const rawText = head.done ? head.text : await readRemainder(head, signal)
  const text = transformText === undefined ? rawText : transformText(rawText)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    if (isHtmlFrontProxyPage(rawText) && describeHtmlPage !== undefined) {
      throw describeHtmlPage(rawText, response.status)
    }
    throw new UpstreamError(`unexpected non-stream response: ${text.slice(0, 200)}`, CODE.server, { status: response.status })
  }
  if (payload?.error !== undefined || payload?.type === 'error') {
    // Raw text, not the transformed copy: a lane's classifier may want to parse
    // it itself, and it is the classifier's job to redact before composing.
    throw classify(response.status, rawText, setRetry)
  }
  if (onJson !== undefined) onJson(payload)
  else onData(JSON.stringify(payload))
  return { status: response.status }
}