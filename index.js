export default {
  async fetch(request) {
    return new Response("Hello from iPhone GitOps!", {
      headers: { "content-type": "text/plain" },
    });
  },
};
