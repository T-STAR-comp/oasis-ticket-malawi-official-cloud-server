import { buildPublicImageUrl, IMAGE_BUCKET_URL_PREFIX } from "../config/images.js";
import { env } from "../config/env.js";
import * as listingsService from "../services/listings.service.js";
const LEGACY_IMAGE_MAP = {
    "/assets/event-lakeofstars.jpg": "/photos/pexels-kelly-17290956.jpg",
    "/assets/event-afrobeats.jpg": "/photos/pexels-jibarofoto-3727148.jpg",
    "/assets/event-artsummit.jpg": "/photos/pexels-jibarofoto-14017606.jpg",
    "/assets/travel-bus.jpg": "/photos/pexels-trynado-3608967.jpg",
    "/assets/travel-bus-interior.jpg": "/photos/pexels-proudlyswazi-37145523.jpg",
    "/assets/travel-lakeshore.jpg": "/photos/pexels-proudlyswazi-37145523.jpg",
};
const LISTING_OG_CACHE_MS = 60_000;
const listingOgCache = new Map();
function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function truncate(text, max) {
    const trimmed = text.trim();
    if (trimmed.length <= max)
        return trimmed;
    return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}
export function siteOriginFromRequest(req) {
    const configured = env.images.publicOrigin.trim();
    if (configured)
        return configured.replace(/\/$/, "");
    const host = req.get("host");
    if (!host)
        return "http://localhost:8000";
    const forwarded = req.get("x-forwarded-proto");
    const proto = forwarded?.split(",")[0]?.trim() || req.protocol || "https";
    return `${proto}://${host}`.replace(/\/$/, "");
}
export function resolveListingOgImageUrl(imageUrl, siteOrigin) {
    const origin = siteOrigin.replace(/\/$/, "");
    const fallback = `${origin}/icon-512.png`;
    if (!imageUrl?.trim())
        return fallback;
    const url = imageUrl.trim();
    if (url.startsWith("http://") || url.startsWith("https://"))
        return url;
    if (url.startsWith("/photos/"))
        return `${origin}${url}`;
    if (url.includes(IMAGE_BUCKET_URL_PREFIX) || url.startsWith("/image-bucket-folder")) {
        if (env.images.publicOrigin)
            return buildPublicImageUrl(url);
        const pathPart = url.startsWith("/") ? url : `${IMAGE_BUCKET_URL_PREFIX}/${url}`;
        return `${origin}${pathPart}`;
    }
    const legacy = LEGACY_IMAGE_MAP[url];
    if (legacy)
        return `${origin}${legacy}`;
    if (url.startsWith("/"))
        return `${origin}${url}`;
    return fallback;
}
export function listingIdForPath(pathname) {
    const match = /^\/ticket\/([^/]+)\/?$/.exec(pathname);
    if (!match?.[1])
        return null;
    try {
        return decodeURIComponent(match[1]);
    }
    catch {
        return match[1];
    }
}
export async function buildListingSeoSnapshot(listingId, siteOrigin) {
    const cached = listingOgCache.get(listingId);
    if (cached && Date.now() - cached.at < LISTING_OG_CACHE_MS) {
        return cached.snapshot;
    }
    const listing = await listingsService.getListingById(listingId);
    if (!listing)
        return null;
    const raw = listing;
    const title = String(raw.title ?? "Listing");
    const subtitle = String(raw.subtitle ?? "").trim();
    const description = truncate(String(raw.description ?? "").trim() || subtitle || `Book ${title} on Ticket Malawi.`, 300);
    const image = resolveListingOgImageUrl(String(raw.image ?? ""), siteOrigin);
    const pageUrl = `${siteOrigin.replace(/\/$/, "")}/ticket/${encodeURIComponent(listingId)}`;
    const ogTitle = `${title} — Ticket Malawi`;
    const headHtml = `<!-- tm-listing-og-start -->
<meta name="description" content="${escapeHtml(description)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Ticket Malawi" />
<meta property="og:title" content="${escapeHtml(ogTitle)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:image" content="${escapeHtml(image)}" />
<meta property="og:url" content="${escapeHtml(pageUrl)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(ogTitle)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(image)}" />
<title>${escapeHtml(ogTitle)}</title>
<!-- tm-listing-og-end -->`;
    const bodyHtml = `<main id="tm-seo-prerender" data-tm-seo="1" hidden aria-hidden="true">
  <h1>${escapeHtml(title)}</h1>
  ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}
  <p>${escapeHtml(description)}</p>
  <p><a href="${escapeHtml(pageUrl)}">View on Ticket Malawi</a></p>
  <img src="${escapeHtml(image)}" alt="${escapeHtml(title)}" />
</main>`;
    const snapshot = { headHtml, bodyHtml };
    listingOgCache.set(listingId, { at: Date.now(), snapshot });
    return snapshot;
}
const SEO_HIDE_STYLE = `<style id="tm-seo-hide">#tm-seo-prerender{display:none!important;visibility:hidden!important;position:absolute!important;left:-9999px!important}</style>`;
export function injectListingOgIntoHtml(template, snapshot) {
    let html = template.replace(/<!-- tm-listing-og-start -->[\s\S]*?<!-- tm-listing-og-end -->\n?/g, "");
    if (!html.includes('id="tm-seo-hide"')) {
        html = html.replace("</head>", `${SEO_HIDE_STYLE}</head>`);
    }
    html = html.replace("</head>", `${snapshot.headHtml}\n</head>`);
    if (snapshot.bodyHtml) {
        if (html.includes('id="tm-seo-prerender"')) {
            html = html.replace(/<main id="tm-seo-prerender"[\s\S]*?<\/main>/, snapshot.bodyHtml);
        }
        else {
            html = html.replace("<body>", `<body>${snapshot.bodyHtml}`);
        }
    }
    return html;
}
