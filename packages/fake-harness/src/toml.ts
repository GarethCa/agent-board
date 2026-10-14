/**
 * Parses one TOML value, as Codex reads the value of a `-c key=value` override: strings (basic and literal),
 * integers, booleans, arrays and inline tables (with bare, quoted and dotted keys). No floats, dates or multi-line
 * strings: no override the board passes uses them. Throws on anything else.
 */
export function parseTomlValue(text: string): unknown {
  const parser = new Parser(text);
  const value = parser.value();
  parser.end();
  return value;
}

class Parser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  value(): unknown {
    this.space();
    const char = this.text[this.pos];
    if (char === '"') return this.basicString();
    if (char === "'") return this.literalString();
    if (char === '[') return this.array();
    if (char === '{') return this.table();
    const word = /^(true|false|[+-]?\d[\d_]*)/.exec(this.text.slice(this.pos))?.[0];
    if (word === undefined) throw this.error('a value');
    this.pos += word.length;
    return word === 'true' ? true : word === 'false' ? false : Number(word.replaceAll('_', ''));
  }

  end(): void {
    this.space();
    if (this.pos !== this.text.length) throw this.error('the end');
  }

  private array(): unknown[] {
    this.pos++;
    const items: unknown[] = [];
    for (;;) {
      this.space();
      if (this.eat(']')) return items;
      items.push(this.value());
      this.space();
      if (this.eat(']')) return items;
      if (!this.eat(',')) throw this.error("',' or ']'");
    }
  }

  private table(): Record<string, unknown> {
    this.pos++;
    const table: Record<string, unknown> = {};
    this.space();
    if (this.eat('}')) return table;
    for (;;) {
      const path = this.key();
      this.space();
      if (!this.eat('=')) throw this.error("'='");
      let target = table;
      for (const part of path.slice(0, -1)) target = (target[part] ??= {}) as Record<string, unknown>;
      target[path.at(-1)!] = this.value();
      this.space();
      if (this.eat('}')) return table;
      if (!this.eat(',')) throw this.error("',' or '}'");
    }
  }

  /** A dotted key: `a`, `"a b"`, `a.b`. */
  private key(): string[] {
    const parts: string[] = [];
    do {
      this.space();
      const char = this.text[this.pos];
      if (char === '"') parts.push(this.basicString());
      else if (char === "'") parts.push(this.literalString());
      else {
        const bare = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.pos))?.[0];
        if (bare === undefined) throw this.error('a key');
        this.pos += bare.length;
        parts.push(bare);
      }
      this.space();
    } while (this.eat('.'));
    return parts;
  }

  private basicString(): string {
    this.pos++;
    let out = '';
    for (;;) {
      const char = this.text[this.pos++];
      if (char === undefined) throw this.error('a closing "');
      if (char === '"') return out;
      if (char !== '\\') {
        out += char;
        continue;
      }
      const escape = this.text[this.pos++];
      const simple: Record<string, string> = { '"': '"', '\\': '\\', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
      if (escape !== undefined && escape in simple) {
        out += simple[escape];
      } else if (escape === 'u' || escape === 'U') {
        const length = escape === 'u' ? 4 : 8;
        const hex = this.text.slice(this.pos, this.pos + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) throw this.error('a unicode escape');
        out += String.fromCodePoint(parseInt(hex, 16));
        this.pos += length;
      } else {
        throw this.error('a valid escape');
      }
    }
  }

  private literalString(): string {
    const close = this.text.indexOf("'", this.pos + 1);
    if (close < 0) throw this.error("a closing '");
    const out = this.text.slice(this.pos + 1, close);
    this.pos = close + 1;
    return out;
  }

  private space(): void {
    while (this.text[this.pos] === ' ' || this.text[this.pos] === '\t') this.pos++;
  }

  private eat(char: string): boolean {
    if (this.text[this.pos] !== char) return false;
    this.pos++;
    return true;
  }

  private error(expected: string): Error {
    return new Error(`expected ${expected} at column ${this.pos + 1} of ${JSON.stringify(this.text)}`);
  }
}
