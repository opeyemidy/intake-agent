import { anthropicClient, handleEnquiry } from "./agent.js";
import { Store } from "./store.js";

const body = process.argv.slice(2).join(" ") || "Hi, can we book a call next Friday morning about a new website? - Ada, ada@acme.test";
const store = new Store("Africa/Lagos");
const r = await handleEnquiry(anthropicClient(), store, { id: `cli_${Date.now()}`, from: "ada@acme.test", body });
console.log(JSON.stringify({ intent: r.intent, reply: r.reply, actions: r.actions, tools: r.toolCalls, bookings: store.bookings, handoffs: store.handoffs }, null, 2));
