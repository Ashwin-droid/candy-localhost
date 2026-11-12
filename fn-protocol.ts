// Frame codec for the daemon <-> function socket (see FUNCTIONS_DESIGN.md, Transport).
// Header: u32 BE payload length, u8 type, u32 BE stream id. Stream 0 is control.

export const Frame = {
  HELLO: 1,
  HELLO_ACK: 2,
  REQ_HEAD: 3,
  REQ_BODY: 4,
  REQ_END: 5,
  RES_HEAD: 6,
  RES_BODY: 7,
  RES_END: 8,
  CANCEL: 9,
  ERR: 10,
  LOG: 11,
  BYE: 12,
  BYE_ACK: 13,
  DRAIN: 14,
  // Per-stream flow control (extension): "you may send me `bytes` more body
  // bytes on this stream". Used only when both sides announced a window
  // (HELLO.window / HELLO_ACK.window); older peers ignore unknown frames.
  WINDOW: 15,
} as const

export type FrameType = (typeof Frame)[keyof typeof Frame]

export const PROTOCOL_VERSION = 1
export const HEADER_SIZE = 9
export const MAX_FRAME_PAYLOAD = 1024 * 1024
// Body bytes each side may have in flight per stream before the reader grants more
export const INITIAL_WINDOW = 1024 * 1024

export interface DecodedFrame {
  type: number
  streamId: number
  payload: Uint8Array
}

// `window`: the sender does per-stream flow control and accepts this many body
// bytes per stream before it sends WINDOW grants
export interface HelloPayload { token: string; instance: string; version: number; window?: number }
export interface HelloAckPayload { hot: boolean; window?: number }
export interface WindowPayload { bytes: number }
export interface ReqHeadPayload { method: string; url: string; headers: [string, string][]; clientIp: string; requestId: string }
export interface ResHeadPayload { status: number; statusText: string; headers: [string, string][] }
export interface ErrPayload { message: string; stack?: string }
export interface LogPayload { level: "log" | "info" | "warn" | "error" | "debug"; text: string; ts: number }
export interface ByePayload { reason: string }

const EMPTY = new Uint8Array(0)
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeFrame(type: number, streamId: number, payload: Uint8Array = EMPTY): Uint8Array {
  if (payload.length > MAX_FRAME_PAYLOAD) throw new Error(`frame payload ${payload.length} exceeds ${MAX_FRAME_PAYLOAD} bytes`)
  if (!Number.isInteger(type) || type < 0 || type > 0xff) throw new Error(`bad frame type ${type}`)
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) throw new Error(`bad stream id ${streamId}`)
  const out = new Uint8Array(HEADER_SIZE + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, payload.length)
  view.setUint8(4, type)
  view.setUint32(5, streamId)
  out.set(payload, HEADER_SIZE)
  return out
}

export function encodeJsonFrame(type: number, streamId: number, obj: unknown): Uint8Array {
  return encodeFrame(type, streamId, encoder.encode(JSON.stringify(obj ?? {})))
}

export function decodeJson<T = any>(payload: Uint8Array): T {
  return JSON.parse(payload.length ? decoder.decode(payload) : "{}") as T
}

// Socket reads arrive split or coalesced at arbitrary points, so bytes are
// buffered until a whole frame is present.
export class FrameDecoder {
  private buf: Uint8Array = EMPTY
  private failed = false

  push(chunk: Uint8Array): DecodedFrame[] {
    if (this.failed) throw new Error("frame decoder is in a failed state")
    if (chunk.length) {
      if (this.buf.length === 0) {
        // Copy: the caller (a Bun socket) may reuse its read buffer
        this.buf = chunk.slice()
      } else {
        const merged = new Uint8Array(this.buf.length + chunk.length)
        merged.set(this.buf)
        merged.set(chunk, this.buf.length)
        this.buf = merged
      }
    }

    const frames: DecodedFrame[] = []
    let off = 0
    while (this.buf.length - off >= HEADER_SIZE) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset + off, HEADER_SIZE)
      const len = view.getUint32(0)
      // Checked at the header so a bogus length can't make us buffer 4 GiB
      if (len > MAX_FRAME_PAYLOAD) {
        this.failed = true
        this.buf = EMPTY
        throw new Error(`frame payload ${len} exceeds ${MAX_FRAME_PAYLOAD} bytes`)
      }
      if (this.buf.length - off < HEADER_SIZE + len) break
      const start = off + HEADER_SIZE
      frames.push({ type: view.getUint8(4), streamId: view.getUint32(5), payload: this.buf.slice(start, start + len) })
      off = start + len
    }
    if (off > 0) this.buf = off === this.buf.length ? EMPTY : this.buf.slice(off)
    return frames
  }

  get buffered(): number {
    return this.buf.length
  }
}
