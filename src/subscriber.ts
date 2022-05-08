import { FastifyInstance } from "fastify";
import EventEmitter = require("eventemitter3");
import PouchDB = require("pouchdb");
import fetch from "node-fetch";
import parseLinkHeader = require("parse-link-header");
import contentTypeParser = require("content-type-parser");
import * as cheerio from "cheerio";
import { randomBytes } from "crypto";

/** Deduplicate array according to selector function. */
function dedup<T>(
  array: Array<T>,
  /** Convert item into object used for comparing uniqueness. */
  func: (x: T) => unknown = (x) => x
): Array<T> {
  const check = new Set();
  return array.filter((x) => {
    const y = func(x);
    if (check.has(y)) {
      return false;
    } else {
      check.add(y);
      return true;
    }
  });
}

export interface IDiscovery {
  hubs: string[];
  topic: string;
}

export interface DiscoverOptions {
  /**
   * Only search for links within head tag.
   *
   * @default false
   */
  headOnly?: boolean;
}

/**
 * Discover the hubs and canonical url designated by the publisher.
 * Duplicate hubs will be eliminated based on url.
 *
 * Warning: `cheerio` is used for HTML/XML parsing, which may not work with all XML documents.
 */
export async function discover(
  rawTopic: string,
  opts: DiscoverOptions = {}
): Promise<IDiscovery> {
  opts = { headOnly: false, ...opts };

  // #discovery
  const res = await fetch(rawTopic);
  const hubs: string[] = [];
  let canonical: string | undefined;

  // check for link headers first
  const links = parseLinkHeader(res.headers.get("link"));
  if (links !== null) {
    for (const { rel, url } of Object.values(links)) {
      // add hub link
      if (rel.split(" ").includes("hub")) {
        hubs.push(url);
      }

      // add canonical link
      if (rel.split(" ").includes("self")) {
        canonical = url;
      }
    }
  }

  // if link headers did not provide enough info, search for Link tags
  if (canonical === undefined || hubs.length === 0) {
    // parse XML feed content for Links
    const contentType = contentTypeParser(res.headers.get("content-type"));
    if (contentType !== null && (contentType.isHTML() || contentType.isXML())) {
      const $ = cheerio.load(await res.text());

      // see #discovery-0 security consideration
      const links = $(opts.headOnly ? "head link" : "link").toArray();

      for (const { attribs } of links) {
        // ignore broken links
        if (!attribs.rel || !attribs.href) continue;

        // add hub link
        if (attribs.rel.split(" ").includes("hub")) {
          hubs.push(attribs.href);
        }

        // add canonical link
        if (
          canonical === undefined &&
          attribs.rel.split(" ").includes("self")
        ) {
          canonical = attribs.href;
        }
      }
    } else {
      throw new Error("no links in header and content not XML based");
    }
  }

  // return de-duplicated hub urls and canonical url
  if (canonical !== undefined) {
    return { hubs: dedup(hubs), topic: canonical };
  } else {
    throw new Error("no canonical link in header or XML based content");
  }
}

export interface SubOptions {
  /**
   * Number of seconds for which the subscriber would like to have the subscription active.
   * Hubs MAY choose to respect this value or not, depending on their own policies,
   * and MAY set a default value if the subscriber omits the parameter.
   */
  leaseSeconds?: number;
  /**
   * Automatically renew the subscription if there are less than renew seconds till it expires.
   *
   * @default undefined
   */
  renew?: number;
  /**
   * Enable "authorized content distribution" using HMAC digest.
   *
   * @default false
   */
  secret?: boolean;
  /** Additional request parameters to add to the subscription request. */
  params?: { [name: string]: string };
  /** Additional HTTP headers to add to the subscription request. */
  headers?: { [name: string]: string };
}

export interface ISub {
  hub: string;
  topic: string;
  callback: string;
  secret: string | null;
  validated: boolean;
}

// uniquely identified by (topic, callback)
// in practice, we will identify by callback since they are not reused
export class Sub implements ISub {
  public events = new EventEmitter<{
    /** Arrival of content distribution notification, contains body */
    content: [ArrayBuffer]; // TODO add emit somewhere
    /** Hub verified intent */
    validated: [];
    /** Hub denied subscription, may contain reason */
    denied: [string?];
  }>();

  constructor(
    public hub: string,
    public topic: string,
    public callback: string,
    public secret: string | null,
    public validated = false
  ) {
    this.events.on("validated", () => {
      this.validated = true;
    });
    this.events.on("denied", () => {
      this.validated = false;
    });
  }

  async cancel(): Promise<void> {
    // TODO
  }
}

/** Manage all subscriptions for a topic. */
export class MultiSub {
  public subs: { [callback: string]: Sub } = {};
  // TODO
}

/**
 * Manage WebSub subscriptions as a subscriber.
 *
 * Route your base callback url to this router.
 */
export class Subscriber {
  constructor(
    public fastify: FastifyInstance,
    public db: PouchDB.Database<ISub>
  ) {}

  async open(
    fastify: FastifyInstance,
    dbName: string,
    auth?: { username?: string; password?: string }
  ): Promise<Subscriber> {
    const subscriber = new Subscriber(fastify, new PouchDB(dbName, { auth }));
    await subscriber.routeAllCallbacks();
    return subscriber;
  }

  /** Add a single route for a given callback. */
  public async routeCallback(callback: string) {
    // #hub-verifies-intent
    this.fastify.get(`/${callback}`, (request, next) => {
      // TODO
    });
  }

  /** Add routes to provide subscriber verification of intent. */
  private async routeAllCallbacks() {
    // TODO fetch all currently registered callbacks
  }

  async *allSubscriptions(): AsyncGenerator<Sub> {
    // TODO
  }

  async getSub(callback: string): Promise<Sub> {
    const { hub, topic, secret, validated } = await this.db.get(callback);
    return new Sub(hub, topic, callback, secret, validated);
  }

  /**
   * TODO
   *
   * May throw an error from db calls.
   */
  protected async trySub(
    hub: string,
    topic: string,
    opts: SubOptions = {}
  ): Promise<Sub> {
    // #subscriber-sends-subscription-request

    // generate unique callback
    const callback = randomBytes(32).toString("base64url");

    // TODO
    // consider "hub.old_callback" parameter to enable atomically modifying callback of a subscription
    // see https://github.com/w3c/websub/issues/178 for details
    // the "SHOULD" lies with the changing callback on renewal, so that is what we will not do

    // generate secret
    const secret = opts.secret ? randomBytes(64).toString("base64url") : null;

    // consider error handling eventually
    await this.db.put({
      _id: callback,
      hub,
      topic,
      callback,
      secret,
      validated: false,
    });

    const params = new URLSearchParams({
      ...opts.params,
      "hub.callback": callback,
      "hub.mode": "subscribe",
      "hub.topic": topic,
    });

    if (opts.leaseSeconds !== undefined) {
      params.append("hub.lease_seconds", opts.leaseSeconds.toString());
    }

    if (secret) {
      params.append("hub.secret", secret);
    }

    // TODO handle redirects
    await fetch(hub, {
      method: "POST",
      headers: opts.headers,
      body: params,
    });

    return new Sub(hub, topic, callback, secret);
  }

  /**
   * Try to subscribe to a given topic.
   *
   * Warning: returned promise might never resolve.
   */
  async sub(
    rawTopic: string,
    opts: SubOptions & DiscoverOptions = {}
  ): Promise<MultiSub> {
    opts = { secret: false, params: {}, headers: {}, ...opts };

    const { hubs, topic } = await discover(rawTopic, opts);

    for (const hub of hubs) {
      // TODO
    }
  }
}
