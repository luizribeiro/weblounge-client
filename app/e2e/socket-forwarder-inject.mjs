export function injectedIrcFrame(line, opcode = 0x81) {
  const payload = Buffer.from(line.replace(/[\r\n]+$/u, ""));
  if (payload.length < 126)
    return Buffer.concat([Buffer.from([opcode, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  throw new RangeError("injected IRC line is too long");
}
