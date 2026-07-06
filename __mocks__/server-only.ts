/**
 * Jest stub for the `server-only` guard package.
 *
 * The real package throws when imported outside a React Server Components
 * bundle (its "default" export condition), which is exactly what we want in
 * Next.js builds — but jest runs under plain node, so we map it to this empty
 * module (see jest.config.ts moduleNameMapper).
 */
export {};
