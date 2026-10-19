# Templates Module

Reusable email templates with Mustache-style `{{variable}}` substitution.

## Module Layout

```
src/modules/templates/
├── templates.plugin.ts              ← Elysia plugin (route group)
├── services/
│   └── template.service.ts          ← CRUD + renderTemplate()
├── dtos/
│   ├── create-template.dto.ts       ← POST/PUT body validation
│   └── list-templates.dto.ts        ← GET / pagination (default limit 100)
├── models/
│   └── template.schema.ts           ← Drizzle pgTable definition
├── serializations/
│   └── template.serialization.ts    ← Response mapper
└── types/
    └── template.types.ts            ← Template, CreateTemplateInput, UpdateTemplateInput
```

## Database Schema

Table: `templates`

| Column       | Type           | Constraints                  |
|--------------|----------------|------------------------------|
| id           | varchar(36)    | PK, prefixed `tpl_`         |
| api_key_id   | varchar(36)    | FK → api_keys, NOT NULL, indexed (#173) |
| name         | varchar(255)   | NOT NULL                     |
| subject      | varchar(500)   | NOT NULL                     |
| html         | text           | nullable                     |
| text_content | text           | nullable                     |
| variables    | jsonb          | NOT NULL, default `[]`       |
| created_at   | timestamp      | NOT NULL, default `now()`    |
| updated_at   | timestamp      | NOT NULL, default `now()`    |
| created_by_user_id | varchar(36) | nullable, FK → users ON DELETE SET NULL, indexed (#219) |

`created_by_user_id` is the dashboard user who created the template (over REST: the creator of the calling key). NULL means the owner; legacy rows are assigned to the owner at boot.

## Variable Substitution

Templates use Mustache-style `{{variableName}}` syntax. When sending an email with a template, provide a `variables` object:

```json
{
  "from": "hello@example.com",
  "to": "user@example.com",
  "templateId": "tpl_abc123...",
  "variables": {
    "name": "Alice",
    "company": "Acme Inc"
  }
}
```

The subject, HTML, and text bodies are all rendered with the provided variables. Unmatched `{{variables}}` are left as-is, and only the object's own keys are used (`{{constructor}}` stays as written).

**Text part (#250).** A template without a text body keeps the send's inline `text`, if one was given. When the email still has HTML and no text, the mailer derives a `text/plain` alternative from the rendered HTML at send time, and wraps an HTML fragment in a minimal document (neither is stored; see [emails.md](emails.md#body-composition-250)). A template's own text body is always sent as rendered.

**Escaping (#250).** In the HTML body, `{{name}}` is HTML-escaped (`&`, `<`, `>`, `"`, `'`), so a value such as a user-supplied display name cannot inject markup (a fake link, a form) into mail signed for your domain. To insert HTML on purpose, use triple braces: `{{{name}}}` inserts the value as is. Subjects and text bodies are not HTML: both forms insert the value as is there.

Limits: a template's `html` and `text` are at most 5 MB each, and it declares at most 100 variable names (`^\w+$`, up to 100 characters). A send passes at most 100 variables with values up to 100 KB. Variables multiply a template's size, so rendering is bounded too: it stops with `422 TEMPLATE_OUTPUT_TOO_LARGE` as soon as a body would pass 5 MB or the subject 500 characters, before the oversized string is built.

## Dashboard HTML Preview

The template create and edit pages (`/dashboard/templates` and `/dashboard/templates/:id`) render a **live HTML preview** beside the HTML editor. As you type, the markup is rendered into a sandboxed iframe so you can see what the email will look like without saving or sending.

- **Sample values:** `{{variable}}` placeholders are substituted with sample values for the preview (common names like `{{name}}`, `{{company}}`, `{{link}}` get realistic samples; any other variable falls back to its own name). This mirrors the `{{\w+}}` grammar of `renderTemplate()` but always fills placeholders so the preview resembles a delivered email. The saved template stores the raw `{{...}}` markup unchanged: substitution is preview-only.
- **Sandboxed:** the preview iframe uses `sandbox="allow-same-origin"` with **no** `allow-scripts`, so any `<script>` in the template HTML never executes. It is dark-mode aware and auto-resizes to its content.

## Service Methods

#### `renderTemplate(templateStr, variables, maxLength?): string`
Replaces `{{key}}` and `{{{key}}}` placeholders with values from the variables object (own keys only); with `options.html`, `{{key}}` values are HTML-escaped and `{{{key}}}` values inserted as is (#250). Throws `TemplateTooLargeError` (`src/modules/templates/errors.ts`) once the output would exceed `maxLength` (default `MAX_RENDERED_BODY_LENGTH`, 5 MB; subjects use `MAX_RENDERED_SUBJECT_LENGTH`, 500).

#### `createTemplate(input, apiKeyId, createdByUserId = null): Promise<Template>`
Creates a new template scoped to the API key, recording who created it (#219).

#### `listTemplates(apiKeyId, { page, limit }): Promise<{ data: Template[]; total }>`
Lists one page of the requesting API key's templates, oldest first, with the key's total (#258). `GET /api/v1/templates` takes optional `page` and `limit` (default and maximum 100, so a client that never pages sees the same first 100 templates) and returns `pagination: { page, limit, total }`.

#### `getTemplateById(id, apiKeyId): Promise<Template | undefined>`
Returns a template by ID, scoped to the API key.

#### `updateTemplate(id, apiKeyId, input): Promise<Template | undefined>`
Partially updates a template. Only provided fields are changed.

#### `deleteTemplate(id, apiKeyId): Promise<Template | undefined>`
Deletes a template, scoped to the API key.

#### `updateTemplateAs(id, actor, input)` / `deleteTemplateAs(id, actor): Promise<TemplateChangeResult>`
Dashboard edit and delete (#219). `actor` is the signed-in account (`{ id, role }`). Admins and the owner may change any template; a member only one it created (`created_by_user_id` = its id, so never an owner's or legacy one). Returns `{ ok: true, template }` or `{ ok: false, reason: "not_found" | "forbidden" }`; the route answers `forbidden` with the 403 page. Refusals are logged at `warn` with IDs only.

## Dashboard permissions (#219)

Any signed-in account views templates and creates them. Edit and delete are open to members for their own templates and to admins and the owner for all; the detail page is read-only otherwise. The list and detail pages show who created each template.

## API Endpoints

All routes require Bearer token auth and are rate-limited.

| Method | Path                     | Description        |
|--------|--------------------------|--------------------|
| POST   | /api/v1/templates        | Create template    |
| GET    | /api/v1/templates        | List templates (`?page`, `?limit`, default 100) |
| GET    | /api/v1/templates/:id    | Get template       |
| PUT    | /api/v1/templates/:id    | Update template    |
| DELETE | /api/v1/templates/:id    | Delete template    |
