export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    /** Max 100 chars for header — enough room for descriptive messages */
    "header-max-length": [2, "always", 100],
    /** Require lowercase type (feat, fix, chore, etc.) */
    "type-case": [2, "always", "lower-case"],
    /** Require non-empty subject */
    "subject-empty": [2, "never"],
    /** Require non-empty type */
    "type-empty": [2, "never"],
  },
};
