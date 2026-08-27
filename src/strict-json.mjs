export function parseStrictJson(text, label = 'JSON input') {
  if (typeof text !== 'string') throw new Error(`${label} must be text`);
  let offset = 0;

  function fail(message) {
    throw new Error(`${label} ${message} at character offset ${offset}`);
  }

  function whitespace() {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[offset])) offset += 1;
  }

  function string() {
    const start = offset;
    if (text[offset] !== '"') fail('contains an invalid string');
    offset += 1;
    let closed = false;
    while (offset < text.length) {
      const character = text[offset];
      if (character === '"') {
        offset += 1;
        closed = true;
        break;
      }
      if (character === '\\') {
        offset += 2;
      } else {
        offset += 1;
      }
    }
    if (!closed) fail('contains an unterminated string');
    let value;
    try {
      value = JSON.parse(text.slice(start, offset));
    } catch (error) {
      throw new Error(`${label} is not valid JSON: ${error.message}`);
    }
    if (!value.isWellFormed()) throw new Error(`${label} contains an unpaired UTF-16 value instead of Unicode scalar values`);
    return value;
  }

  function value() {
    whitespace();
    const character = text[offset];
    if (character === '{') return object();
    if (character === '[') return array();
    if (character === '"') {
      string();
      return;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    const number = text.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (number !== undefined) {
      offset += number.length;
      return;
    }
    fail('is not valid JSON');
  }

  function object() {
    offset += 1;
    whitespace();
    const members = new Set();
    if (text[offset] === '}') {
      offset += 1;
      return;
    }
    for (;;) {
      whitespace();
      const member = string();
      if (members.has(member)) throw new Error(`${label} contains duplicate object member '${member}'`);
      members.add(member);
      whitespace();
      if (text[offset] !== ':') fail('is missing an object member colon');
      offset += 1;
      value();
      whitespace();
      if (text[offset] === '}') {
        offset += 1;
        return;
      }
      if (text[offset] !== ',') fail('is missing an object member comma');
      offset += 1;
    }
  }

  function array() {
    offset += 1;
    whitespace();
    if (text[offset] === ']') {
      offset += 1;
      return;
    }
    for (;;) {
      value();
      whitespace();
      if (text[offset] === ']') {
        offset += 1;
        return;
      }
      if (text[offset] !== ',') fail('is missing an array item comma');
      offset += 1;
    }
  }

  value();
  whitespace();
  if (offset !== text.length) fail('contains trailing content');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}
