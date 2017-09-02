const querystring = require('querystring');
const request = require('request-promise-native');

const models = require('./models');
import WclApiError from './WclApiError';
const WclApiResponse = models.WclApiResponse;

function getCurrentMemoryUsage() {
  const memoryUsage = process.memoryUsage();
  return memoryUsage.rss;
}

const WCL_MAINTENANCE_STRING = 'Warcraft Logs is down for maintenance';

class ApiController {
  static handle(req, res) {
    const handler = new ApiRequestHandler(req, res);

    // This allows users to cache bust, this is useful when live logging. It stores the result in the regular (uncachebusted) spot so that future requests for the regular request are also updated.
    if (req.query._) {
      console.log('Cache busting...');
      handler.cacheBust = true;
      delete req.query._;
    }

    // Allow users to provide their own API key. This is required during development so that other developers don't lock out the production in case they mess something up.
    if (req.query.api_key) {
      handler.apiKey = req.query.api_key;
      delete req.query.api_key; // don't use a separate cache for different API keys
    }

    // Set header already so that all request, good or bad, have it
    res.setHeader('Access-Control-Allow-Origin', '*');

    handler.handle();
  }
}

class ApiRequestHandler {
  req = null;
  res = null;

  cacheBust = false;
  apiKey = process.env.WCL_API_KEY;

  constructor(req, res) {
    this.req = req;
    this.res = res;
  }

  async handle() {
    const cachedWclApiResponse = await WclApiResponse.findById(this.requestUrl);
    const jsonString = !this.cacheBust && cachedWclApiResponse ? cachedWclApiResponse.content : null;
    if (!this.cacheBust && jsonString) {
      console.log('cache HIT', this.requestUrl);
      cachedWclApiResponse.update({
        numAccesses: cachedWclApiResponse.numAccesses + 1,
        lastAccessedAt: new Date(),
      });
      this.sendJson(jsonString);
    } else {
      console.log('cache MISS', this.requestUrl);
      this.fetchFromWcl(cachedWclApiResponse);
    }
  }

  get requestUrl() {
    return `${this.req.params[0]}?${querystring.stringify(this.req.query)}`;
  }
  async fetchFromWcl(cachedWclApiResponse) {
    const query = Object.assign({}, this.req.query, { api_key: this.apiKey });
    const path = `v1/${this.req.params[0]}?${querystring.stringify(query)}`;
    console.log('GET', path);
    try {
      const wclStart = Date.now();
      const jsonString = await request.get({
        url: `https://www.warcraftlogs.com/${path}`,
        headers: {
          'User-Agent': 'WoWAnalyzer.com API',
        },
        gzip: true, // using gzip is 80% quicker
        forever: true, // we'll be making several requests, so pool connections
      });
      const wclResponseTime = Date.now() - wclStart;

      // WCL maintenance mode returns 200 http code :(
      if (jsonString.indexOf(WCL_MAINTENANCE_STRING) !== -1) {
        throw new WclApiError(WCL_MAINTENANCE_STRING, 503);
      }

      if (cachedWclApiResponse) {
        cachedWclApiResponse.update({
          content: jsonString,
          wclResponseTime,
          numAccesses: cachedWclApiResponse.numAccesses + 1,
          lastAccessedAt: new Date(),
        });
      } else {
        WclApiResponse.create({
          url: this.requestUrl,
          content: jsonString,
          wclResponseTime,
        });
      }

      this.sendJson(jsonString);
      console.log('Finished', 'wcl:', wclResponseTime, 'ms');
    } catch (error) {
      if (error.statusCode >= 400 && error.statusCode < 600) {
        const message = error.error || error.message; // if this is a `request` error, `error` contains the plain JSON while `message` also has the statusCode so is polluted.
        console.error('WCL Error (' + error.statusCode + '): ' + message);
        this.res.status(error.statusCode);
        this.sendJson({
          error: 'WCL API error',
          message,
        });
        return;
      }
      this.res.status(500).send({
        error: 'A server error occured',
        message: error.message,
      });
      console.error(error);
    }
  }

  sendJson(json) {
    this.res.setHeader('Content-Type', 'application/json; charset=utf-8');
    this.res.send(json);
  }
}

module.exports = ApiController.handle;
