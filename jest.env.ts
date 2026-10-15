// Jest runs the API routes as if deployed on Vercel, where the edge overwrites
// the client IP headers (lib/client-ip.ts, TICKET-119). Existing suites drive
// IP buckets through `x-forwarded-for` / `x-real-ip`; on Vercel those are
// trusted, elsewhere they are not. Tests of the off-Vercel behaviour delete
// this per test and restore it afterwards.
process.env.VERCEL = "1";
