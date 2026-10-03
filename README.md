# Contract Obligation & Renewal Assistant

An AI-assisted **contract information management and obligation tracking workspace**. It helps teams see what a contract says, track obligations and renewal deadlines, review AI-extracted information, and trace every fact back to source text. **It is not legal advice.**

## Run locally
```bash
npm install          # pdf-parse + mammoth are optional deps for PDF/DOCX
npm start            # http://localhost:3000  (empty workspace first)
npm run seed:example # optional: demo@example.com / demo-password-1 with ONE labelled fictional contract
npm test             # unit + integration + security tests (node:test, no extra tooling)
```
Env vars: see `.env.example` (`PORT`, `DB_FILE`, `NODE_ENV=production` enables Secure cookies).

## Deploy (live)
- **Render**: push to GitHub → *New → Blueprint* → select repo (`render.yaml`: Docker, health check, persistent 1 GB disk at `/data`).
- **Fly.io**: `fly launch --no-deploy && fly volumes create contract_data --size 1 && fly deploy` (`fly.toml` included).
- **Any Docker host**: `docker build -t cora . && docker run -p 3000:3000 -v cora-data:/data cora`.
Serve behind HTTPS. Contracts live on the mounted volume, never in a public directory.

## Architecture
```mermaid
flowchart LR
 U[Upload / paste] --> V[Validate: size, magic bytes, name] --> N[Normalize → blocks w/ page+section]
 N --> A[ContractAnalyzer interface] --> C[Citation validation] --> D[Deterministic date engine]
 D --> R[Human review: approve / edit / reject] --> S[(Store + audit log)]
 S --> X[Version compare → stale detection]
```
| Module | Role |
|---|---|
| `lib/domain.js` | Pure business logic: normalization, citation validation, date calculation, diff, status |
| `lib/analyzer.js` | `ContractAnalyzer` implementation (offline rule-based) + `finalize()` validation |
| `lib/service.js` | Use-cases, workspace-scoped access, audit events, persistence |
| `server.js` | HTTP routes, auth, upload validation, security headers |
| `public/` | Dependency-free SPA (semantic HTML, keyboard review, responsive tables→cards) |

## AI pipeline
Document → Normalization → Extraction → **Citation validation** → **Deterministic calculations** → Human review.
The analyzer returns `{category, value, quote, confidence}`; `finalize()` locates each quote in the normalized document. If it can't, the item is downgraded to *Needs review* and no citation is stored. Dates (e.g. 60 days before 31 Dec 2027 → 01 Nov 2027) are computed by `calcDeadline()`, stored with source rule, anchor and method, and labelled “Calculated from contract rule”. Confidence uses explainable states (Confirmed / Uncertain / Needs review) – no fake percentages.
The shipped analyzer is deterministic and offline so the project runs without keys. To use an LLM, implement `analyze(doc)` returning the same shape using schema-constrained output, pass contract text only inside delimited *data* blocks, and register it in `service.js`. Output is still validated by `finalize()`.

## Security
Passwords hashed with scrypt; HttpOnly SameSite=Strict session cookies; every query is scoped by `workspaceId` (`own()`), so cross-tenant IDs return 404; file type decided by magic bytes, 8 MB limit; filenames sanitized; no file URLs (text only served through authenticated API); all UI output HTML-escaped; CSP + `nosniff`; errors never echo contract content. Prompt injection: contract text is data – the rule analyzer never interprets instructions, and any LLM adapter must keep contract text out of the instruction channel (tested by `prompt-injection text is plain content`).

## Versioning
Versions are frozen objects, never edited. A new version is analyzed, compared by business category, unchanged approvals carry forward, and changed approved items are marked **Potentially stale** with *Keep previous value / Approve new value*. Edits never overwrite `aiValue`; the reason is stored and audited.

## Design decisions & scope
JSON-file persistence (atomic enough for a single instance; swap `service.js` storage for Postgres using the entity model in `docs/architecture.md`). Not built: OCR, e-signature, calendar sync, notifications, policy-document upload (data model reserved), browser E2E automation (workflow covered by the integration test).
