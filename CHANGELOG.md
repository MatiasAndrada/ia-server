# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
