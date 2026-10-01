import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { dispositionMutation } from "../lib/sweep.js";

/**
 * The selection sets of a GraphQL document, parsed here rather than by a GraphQL
 * dependency: the only consumer is the shape test below, and a dependency that
 * exists to check six field names is a dependency that can break the suite.
 *
 * Two things a naive scan of the braces gets wrong, and both are why this is
 * a parser rather than a regex:
 *
 *  - An ARGUMENT object literal is not a selection set.
 *    `addComment(input: { subjectId: $subject, body: $body })` carries its own
 *    braces inside parentheses, and reading them as a selection set asks
 *    `AddCommentInput` for a field named `subjectId` — true of the input type,
 *    false of the payload, and a check that passes while the real question goes
 *    unanswered. So parenthesised groups go first, nesting-aware: `(a: {b})`
 *    inside `(c: {d})` is still one group.
 *  - An ALIAS is not a field. `resolve0: resolveReviewThread(...)` answers under
 *    the key `resolve0`, and only `resolveReviewThread` is a field of `Mutation`.
 *    So the name after the colon is the field.
 */
interface Selection {
  readonly field: string;
  readonly set: SelectionSet;
}

interface SelectionSet {
  readonly selections: readonly Selection[];
}

/** Identifiers, colons and braces — everything else is punctuation or a literal. */
const TOKEN = /[_A-Za-z][_0-9A-Za-z]*|[:{}]/g;

/** What a token must look like to be a field name rather than punctuation. */
const IDENTIFIER = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** The document with every parenthesised group removed, nesting and all. */
function withoutArguments(document: string): string {
  let out = "";
  let depth = 0;
  for (const character of document) {
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0) throw new Error("the document closes a group it never opened");
    } else if (depth === 0) {
      out += character;
    }
  }
  if (depth !== 0) throw new Error("the document opens a group it never closes");
  return out;
}

/**
 * Every selection set of the document, nested. The head — `mutation Name(...)`
 * — is skipped by starting at the first `{`, which is where the root selection
 * set is once the arguments are gone. Braces that do not pair are refused: a
 * walk that stopped early would report the fields it did see and stay silent
 * about the half it never reached, which is the one answer that must not be
 * trusted here.
 */
function parseSelectionSet(document: string): SelectionSet {
  const text = withoutArguments(document);
  const open = text.indexOf("{");
  if (open === -1) throw new Error("the document has no selection set to walk");
  // From just after the root `{`, which is the one the walk does not re-read.
  const tokens = text.slice(open + 1).match(TOKEN) ?? [];
  let at = 0;
  const peek = (): string | undefined => tokens[at];

  const walk = (): SelectionSet => {
    const selections: Selection[] = [];
    for (;;) {
      const name = peek();
      if (name === undefined) throw new Error("the selection set is never closed");
      if (name === "}") {
        at += 1;
        return { selections };
      }
      if (name === "{") throw new Error("a selection set opens with a field, not a brace");
      at += 1;
      let field = name;
      if (peek() === ":") {
        const aliased = tokens[at + 1] ?? "";
        if (!IDENTIFIER.test(aliased)) throw new Error("an alias is not left without a field");
        field = aliased;
        at += 2;
      }
      let set: SelectionSet = { selections: [] };
      if (peek() === "{") {
        at += 1;
        set = walk();
      }
      selections.push({ field, set });
    }
  };

  const root = walk();
  if (at !== tokens.length) throw new Error("the selection set is closed more than it is opened");
  return root;
}

/**
 * GitHub's own answer to `what fields may I select here`, recorded on
 * 2026-09-30. `tools/sweep` posts through `gh api graphql` against the live
 * schema, and nothing offline could disagree with it: this tool asked for
 * `addComment { comment { url } }`, `AddCommentPayload` has no `comment`,
 * GitHub rejected the whole mutation, and every test passed — because the
 * tests answered their own fixtures. So the fields below are the ones GitHub
 * named, and the shape test walks the mutation against them.
 */
