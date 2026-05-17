/**
 * MVP image source. Uses the public Unsplash "source" URL — no key required,
 * stable, cached at the CDN. Pre-launch we'll move to the Unsplash API with
 * proper attribution + caching (or curated assets).
 */

export function unsplashUrlFor(query: string, opts: { w?: number; h?: number } = {}) {
  const w = opts.w ?? 1600;
  const h = opts.h ?? 900;
  const q = encodeURIComponent(query.replace(/[^a-z0-9 ,\-]/gi, "").trim() || "luxury golf course");
  return `https://images.unsplash.com/featured/?${q}&w=${w}&h=${h}&fit=crop&auto=format&q=80`;
}
