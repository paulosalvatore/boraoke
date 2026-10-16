// Jest runs the API routes as if deployed on Vercel, where the edge overwrites
// the client IP headers (lib/client-ip.ts, TICKET-119). Existing suites drive
// IP buckets through `x-forwarded-for` / `x-real-ip`; on Vercel those are
// trusted, elsewhere they are not. Tests of the off-Vercel behaviour delete
// this per test and restore it afterwards.
process.env.VERCEL = "1";

// The queue route and the paste preview look titles up through
// YouTube oEmbed. Point that at a closed loopback port for every suite, so a
// test that does not mock `fetch` fails fast and fail-open instead of calling
// the real youtube.com. Suites that test the lookup mock `fetch` themselves.
process.env.YOUTUBE_OEMBED_ORIGIN = "http://127.0.0.1:9";