interface GitHubSchema {
  readonly refresh: {
    readonly captured: string;
    readonly note: string;
    readonly trimmed: string;
    readonly queries: readonly string[];
  };
  readonly types: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const schema: GitHubSchema = JSON.parse(
  readFileSync(new URL("./fixtures/github-schema.json", import.meta.url), "utf8"),
) as GitHubSchema;

/**
 * Every field this walk names is a field of the type it was selected on. The
 * failure message carries the path — `Mutation.addComment.commentEdge.node` —
 * so the answer says which selection broke, and not merely that one did.
 */
function expectShape(set: SelectionSet, type: string, path: string): void {
  for (const selection of set.selections) {
    const at = `${path}.${selection.field}`;
    const fields = schema.types[type];
    expect(fields, `${at}: the introspected schema holds no type ${type}`).toBeDefined();
    const next = fields?.[selection.field];
    expect(next, `${at}: ${type} has no field named ${selection.field}`).toBeTypeOf("string");
    expectShape(selection.set, next as string, at);
  }
}

describe("the schema fixture says how to refresh it", () => {
  test("it carries the introspection query, in the pieces GitHub will answer", () => {
    // GitHub refuses one introspection query over all six types
    // (INTROSPECTION_LIMIT_EXCEEDED): it caps __Type.fields at two per query. So
    // a fixture that cannot name three queries is a fixture nobody can refresh,
    // and the whole point of committing it is that the next schema change can be.
    expect(schema.refresh.queries).toHaveLength(3);
    for (const query of schema.refresh.queries) {
      expect(query).toContain("gh api graphql");
      expect(query).toContain("__type(name:");
    }
  });

  test("it says when it was captured, and which types are trimmed", () => {
    expect(schema.refresh.captured).toBe("2026-09-30");
    expect(schema.refresh.note).not.toBe("");
    expect(schema.refresh.trimmed).toContain("IssueComment");
    expect(schema.refresh.trimmed).toContain("PullRequestReviewThread");
  });
});

describe("dispositionMutation selects fields GitHub's schema has", () => {
  // Every n, because the selection set grows with the class: n = 0 has no
  // resolve at all, and the aliases rename as it grows. The one that broke
  // production (`comment` on AddCommentPayload) is in every one of them.
  for (const n of [0, 1, 2, 3]) {
    test(`a class of ${n} selects only fields the schema declares`, () => {
      expectShape(parseSelectionSet(dispositionMutation(n)), "Mutation", "Mutation");
    });
  }

  test("the comment is asked for through the edge, the schema's only way", () => {
    const root = parseSelectionSet(dispositionMutation(1));
    const addComment = root.selections.find((s) => s.field === "addComment");
    expect(addComment).toBeDefined();
    // IssueComment.url, two levels down: `comment` is not a field of
    // AddCommentPayload, and asking for it took the whole mutation down.
    expect(addComment?.set.selections.map((s) => s.field)).toEqual(["commentEdge"]);
    expect(addComment?.set.selections[0]?.set.selections.map((s) => s.field)).toEqual(["node"]);
    expect(
      addComment?.set.selections[0]?.set.selections[0]?.set.selections.map((s) => s.field),
    ).toEqual(["url"]);
    expect(Object.keys(schema.types["AddCommentPayload"] ?? {})).not.toContain("comment");
  });
});

describe("parseSelectionSet", () => {
  test("an argument object literal is not a selection set", () => {
    // The mistake this parser exists to avoid: the braces of `input: {...}`
    // read as a nested selection, so the check would ask AddCommentPayload for
    // `subjectId` — a field of AddCommentInput, never of the payload.
    const document = `mutation M($id: ID!) {
  addComment(input: { subjectId: $id, body: "x" }) { commentEdge { node { url } } }
}`;
    const root = parseSelectionSet(document);
    expect(root.selections).toHaveLength(1);
    expect(root.selections[0]?.set.selections.map((s) => s.field)).toEqual(["commentEdge"]);
  });

  test("a group nested in a group is one group", () => {
    const root = parseSelectionSet("{ a(filter: { b: { c: 1 } }) { d } }");
    expect(root.selections).toHaveLength(1);
    expect(root.selections[0]?.field).toBe("a");
    expect(root.selections[0]?.set.selections.map((s) => s.field)).toEqual(["d"]);
  });

  test("an alias resolves to the field after the colon", () => {
    const root = parseSelectionSet(
      "mutation M { resolve0: resolveReviewThread { thread { id } } }",
    );
    expect(root.selections.map((s) => s.field)).toEqual(["resolveReviewThread"]);
    expect(root.selections[0]?.set.selections.map((s) => s.field)).toEqual(["thread"]);
    // The alias is the response key, and it is not asked for by name.
    expect(JSON.stringify(root)).not.toContain("resolve0");
  });

  test("a leaf field carries no selection set of its own", () => {
    const root = parseSelectionSet("{ pageInfo { hasNextPage } }");
    expect(root.selections[0]?.set.selections[0]?.field).toBe("hasNextPage");
    expect(root.selections[0]?.set.selections[0]?.set.selections).toEqual([]);
  });

  test("unbalanced braces are refused, in both directions", () => {
    // A walk that stops at the first `}` would report the fields it saw and stay
    // quiet about the half it never read — so both halves have to be errors.
    expect(() => parseSelectionSet("{ a { b }")).toThrow(/never closed/);
    expect(() => parseSelectionSet("{ a } }")).toThrow(/closed more than/);
    expect(() => parseSelectionSet("{ { a } }")).toThrow(/with a field/);
    expect(() => parseSelectionSet("{ a }")).not.toThrow();
  });

  test("unbalanced parentheses and an alias with no field are refused", () => {
    expect(() => parseSelectionSet("{ a(b: 1 }")).toThrow(/never closes/);
    expect(() => parseSelectionSet("{ a: }")).toThrow(/without a field/);
  });

  test("a document with no selection set is refused", () => {
    expect(() => parseSelectionSet("mutation M")).toThrow(/no selection set/);
  });
});
