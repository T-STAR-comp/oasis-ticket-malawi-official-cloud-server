import * as listingsService from "../services/listings.service.js";

type SeoPage = "home" | "events" | "travel";

type ListingCard = {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  location?: string;
  date?: string;
  price?: number;
  route?: { from: string; to: string };
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPrice(mwk: number | undefined): string {
  if (mwk == null || !Number.isFinite(mwk)) return "";
  return `MWK ${mwk.toLocaleString("en-MW")}`;
}

function listingToCard(raw: Record<string, unknown>): ListingCard {
  const route = raw.route as { from?: string; to?: string } | undefined;
  return {
    id: String(raw.id ?? ""),
    kind: String(raw.kind ?? ""),
    title: String(raw.title ?? ""),
    subtitle: String(raw.subtitle ?? ""),
    location: String(raw.location ?? ""),
    date: String(raw.date ?? ""),
    price: Number(raw.price ?? 0) || undefined,
    route:
      route?.from && route?.to
        ? { from: route.from, to: route.to }
        : undefined,
  };
}

function renderListingItem(card: ListingCard): string {
  const href = `/ticket/${encodeURIComponent(card.id)}`;
  const meta =
    card.kind === "travel" && card.route
      ? `${escapeHtml(card.route.from)} → ${escapeHtml(card.route.to)}`
      : escapeHtml([card.location, card.date].filter(Boolean).join(" · "));
  const price = formatPrice(card.price);

  return `<article itemscope itemtype="https://schema.org/Event">
  <h3 itemprop="name"><a href="${href}">${escapeHtml(card.title)}</a></h3>
  ${card.subtitle ? `<p>${escapeHtml(card.subtitle)}</p>` : ""}
  <p>${meta}${price ? ` · ${escapeHtml(price)}` : ""}</p>
</article>`;
}

function renderSection(title: string, items: ListingCard[]): string {
  if (items.length === 0) return "";
  return `<section aria-label="${escapeHtml(title)}">
  <h2>${escapeHtml(title)}</h2>
  ${items.map(renderListingItem).join("\n")}
</section>`;
}

function buildJsonLd(events: ListingCard[], travel: ListingCard[]): string {
  const items = [...events, ...travel].slice(0, 12).map((card) => ({
    "@type": card.kind === "travel" ? "Product" : "Event",
    name: card.title,
    url: `/ticket/${card.id}`,
    ...(card.location ? { location: { "@type": "Place", name: card.location } } : {}),
    ...(card.price ? { offers: { "@type": "Offer", price: card.price, priceCurrency: "MWK" } } : {}),
  }));

  if (items.length === 0) return "";

  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Ticket Malawi",
    description: "Book events and intercity bus travel across Malawi.",
    url: "/",
    potentialAction: {
      "@type": "SearchAction",
      target: "/events",
      "query-input": "required name=search_term_string",
    },
    hasPart: items,
  });
}

export type SeoSnapshot = {
  bodyHtml: string;
  headHtml: string;
};

let cache: { at: number; snapshot: SeoSnapshot } | null = null;
const CACHE_MS = 60_000;

export async function buildSeoSnapshot(page: SeoPage): Promise<SeoSnapshot> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return filterSnapshotForPage(cache.snapshot, page);
  }

  const [eventsRaw, travelRaw] = await Promise.all([
    listingsService.listPublished("event"),
    listingsService.listPublished("travel"),
  ]);

  const events = eventsRaw.map((r) => listingToCard(r as Record<string, unknown>));
  const travel = travelRaw.map((r) => listingToCard(r as Record<string, unknown>));

  const bodyHtml = `<main id="tm-seo-prerender" data-tm-seo="1" hidden aria-hidden="true">
  <header>
    <h1>Ticket Malawi — Events &amp; Travel</h1>
    <p>Book festivals, concerts, and intercity bus routes across Malawi. Pay with mobile money, board with a QR code.</p>
    <nav aria-label="Primary">
      <a href="/events">Events</a> · <a href="/travel">Travel</a> · <a href="/about">About</a>
    </nav>
  </header>
  ${renderSection("Upcoming events in Malawi", events.slice(0, 8))}
  ${renderSection("Active bus routes", travel.slice(0, 8))}
</main>`;

  const jsonLd = buildJsonLd(events, travel);
  const headHtml = jsonLd
    ? `<script type="application/ld+json">${jsonLd}</script>`
    : "";

  cache = { at: Date.now(), snapshot: { bodyHtml, headHtml } };
  return filterSnapshotForPage(cache.snapshot, page);
}

function filterSnapshotForPage(snapshot: SeoSnapshot, page: SeoPage): SeoSnapshot {
  if (page === "home") return snapshot;

  const title =
    page === "events"
      ? "Events in Malawi — Ticket Malawi"
      : "Intercity bus travel — Ticket Malawi";
  const intro =
    page === "events"
      ? "Festivals, concerts, workshops, and gatherings across Malawi."
      : "Executive coaches connecting Blantyre, Lilongwe, Mzuzu, and the lake.";

  const sectionMatch =
    page === "events" ? /Upcoming events in Malawi[\s\S]*?<\/section>/ : /Active bus routes[\s\S]*?<\/section>/;
  const section = snapshot.bodyHtml.match(sectionMatch)?.[0] ?? "";

  const bodyHtml = `<main id="tm-seo-prerender" data-tm-seo="1" hidden aria-hidden="true">
  <header>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(intro)}</p>
    <nav aria-label="Primary"><a href="/">Home</a> · <a href="/events">Events</a> · <a href="/travel">Travel</a></nav>
  </header>
  ${section}
</main>`;

  return { bodyHtml, headHtml: snapshot.headHtml };
}

const SEO_HIDE_STYLE = `<style id="tm-seo-hide">#tm-seo-prerender{display:none!important;visibility:hidden!important;position:absolute!important;left:-9999px!important}</style>`;

export function injectSeoIntoHtml(template: string, snapshot: SeoSnapshot): string {
  let html = template;
  if (!html.includes('id="tm-seo-hide"')) {
    const headBits = SEO_HIDE_STYLE + (snapshot.headHtml && !html.includes("application/ld+json") ? snapshot.headHtml : "");
    html = html.replace("</head>", `${headBits}</head>`);
  } else if (snapshot.headHtml && !html.includes("application/ld+json")) {
    html = html.replace("</head>", `${snapshot.headHtml}</head>`);
  }
  if (snapshot.bodyHtml && !html.includes('id="tm-seo-prerender"')) {
    html = html.replace("<body>", `<body>${snapshot.bodyHtml}`);
  }
  return html;
}

export function seoPageForPath(pathname: string): SeoPage | null {
  if (pathname === "/" || pathname === "") return "home";
  if (pathname === "/events") return "events";
  if (pathname === "/travel") return "travel";
  return null;
}
