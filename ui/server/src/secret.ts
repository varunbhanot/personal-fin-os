// A secret value that never shows itself: not in JSON, util.inspect, a template string or a
// log. The value lives in a private field; reveal() it at the point of use and nowhere else.
const HIDDEN = "Secret(****)";

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return HIDDEN;
  }

  toJSON(): string {
    return HIDDEN;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return HIDDEN;
  }
}
