declare module "content-type-parser" {
  interface ContentType {
    /** the top-level media type, e.g. `"text"` */
    type: string;
    /** the subtype, e.g. `"html"` */
    subtype: string;
    /**
     * an array of `{ separator, key, value }` pairs representing the parameters.
     * The `separator` field contains any whitespace, not just the `;` character.
     */
    parameterList: { separator: string; key: string; value: string }[];
    get(key: string): string;
    set(key: string, value: string): void;

    isHTML(): boolean;
    isXML(): boolean;
    isText(): boolean;
  }

  const parser: (s: string | null) => ContentType | null;

  export = parser;
}
