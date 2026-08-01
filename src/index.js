export default {
  async fetch(request, env, ctx) {
    return new Response("Barwaaqo Forum API is running successfully via GitHub Actions!", {
      headers: { "content-type": "text/plain" },
    });
  },
};
