export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS Headers si frontend-ku uga helaa API-ga
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // API Health Check & Status
    if (url.pathname === "/api/health" || url.pathname === "/api") {
      return new Response(
        JSON.stringify({
          status: "success",
          message: "Barwaaqo Forum Payload CMS API is live on Cloudflare Worker!",
          database: "barwaqo-db (D1)",
          storage: "barwaaqo-assets (R2)",
          timestamp: new Date().toISOString(),
        }),
        { headers: corsHeaders }
      );
    }

    // Ku shaqaynta D1 Database Queries (Tusaale: Posts/Forum Data)
    if (url.pathname === "/api/posts") {
      try {
        if (request.method === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM posts LIMIT 20").all();
          return new Response(JSON.stringify({ success: true, data: results }), {
            headers: corsHeaders,
          });
        }
      } catch (err) {
        return new Response(
          JSON.stringify({ success: false, error: err.message }),
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // Default response ee jidadka kale (Routes)
    return new Response(
      JSON.stringify({
        status: "online",
        system: "Barwaaqo Forum CMS",
        endpoint: url.pathname,
      }),
      { headers: corsHeaders }
    );
  },
};
