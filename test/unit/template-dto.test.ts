import { describe, test, expect } from "bun:test";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import {
  createTemplateDto,
  updateTemplateDto,
} from "../../src/modules/templates/dtos/create-template.dto.ts";

/**
 * Size caps on templates. Templates are stored once and rendered on every
 * send, so an unbounded body or variable list would let any API key store
 * an arbitrarily large row and amplify it at send time.
 */

const create = TypeCompiler.Compile(createTemplateDto);
const update = TypeCompiler.Compile(updateTemplateDto);
const base = { name: "Welcome", subject: "Hello {{name}}" };
const FIVE_MB = 5 * 1024 * 1024;

describe("createTemplateDto / updateTemplateDto: size caps", () => {
  test("accepts bodies up to 5 MB", () => {
    expect(create.Check({ ...base, html: "x".repeat(FIVE_MB) })).toBe(true);
  });

  test("rejects html or text over 5 MB", () => {
    expect(create.Check({ ...base, html: "x".repeat(FIVE_MB + 1) })).toBe(false);
    expect(create.Check({ ...base, text: "x".repeat(FIVE_MB + 1) })).toBe(false);
    expect(update.Check({ html: "x".repeat(FIVE_MB + 1) })).toBe(false);
  });

  test("accepts word-character variable names", () => {
    expect(create.Check({ ...base, variables: ["name", "order_id", "Total2"] })).toBe(
      true,
    );
  });

  test("rejects variable names the renderer cannot match", () => {
    expect(create.Check({ ...base, variables: ["first name"] })).toBe(false);
    expect(create.Check({ ...base, variables: ["<img>"] })).toBe(false);
    expect(update.Check({ variables: [""] })).toBe(false);
  });

  test("rejects more than 100 variables or names over 100 characters", () => {
    const many = Array.from({ length: 101 }, (_, i) => `v${i}`);
    expect(create.Check({ ...base, variables: many })).toBe(false);
    expect(create.Check({ ...base, variables: ["x".repeat(101)] })).toBe(false);
  });
});
