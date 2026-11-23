// worker.js — Cloudflare entry point. All logic lives in router.js / inbox.js (tested in Node).
import { DurableObject } from 'cloudflare:workers';
import { route } from './router.js';
import { makeInbox } from './inbox.js';

export class Inbox extends makeInbox(DurableObject) {}
export default { fetch: (request, env) => route(request, env) };
