# Pyltrix coming-soon page

Single static HTML file. No build step, no env vars, no database. Just
drop on any static host and it works.

## Quickest deploy: Vercel drag-and-drop (5 minutes)

1. Sign in to https://vercel.com (use the same GitHub account)
2. Click **Add New → Project**
3. Click **"deploy a template"** then scroll down for the "Other" option, OR:
4. Even simpler — drag the `coming-soon` folder onto the Vercel dashboard
5. Vercel auto-detects static HTML, deploys in ~30 seconds
6. You get a temporary URL like `pyltrix-landing.vercel.app`
7. In the project settings → Domains → add `pyltrix.com` → Vercel gives you
   the DNS records to add at your registrar
8. Once DNS propagates (5-30 min) your domain serves this page

## Even simpler: Cloudflare Pages

If your domain is at Cloudflare:
1. Go to Cloudflare dashboard → Workers & Pages → Create → Pages → Upload assets
2. Drop the `coming-soon` folder
3. Project name: `pyltrix-landing`
4. Deploy
5. Pages → Custom domains → add `pyltrix.com` → auto-configures DNS

## What it looks like

- Big "Launching soon" chip
- "The trip you'd ask a private concierge to plan." hero
- 3 value-prop cards (travelers, partners, real APIs)
- Partner inventory list (gives affiliate reviewers credibility)
- Affiliate contact email (`carson@pyltrix.com`)
- Footer

## When you eventually ship the real app

Just point `pyltrix.com` at the production Vercel deployment of the main
Next.js app instead. This static page can stay deployed at e.g.
`coming-soon.pyltrix.com` or get deleted entirely.
