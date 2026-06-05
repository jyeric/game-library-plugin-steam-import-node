export function parseKeyValues(text) {
  const tokens = tokenize(text);
  let index = 0;

  function next() {
    return tokens[index++];
  }

  function peek() {
    return tokens[index];
  }

  function parseObject() {
    const object = {};
    while (index < tokens.length) {
      const key = next();
      if (key === "}") {
        return object;
      }
      if (!key || key === "{") {
        throw new Error(`Invalid VDF token near index ${index - 1}.`);
      }
      if (peek() === "{") {
        next();
        object[key] = parseObject();
      } else {
        object[key] = next();
      }
    }
    return object;
  }

  const root = {};
  while (index < tokens.length) {
    const key = next();
    if (!key || key === "}" || key === "{") {
      throw new Error(`Invalid VDF root token near index ${index - 1}.`);
    }
    if (peek() === "{") {
      next();
      root[key] = parseObject();
    } else {
      root[key] = next();
    }
  }
  return root;
}

function tokenize(text) {
  const tokens = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (char === "{" || char === "}") {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (char === "\"") {
      const [value, nextIndex] = readQuotedString(text, index + 1);
      tokens.push(value);
      index = nextIndex;
      continue;
    }
    throw new Error(`Unexpected VDF character ${JSON.stringify(char)} at ${index}.`);
  }

  return tokens;
}

function readQuotedString(text, start) {
  let value = "";
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      const next = text[index + 1];
      if (next === "\"" || next === "\\") {
        value += next;
        index += 2;
        continue;
      }
    }
    if (char === "\"") {
      return [value, index + 1];
    }
    value += char;
    index += 1;
  }
  throw new Error("Unterminated VDF quoted string.");
}

export function findCaseInsensitive(object, key) {
  const entry = Object.entries(object).find(([name]) => name.toLowerCase() === key.toLowerCase());
  return entry?.[1];
}

