# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Direct WhatsApp connection via Baileys, with one session per business (QR pairing, start/stop, multi-tenant) — see `docs/ENDPOINTS.md` (WhatsApp Sessions API / Messages API). This is now the primary path; `/api/chat` and `/api/agents/*` remain as a legacy/compat HTTP path.
- Multi-step conversational reservation flow (name, party size, day, time, confirmation, edit menu, cancellation) driven deterministically by `WhatsAppHandler`, with natural-language slot extraction (`reservation-nlu.service`) and multi-intent message planning (`reservation-planner.service`) for messages like "cancel Friday's and book a new one for tomorrow".
- Per-business blocked dates (`business_blocked_dates`), with owner-supplied reasons, AI-generated reason messages, and realtime sync from Supabase.
- "Active reservations" inquiry (e.g. "¿tengo reservas?"), with a selection menu when a customer has more than one.
- Multi-language support (Spanish/English/Portuguese): automatic per-message detection plus explicit language switching at any point in the conversation (`src/i18n`).
- Single-active-reservation policy per customer, enforced with a distributed Redis lock to avoid race-condition duplicates.

### Changed
- Replaced the local Ollama (Llama 3.2) inference engine with OpenRouter — no local model, requests now go to `OPENROUTER_MODEL` via the OpenRouter API, with automatic failover across `OPENROUTER_FALLBACK_MODELS`.
- Actions (`REGISTER`, `CHECK_STATUS`, `CANCEL`, `INFO_REQUEST`) are now emitted via native tool calling with a JSON schema, replacing the old `[ACTION:tipo:{json}]` text-marker convention and its regex/keyword-based fallback parsing.
- `/health` response field renamed `ollama` → `llm`.
- Dependencies brought up to date: Express 5, zod 4, redis 6, express-rate-limit 8, helmet 8, dotenv 17, TypeScript 7, ESLint 10, Jest 30 and the matching `@types`. Notable consequences:
  - `typescript` is installed as an alias of `@typescript/typescript6` and the native TypeScript 7 compiler as `typescript-native`. `npm run build` runs the native `tsc` (7.x), while ts-jest, ts-node and typescript-eslint keep the JavaScript compiler API (6.x) they still require.
  - TypeScript 6/7 no longer pulls in every `node_modules/@types` package automatically: `tsconfig.json` declares `types: ["node"]` and the new `tsconfig.test.json` (used by ts-jest) adds `jest`.
  - ESLint 10 dropped `.eslintrc.json`; the configuration now lives in `eslint.config.mjs` (flat config) and `npm run lint` no longer passes `--ext`.
  - Route handlers that read `req.params` declare their parameters (`Request<{ businessId: string }>`), because `@types/express` 5 types params as `string | string[]`.
  - The rate limiter's IP fallback goes through `ipKeyGenerator`, so IPv6 clients can no longer sidestep the limit by rotating within their prefix.

## [1.0.0] - 2026-02-06

### Added
- Initial release of IA Server
- Chat endpoint with conversation history
- Intent analysis endpoint
- Batch processing endpoint
- Health check endpoint
- Integration with Ollama (Llama 3.2)
- Redis caching for conversations and business context
- API Key authentication
- Rate limiting (100 req/min general, 10 req/min batch)
- CORS support
- Retry logic for Ollama requests
- Structured logging with Winston
- PM2 configuration for production
- Comprehensive test suite with Jest
- Setup and deployment scripts
- Full documentation

### Security
- API Key authentication on all endpoints
- CORS configuration
- Helmet security headers
- Input validation with Zod
- Rate limiting protection

### Performance
- Redis caching (5 min TTL for business context)
- Gzip compression
- PM2 cluster mode support
- Conversation history limited to 10 messages
