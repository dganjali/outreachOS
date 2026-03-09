# outreachOS

## Overview
A Vite + React app with Supabase authentication and protected routes.

## Local development
- Install dependencies and run the dev server.

## Vercel deployment
The app is a single-page application (SPA) using React Router. The repo includes a `vercel.json` rewrite so all routes serve `index.html`.

### Required environment variables
Add these in Vercel Project Settings → Environment Variables:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

### Build settings
Vercel should auto-detect Vite.
- Framework Preset: Vite
- Build Command: `npm run build`
- Output Directory: `dist`
- Install Command: `npm install` (default)

### Notes
- Vite only exposes variables prefixed with `VITE_`.
- Use Production/Preview/Development environments in Vercel as needed.
