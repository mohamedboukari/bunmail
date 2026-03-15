# Templates Module

Reusable email templates with Mustache-style `{{variable}}` substitution.

## Module Layout

```
src/modules/templates/
├── templates.plugin.ts              ← Elysia plugin (route group)
├── services/
│   └── template.service.ts          ← CRUD + renderTemplate()
├── dtos/
│   └── create-template.dto.ts       ← POST/PUT body validation
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
| api_key_id   | varchar(36)    | FK → api_keys, NOT NULL      |
| name         | varchar(255)   | NOT NULL                     |
| subject      | varchar(500)   | NOT NULL                     |
| html         | text           | nullable                     |
| text_content | text           | nullable                     |
| variables    | jsonb          | NOT NULL, default `[]`       |
| created_at   | timestamp      | NOT NULL, default `now()`    |
| updated_at   | timestamp      | NOT NULL, default `now()`    |

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

The subject, HTML, and text bodies are all rendered with the provided variables. Unmatched `{{variables}}` are left as-is.

## Service Methods

#### `renderTemplate(templateStr, variables): string`
Replaces `{{key}}` placeholders with values from the variables object.

#### `createTemplate(input, apiKeyId): Promise<Template>`
Creates a new template scoped to the API key.

#### `listTemplates(apiKeyId): Promise<Template[]>`
Lists all templates for the requesting API key.

#### `getTemplateById(id, apiKeyId): Promise<Template | undefined>`
Returns a template by ID, scoped to the API key.

#### `updateTemplate(id, apiKeyId, input): Promise<Template | undefined>`
Partially updates a template. Only provided fields are changed.

#### `deleteTemplate(id, apiKeyId): Promise<Template | undefined>`
Deletes a template, scoped to the API key.

## API Endpoints

All routes require Bearer token auth and are rate-limited.

| Method | Path                     | Description        |
|--------|--------------------------|--------------------|
| POST   | /api/v1/templates        | Create template    |
| GET    | /api/v1/templates        | List templates     |
| GET    | /api/v1/templates/:id    | Get template       |
| PUT    | /api/v1/templates/:id    | Update template    |
| DELETE | /api/v1/templates/:id    | Delete template    |
