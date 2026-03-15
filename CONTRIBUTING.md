# Contributing to BunMail

Thanks for your interest in contributing! BunMail is an open-source project and we welcome contributions of all kinds.

## Getting Started

```bash
# Clone the repo
git clone https://github.com/your-username/bunmail.git
cd bunmail

# Install dependencies
bun install

# Copy environment config
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL

# Push schema to dev database
bun run db:push

# Seed the first API key
bun run src/db/seed.ts

# Start the dev server
bun run dev
```

## Development Commands

| Command               | Description                         |
|-----------------------|-------------------------------------|
| `bun run dev`         | Start dev server with watch mode    |
| `bun test`            | Run all tests                       |
| `bunx tsc --noEmit`   | Type-check without emitting         |
| `bun run lint`        | Run ESLint                          |
| `bun run lint:fix`    | Run ESLint with auto-fix            |
| `bun run db:push`     | Push schema to dev DB               |
| `bun run db:generate` | Generate migration files            |
| `bun run db:migrate`  | Run migrations                      |
| `bun run db:studio`   | Open Drizzle Studio                 |

## Project Structure

BunMail follows a module-per-feature architecture:

```
src/modules/<feature>/
├── <feature>.plugin.ts     ← Elysia plugin (route group)
├── services/               ← Business logic (only layer touching DB)
├── dtos/                   ← Request validation schemas
├── models/                 ← Drizzle pgTable definitions
├── serializations/         ← Response mappers
└── types/                  ← TypeScript types
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design.

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/). The commit message is validated by commitlint on commit.

**Format:** `<type>(<scope>): <description>`

**Allowed types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

**Examples:**
- `feat(templates): add Mustache variable rendering`
- `fix(queue): recover interrupted emails on startup`
- `docs: update API reference with webhook endpoints`

## Code Style

- TypeScript strict mode — no `any` types
- Use proper types, not unsafe casts
- Keep route handlers thin; business logic goes in services
- Only services access the database
- Use kebab-case for filenames, PascalCase for classes, camelCase for variables
- Document public functions with JSDoc comments

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes following the conventions above
3. Add/update tests for new functionality
4. Run `bun test && bunx tsc --noEmit && bun run lint`
5. Open a PR with a clear description of what and why

## Reporting Issues

Please use GitHub Issues. Include:
- Steps to reproduce
- Expected vs actual behavior
- BunMail version and environment (OS, Bun version, PostgreSQL version)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
