## OutreachOS Backend API

### Auth

- **GET `/auth/gmail`**
  - **Description**: Starts Gmail OAuth for the current dev user session.
  - **Auth**: Requires session (`requireUser` stub will create `dev@example.com` if needed).
  - **Request**: No body.
  - **Response**: HTTP 302 redirect to Google OAuth consent screen.

- **GET `/auth/gmail/callback`**
  - **Description**: Handles Gmail OAuth callback and stores the `gmailRefreshToken` for the current user.
  - **Auth**: Requires session.
  - **Query params**:
    - `code` (string, required): Authorization code from Google.
  - **Responses**:
    - `302` redirect to `/dashboard` on success.
    - `400` with `{ success: false, error }` if `code` is missing.
    - `401` with `{ success: false, error }` if no user session.
    - `500` with `{ success: false, error }` on unexpected errors.

### Missions

- **POST `/missions`**
  - **Description**: Creates a new mission, generates a rationale with Gemini, and enqueues one `QUEUED` contact per company.
  - **Auth**: Requires session.
  - **Request body** (JSON):
    - `name` (string, required)
    - `ask` (string, required)
    - `targetCriteria` (string, required)
    - `contactsPerCompany` (number, optional; defaults to `1` if not > 0)
    - `companies` (string[], required; non-empty, domains or URLs)
  - **Success response** (`200`):
    - `{ success: true, data: { mission, contacts } }`
      - `mission`: Prisma `Mission` record (status starts as `DRAFT`).
      - `contacts`: Array of `{ id, domain }` for newly created `QUEUED` contacts.
  - **Error responses**:
    - `400` with `{ success: false, error: "Missing required mission fields" }`.
    - `500` with `{ success: false, error }` on unexpected failures or Gemini errors.

- **POST `/missions/:id/confirm`**
  - **Description**: Marks a mission as `ACTIVE` for the current user.
  - **Auth**: Requires session and mission ownership.
  - **Path params**:
    - `id` (string, required): Mission ID.
  - **Success response** (`200`):
    - `{ success: true, data: { id } }`
  - **Error responses**:
    - `401` if no user session.
    - `404` if mission does not exist or belongs to another user.
    - `500` for unexpected errors.

- **PATCH `/missions/:id/rationale`**
  - **Description**: Overwrites the mission rationale text.
  - **Auth**: Requires session and mission ownership.
  - **Path params**:
    - `id` (string, required)
  - **Request body**:
    - `rationale` (string, required)
  - **Responses**:
    - `200` with `{ success: true, data: { id } }` on success.
    - `400` if `rationale` is not a string.
    - `401`, `404`, or `500` as above.

- **GET `/missions/:id`**
  - **Description**: Fetches a mission and all its contacts for the current user.
  - **Auth**: Requires session and mission ownership.
  - **Path params**:
    - `id` (string, required)
  - **Success response** (`200`):
    - `{ success: true, data: mission }` with `contacts` included.
  - **Error responses**:
    - `401` if no user session.
    - `404` if mission not found or not owned by the user.
    - `500` for unexpected errors.

### Contacts & Research

- **POST `/missions/:missionId/research`**
  - **Description**: For each `QUEUED` contact on a mission, calls Hunter + Gemini to pick the best contact and moves it to `PENDING_APPROVAL` (or `SKIPPED`).
  - **Auth**: Requires session and mission ownership.
  - **Path params**:
    - `missionId` (string, required)
  - **Behavior**:
    - Uses `user.hunterApiKey` if set, otherwise `process.env.HUNTER_API_KEY`.
    - Sequentially:
      - Marks contact `RESEARCHING`.
      - Calls Hunter domain search and `filterByRole` (Gemini).
      - Optionally verifies email via Hunter email verifier.
      - On success, sets email/name/role/confidence and `status = PENDING_APPROVAL`.
      - On errors or no matches, sets `status = SKIPPED`.
  - **Success response** (`200`):
    - `{ success: true, data: contacts }` with all contacts for that mission.
  - **Error responses**:
    - `400` if Hunter API key is missing.
    - `401` if no user session.
    - `404` if mission not found or not owned by the user.
    - `500` with `{ success: false, error }` for unexpected errors.

- **GET `/missions/:missionId/queue`**
  - **Description**: Returns the approval queue for a mission, ensuring each contact has a draft.
  - **Auth**: Requires session and mission ownership.
  - **Path params**:
    - `missionId` (string, required)
  - **Behavior**:
    - Finds contacts with `status = PENDING_APPROVAL`.
    - For any missing `draft`, generates one via `generateDraft(contact, mission)` and persists it.
  - **Success response** (`200`):
    - `{ success: true, data: contactsWithDrafts }`
  - **Error responses**:
    - `401`, `404`, `500` as above.

- **POST `/contacts/:id/approve`**
  - **Description**: Approves a contact, creates a Gmail draft, and marks status as `SENT`.
  - **Auth**: Requires session and mission ownership.
  - **Path params**:
    - `id` (string, required): Contact ID.
  - **Request body**:
    - `draft` (string, optional): Edited draft body; falls back to stored `contact.draft` if omitted.
  - **Success response** (`200`):
    - `{ success: true, data: { contactId, sentTo } }`
  - **Error responses**:
    - `400` if no email on the contact or no draft content.
    - `401` if no user session.
    - `404` if contact not found or not owned by the current user (via its mission).
    - `500` with `{ success: false, error }` if Gmail draft creation fails.

- **POST `/contacts/:id/skip`**
  - **Description**: Skips a contact and marks status as `SKIPPED`.
  - **Auth**: Requires session and mission ownership.
  - **Path params**:
    - `id` (string, required)
  - **Success response** (`200`):
    - `{ success: true, data: { contactId } }`
  - **Error responses**:
    - `401` if no user session.
    - `404` if contact not found or not owned by the current user.
    - `500` for unexpected errors.

### Health

- **GET `/healthz`**
  - **Description**: Lightweight health check for the API.
  - **Auth**: None.
  - **Success response** (`200`):
    - `{ success: true, data: { ok: true } }`

