// Serves the site's static files and logs one visit per page load, with the
// visitor's approximate city / region / postal code / country (from Cloudflare's
// IP lookup — postal code is often the ISP's area, not the visitor's).
// No IP addresses or cookies are stored.
//
// Visits go to two places:
//   - Workers Logs (dashboard → Workers → holy-rain-4c97 → Logs): easy to browse,
//     kept for a few days.
//   - Analytics Engine dataset "shan_huai_visits": kept ~3 months, queried with SQL.

const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|monitor/i;

function isPageLoad(request) {
  if (request.method !== "GET") return false;
  const dest = request.headers.get("Sec-Fetch-Dest");
  if (dest) return dest === "document";
  return (request.headers.get("Accept") || "").includes("text/html");
}

function externalReferrer(request, url) {
  const ref = request.headers.get("Referer");
  if (!ref) return "";
  try {
    const host = new URL(ref).hostname;
    return host === url.hostname ? "" : host;
  } catch {
    return "";
  }
}

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);

    try {
      if (isPageLoad(request)) {
        const url = new URL(request.url);
        const cf = request.cf || {};
        const ua = request.headers.get("User-Agent") || "";
        const visit = {
          event: "visit",
          path: url.pathname,
          city: cf.city || "",
          region: cf.region || "",
          postalCode: cf.postalCode || "",
          country: cf.country || "",
          referrer: externalReferrer(request, url),
          device: /Mobi|Android|iPhone|iPad/i.test(ua) ? "mobile" : "desktop",
          bot: BOT_UA.test(ua),
        };

        console.log(visit);

        env.VISITS?.writeDataPoint({
          blobs: [
            visit.path,
            visit.city,
            visit.region,
            visit.country,
            visit.referrer,
            visit.device,
            visit.bot ? "bot" : "human",
            visit.postalCode,
          ],
          doubles: [1],
          indexes: [visit.country || "unknown"],
        });
      }
    } catch (err) {
      // Logging must never break the site.
      console.error("visit logging failed", err);
    }

    return response;
  },
};
