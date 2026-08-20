# CI build failure reproduced and fixed (PR #67 review round 2)

PR #67's CI build failed. Root cause: Next.js statically analyses `export const config` at build time and cannot resolve identifiers, so the F1 fix's tidy `matcher: [MIDDLEWARE_MATCHER]` was rejected. A WARM `.next` masked it locally — the incremental rebuild skipped the config validation and reported success in 1.6s.

## Reproduced locally, cold (`rm -rf .next && npm run build`), with the constant restored

```
 ⨯ Next.js can't recognize the exported `config` field in route "/middleware":
Unknown identifier "MIDDLEWARE_MATCHER" at "config.matcher[0]".
 ⨯ Invalid segment configuration export detected. This can cause unexpected behavior from the configs not being applied. You should see the relevant failures in the logs above. Please fix them to continue.
exit=1
```

## Fixed: literal inlined, exit 0 cold

```
 ✓ Compiled successfully in 4.1s
ƒ Middleware                             33.9 kB
exit=0
```

The F1 fix itself is untouched: the `api/` anchoring and the escaped `favicon\.ico` survive in the inline literal. Drift between the literal and the documented constant is prevented by a guard in `__tests__/route-locale.test.ts` that parses `middleware.ts` and asserts equality — verified to go red when the `api/` anchor is removed:

```
Expected: "/((?!api/|_next/static|_next/image|favicon\.ico|.*\.[\w]+$).*)"
Received: "/((?!api|_next/static|_next/image|favicon\.ico|.*\.[\w]+$).*)"
```
