export const SITE_NAME = "股情雷達 StockRadar";

// Falls back to the known Vercel deployment so metadata/sitemap/OG tags are
// always valid absolute URLs even if NEXT_PUBLIC_SITE_URL isn't set.
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://stock-web-rho.vercel.app").replace(/\/$/, "");
