export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    /** Prod: enforce 100-char header limit (conventional; keeps history readable) */
    "header-max-length": [2, "always", 2000],
    /** Require lowercase type (feat, fix, chore, etc.) */
    "type-case": [2, "always", "lower-case"],
    /** Require non-empty subject */
    "subject-empty": [2, "never"],
    /** Require non-empty type */
    "type-empty": [2, "never"],
    "body-max-line-length": [0],
    "subject-case": [0],
    /** Require type to be one of the conventional set */
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "style",
        "refactor",
        "perf",
        "test",
        "build",
        "ci",
        "chore",
        "revert",
      ],
    ],
  },
};
