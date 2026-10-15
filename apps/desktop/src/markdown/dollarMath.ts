// Inline maths with Pandoc's dollar rules (M4b part 2 §3; final review I2).
// remark-math reads `$…$` like a code span: any two single dollars pair up,
// so prices became maths (`$10-$20` read "10-", and `Pay $5 for [[Shop]]/$10`
// swallowed the link). Here a single `$` opens maths only before a non-space
// character and not right after a letter or digit (`US$5`), and the next
// single `$` closes it only after a non-space character and not right before
// a digit — otherwise that opener isn't maths at all, and the text is read as
// ordinary Markdown (a later `$x$` can still be maths). `$$…$$` is unchanged.
//
// The rules live in the tokenizer, not in a pass over the tree, so what a
// price would have hidden (links, emphasis) is parsed as usual. The construct
// replaces remark-math's own `mathText` tokenizer and keeps its token names,
// so mdast-util-math builds the same nodes.

/** micromark's character codes: UTF-16 units, or negative for line endings
 *  (-5…-3), tabs (-2) and virtual spaces (-1); `null` at the end. */
type Code = number | null;
type State = (code: Code) => State | undefined;

interface Token {
  type: string;
}

interface Effects {
  enter(type: string): Token;
  exit(type: string): Token;
  consume(code: Code): void;
}

interface TokenizeContext {
  /** The character before the construct. */
  previous: Code;
}

interface Construct {
  name?: string;
  tokenize: (this: TokenizeContext, effects: Effects, ok: State, nok: State) => State;
}

const DOLLAR = 36;
const SPACE = 32;

const isLineEnding = (code: Code) => code !== null && code < -2;
/** White space, a line ending, or nothing. */
const isSpaceOrEnd = (code: Code) => code === null || code === SPACE || code < 0;
const isDigit = (code: Code) => code !== null && code >= 48 && code <= 57;
const isWordChar = (code: Code) =>
  code !== null && code > 0 && /[\p{L}\p{N}]/u.test(String.fromCharCode(code));

/** remark-math's `mathText` tokenizer (micromark-extension-math 3.1) with
 *  the dollar rules added for single-dollar maths. */
function tokenizeMathText(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const before = this.previous;
  let sizeOpen = 0;
  let size = 0;
  let token: Token;
  /** The last character inside the maths so far. */
  let last: Code = null;
  return start;

  function start(code: Code): State | undefined {
    effects.enter('mathText');
    effects.enter('mathTextSequence');
    return sequenceOpen(code);
  }

  function sequenceOpen(code: Code): State | undefined {
    if (code === DOLLAR) {
      effects.consume(code);
      sizeOpen++;
      return sequenceOpen;
    }
    // `$ x$`, `US$5`: no maths opens here.
    if (sizeOpen === 1 && (isSpaceOrEnd(code) || isWordChar(before))) return nok(code);
    effects.exit('mathTextSequence');
    return between(code);
  }

  function between(code: Code): State | undefined {
    if (code === null) return nok(code);
    if (code === DOLLAR) {
      token = effects.enter('mathTextSequence');
      size = 0;
      return sequenceClose(code);
    }
    if (code === SPACE) {
      effects.enter('space');
      effects.consume(code);
      effects.exit('space');
      last = code;
      return between;
    }
    if (isLineEnding(code)) {
      effects.enter('lineEnding');
      effects.consume(code);
      effects.exit('lineEnding');
      last = code;
      return between;
    }
    effects.enter('mathTextData');
    return data(code);
  }

  function data(code: Code): State | undefined {
    if (code === null || code === SPACE || code === DOLLAR || isLineEnding(code)) {
      effects.exit('mathTextData');
      return between(code);
    }
    effects.consume(code);
    last = code;
    return data;
  }

  function sequenceClose(code: Code): State | undefined {
    if (code === DOLLAR) {
      effects.consume(code);
      size++;
      return sequenceClose;
    }
    if (size === sizeOpen) {
      // `$y $`, `$10-$20`: the first closer fails, so the opener does too.
      if (sizeOpen === 1 && (isSpaceOrEnd(last) || isDigit(code))) return nok(code);
      effects.exit('mathTextSequence');
      effects.exit('mathText');
      return ok(code);
    }
    // A run of another length is part of the maths.
    token.type = 'mathTextData';
    last = DOLLAR;
    return data(code);
  }
}

/** A unified plugin, used after remark-math: its inline maths follows the
 *  dollar rules above. */
export function remarkDollarRules(this: { data(): unknown }) {
  const data = this.data() as {
    micromarkExtensions?: { text?: Record<number, Construct | Construct[]> }[];
  };
  for (const ext of data.micromarkExtensions ?? []) {
    const construct = ext.text?.[DOLLAR];
    if (construct && !Array.isArray(construct) && construct.name === 'mathText') {
      ext.text![DOLLAR] = { ...construct, tokenize: tokenizeMathText };
    }
  }
}
