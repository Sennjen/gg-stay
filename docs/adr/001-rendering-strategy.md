# ADR-001: Rendering strategy

Date: 2026-09-18 · Status: accepted

## Context

GG Stay is a public catalog whose pages must be indexable and fast on first load. Nuxt supports per-route rendering modes through `routeRules`.

## Options

1. SSR for every route.
2. Static generation of all pages.
3. Hybrid: SSR for data-driven routes, ISR for the home page.

## Decision

Hybrid. `/games` and `/games/[slug]` are server-rendered per request; `/` (and `/en`) use ISR with a 10 minute window.

## Reasons

- Catalog URLs carry filter state, so the space of pages is unbounded; static generation cannot cover it.
- SSR cost is absorbed by the server-side RAWG cache (lists 10 min, detail 24 h, taxonomies 7 days): a warm SSR request makes no upstream calls.
- The home page changes slowly and is the most likely entry page, so it benefits most from a CDN-cached response.
- Detail pages stay SSR rather than ISR so week 2 can refresh prices without cache invalidation work.

## Consequences

- TTFB depends on cache warmth; cold requests pay one RAWG round trip.
- The in-memory Nitro cache is per server instance on Vercel. A shared cache (Redis) arrives with the nightly index in week 2.
