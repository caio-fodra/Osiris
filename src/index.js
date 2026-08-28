/* Welcome to Cloudflare Workers! This is your first worker. */

export default {
	async fetch(request, env, ctx) {
		return new Response("Hello World!");
	},
};
