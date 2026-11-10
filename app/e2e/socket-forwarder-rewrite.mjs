const lineEnding = Buffer.from("\r\n");
const headerEnding = Buffer.from("\r\n\r\n");

export class IrcTimeRewriter {
  #pending = Buffer.alloc(0);
  #rules;

  constructor(rules) {
    this.#rules = rules;
  }

  push(chunk) {
    if (this.#rules.length === 0) return chunk;
    const data = Buffer.concat([this.#pending, chunk]);
    const lines = [];
    let lineStart = 0;
    let lineEnd = data.indexOf(lineEnding, lineStart);
    while (lineEnd >= 0) {
      const nextLineStart = lineEnd + lineEnding.length;
      lines.push(
        rewriteLine(data.subarray(lineStart, nextLineStart), this.#rules),
      );
      lineStart = nextLineStart;
      lineEnd = data.indexOf(lineEnding, lineStart);
    }
    this.#pending = data.subarray(lineStart);
    return Buffer.concat(lines);
  }
}

export class WebSocketIrcTimeRewriter {
  #fragmentedFrames;
  #pending = Buffer.alloc(0);
  #rules;
  #upgraded = false;

  constructor(rules) {
    this.#rules = rules;
  }

  push(chunk) {
    const data = Buffer.concat([this.#pending, chunk]);
    const output = [];
    let offset = 0;

    if (!this.#upgraded) {
      const headerEnd = data.indexOf(headerEnding);
      if (headerEnd < 0) {
        this.#pending = data;
        return Buffer.alloc(0);
      }
      offset = headerEnd + headerEnding.length;
      output.push(data.subarray(0, offset));
      this.#upgraded = true;
    }

    while (offset < data.length) {
      const frameLength = completeFrameLength(data, offset);
      if (frameLength === undefined) break;
      const frame = data.subarray(offset, offset + frameLength);
      const rewritten = this.#rewriteOrBufferFrame(frame);
      if (rewritten.length > 0) output.push(rewritten);
      offset += frameLength;
    }

    this.#pending = data.subarray(offset);
    return Buffer.concat(output);
  }

  #rewriteOrBufferFrame(frame) {
    if (this.#rules.length === 0) return frame;
    const opcode = frame[0] & 0x0f;
    const final = (frame[0] & 0x80) !== 0;
    if (this.#fragmentedFrames === undefined) {
      if ((opcode === 1 || opcode === 2) && !final) {
        this.#fragmentedFrames = [frame];
        return Buffer.alloc(0);
      }
      return rewriteFrame(frame, this.#rules);
    }
    this.#fragmentedFrames.push(frame);
    if (opcode === 0 && final) {
      const frames = this.#fragmentedFrames;
      this.#fragmentedFrames = undefined;
      return rewriteFragmentedMessage(frames, this.#rules);
    }
    if (opcode === 8 || opcode === 1 || opcode === 2) {
      const frames = this.#fragmentedFrames;
      this.#fragmentedFrames = undefined;
      return Buffer.concat(frames);
    }
    return Buffer.alloc(0);
  }
}

function completeFrameLength(data, offset) {
  if (data.length - offset < 2) return undefined;
  const lengthCode = data[offset + 1] & 0x7f;
  let headerLength = 2;
  let payloadLength = lengthCode;
  if (lengthCode === 126) {
    if (data.length - offset < 4) return undefined;
    payloadLength = data.readUInt16BE(offset + 2);
    headerLength += 2;
  } else if (lengthCode === 127) {
    if (data.length - offset < 10) return undefined;
    const extendedLength = data.readBigUInt64BE(offset + 2);
    if (extendedLength > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    payloadLength = Number(extendedLength);
    headerLength += 8;
  }
  if ((data[offset + 1] & 0x80) !== 0) headerLength += 4;
  const frameLength = headerLength + payloadLength;
  return data.length - offset >= frameLength ? frameLength : undefined;
}

function rewriteFrame(frame, rules) {
  const opcode = frame[0] & 0x0f;
  if ((opcode !== 1 && opcode !== 2) || rules.length === 0) return frame;
  const payload = decodedPayload(frame);
  const rewritten = rewritePayload(payload, rules);
  if (rewritten === payload) return frame;
  return withPayload(frame, rewritten);
}

function rewriteFragmentedMessage(frames, rules) {
  const payloads = frames
    .filter((frame) => isDataFrame(frame))
    .map((frame) => decodedPayload(frame));
  const payload = Buffer.concat(payloads);
  const rewritten = rewritePayload(payload, rules);
  if (rewritten === payload) return Buffer.concat(frames);
  let offset = 0;
  return Buffer.concat(
    frames.map((frame) => {
      if (!isDataFrame(frame)) return frame;
      const length = decodedPayload(frame).length;
      const result = withPayload(
        frame,
        rewritten.subarray(offset, offset + length),
      );
      offset += length;
      return result;
    }),
  );
}

function isDataFrame(frame) {
  const opcode = frame[0] & 0x0f;
  return opcode === 0 || opcode === 1 || opcode === 2;
}

function decodedPayload(frame) {
  const { maskStart, masked, payloadStart } = payloadLayout(frame);
  const payload = Buffer.from(frame.subarray(payloadStart));
  if (masked) applyMask(payload, frame.subarray(maskStart, payloadStart));
  return payload;
}

function withPayload(frame, payload) {
  const { maskStart, masked, payloadStart } = payloadLayout(frame);
  const result = Buffer.from(frame);
  const encoded = Buffer.from(payload);
  if (masked) applyMask(encoded, frame.subarray(maskStart, payloadStart));
  encoded.copy(result, payloadStart);
  return result;
}

function payloadLayout(frame) {
  const lengthCode = frame[1] & 0x7f;
  const extendedLengthBytes =
    lengthCode === 126 ? 2 : lengthCode === 127 ? 8 : 0;
  const masked = (frame[1] & 0x80) !== 0;
  const maskStart = 2 + extendedLengthBytes;
  return {
    maskStart,
    masked,
    payloadStart: maskStart + (masked ? 4 : 0),
  };
}

function rewritePayload(payload, rules) {
  const lines = [];
  let lineStart = 0;
  let lineEnd = payload.indexOf(lineEnding, lineStart);
  while (lineEnd >= 0) {
    const nextLineStart = lineEnd + lineEnding.length;
    lines.push(rewriteLine(payload.subarray(lineStart, nextLineStart), rules));
    lineStart = nextLineStart;
    lineEnd = payload.indexOf(lineEnding, lineStart);
  }
  if (lineStart < payload.length)
    lines.push(rewriteLine(payload.subarray(lineStart), rules));
  const rewritten = Buffer.concat(lines);
  return rewritten.equals(payload) ? payload : rewritten;
}

function applyMask(payload, mask) {
  for (let index = 0; index < payload.length; index += 1)
    payload[index] ^= mask[index % 4];
}

function rewriteLine(line, rules) {
  let rewritten = line;
  for (let ruleIndex = rules.length - 1; ruleIndex >= 0; ruleIndex -= 1) {
    const rule = rules[ruleIndex];
    const match = line.indexOf(Buffer.from(rule.contains));
    if (match < 0) continue;
    const timeTagStart = line.lastIndexOf("time=", match);
    if (timeTagStart < 0) continue;
    const timeStart = timeTagStart + 5;
    const timeEnd = findTagEnd(line, timeStart);
    const replacement = withTimestampPrecision(rule.time, timeEnd - timeStart);
    if (replacement === undefined) continue;
    if (rewritten === line) rewritten = Buffer.from(line);
    Buffer.from(replacement).copy(rewritten, timeStart);
  }
  return rewritten;
}

function withTimestampPrecision(time, length) {
  if (length === time.length) return time;
  const fractionalDigits = length - 21;
  if (fractionalDigits < 0) return undefined;
  const milliseconds = time.slice(20, 23);
  return `${time.slice(0, 19)}.${milliseconds.padEnd(fractionalDigits, "0").slice(0, fractionalDigits)}Z`;
}

function findTagEnd(data, start) {
  let index = start;
  while (index < data.length && ![32, 59, 13, 10].includes(data[index]))
    index += 1;
  return index;
}
