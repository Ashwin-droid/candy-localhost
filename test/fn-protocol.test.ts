import { describe, expect, it } from "bun:test"
import {
  decodeJson, encodeFrame, encodeJsonFrame, Frame, FrameDecoder, HEADER_SIZE, MAX_FRAME_PAYLOAD, PROTOCOL_VERSION,
} from "../fn-protocol.ts"

const bytes = (...n: number[]) => new Uint8Array(n)

describe("fn frame codec", () => {
  it("encodes the 9-byte header big-endian", () => {
    const f = encodeFrame(Frame.REQ_BODY, 0x01020304, bytes(9, 8, 7))
    expect(f.length).toBe(HEADER_SIZE + 3)
    expect([...f]).toEqual([0, 0, 0, 3, 4, 1, 2, 3, 4, 9, 8, 7])
    expect([...encodeFrame(Frame.BYE_ACK, 0)]).toEqual([0, 0, 0, 0, 13, 0, 0, 0, 0])
    expect(PROTOCOL_VERSION).toBe(1)
  })

  it("round-trips binary and JSON frames", () => {
    const d = new FrameDecoder()
    const head = { method: "POST", url: "http://x.localhost/a?b=1", headers: [["a", "b"]], clientIp: "127.0.0.1", requestId: "r1" }
    const out = d.push(new Uint8Array([
      ...encodeJsonFrame(Frame.REQ_HEAD, 7, head),
      ...encodeFrame(Frame.REQ_BODY, 7, bytes(1, 2, 3)),
      ...encodeFrame(Frame.REQ_END, 7),
    ]))
    expect(out.map(f => [f.type, f.streamId])).toEqual([[Frame.REQ_HEAD, 7], [Frame.REQ_BODY, 7], [Frame.REQ_END, 7]])
    expect(decodeJson<typeof head>(out[0].payload)).toEqual(head)
    expect([...out[1].payload]).toEqual([1, 2, 3])
    expect(out[2].payload.length).toBe(0)
    expect(decodeJson<object>(out[2].payload)).toEqual({})
    expect(d.buffered).toBe(0)
  })

  it("reassembles frames split at every byte boundary", () => {
    const stream = new Uint8Array([
      ...encodeJsonFrame(Frame.HELLO, 0, { token: "t", instance: "i", version: 1 }),
      ...encodeFrame(Frame.RES_BODY, 3, new Uint8Array(300).fill(5)),
      ...encodeFrame(Frame.RES_END, 3),
    ])
    for (const step of [1, 2, 5, 9, 10, 64]) {
      const d = new FrameDecoder()
      const got = []
      for (let i = 0; i < stream.length; i += step) got.push(...d.push(stream.subarray(i, i + step)))
      expect(got.map(f => f.type)).toEqual([Frame.HELLO, Frame.RES_BODY, Frame.RES_END])
      expect(got[1].payload.length).toBe(300)
      expect(got[1].payload.every(b => b === 5)).toBe(true)
    }
  })

  it("copies payloads so a reused read buffer can't corrupt them", () => {
    const d = new FrameDecoder()
    const buf = encodeFrame(Frame.RES_BODY, 1, bytes(1, 2))
    const [f] = d.push(buf)
    buf.fill(0)
    expect([...f.payload]).toEqual([1, 2])
  })

  it("accepts the max payload and rejects anything bigger", () => {
    const max = new Uint8Array(MAX_FRAME_PAYLOAD)
    expect(new FrameDecoder().push(encodeFrame(Frame.RES_BODY, 1, max))[0].payload.length).toBe(MAX_FRAME_PAYLOAD)
    expect(() => encodeFrame(Frame.RES_BODY, 1, new Uint8Array(MAX_FRAME_PAYLOAD + 1))).toThrow()

    // A forged header is rejected as soon as it's seen, before buffering the body
    const d = new FrameDecoder()
    const hdr = new Uint8Array(HEADER_SIZE)
    new DataView(hdr.buffer).setUint32(0, MAX_FRAME_PAYLOAD + 1)
    hdr[4] = Frame.RES_BODY
    expect(() => d.push(hdr)).toThrow(/exceeds/)
    expect(() => d.push(bytes(1))).toThrow()
  })

  it("rejects bad types and stream ids", () => {
    expect(() => encodeFrame(256, 1)).toThrow()
    expect(() => encodeFrame(1, -1)).toThrow()
    expect(() => encodeFrame(1, 2 ** 32)).toThrow()
    expect(encodeFrame(1, 2 ** 32 - 1).length).toBe(HEADER_SIZE)
  })
})
