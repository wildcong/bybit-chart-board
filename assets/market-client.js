/* Read-only Bybit public market client for static hosting. No API keys. */
(function (root) {
  "use strict";
  const API = "https://api.bybit.com/v5/market/";
  const INTERVALS = new Set(["1", "3", "5", "15", "30", "60", "D", "2D", "W"]);
  const CRYPTO_TYPES = new Set(["", "innovation"]);

  function precision(tick) {
    const [coefficient, exponent = "0"] = String(tick).toLowerCase().split("e");
    const fraction = (coefficient.split(".")[1] || "").replace(/0+$/, "");
    return Math.max(0, fraction.length - Number(exponent));
  }
  function parseCandles(rows) {
    const candles = new Map();
    for (const row of rows) {
      const candle = {time: Number(row[0]) / 1000, open: Number(row[1]), high: Number(row[2]),
        low: Number(row[3]), close: Number(row[4]), volume: Number(row[5])};
      if (!Object.values(candle).every(Number.isFinite)) throw new Error("시세에 유효하지 않은 값이 포함되어 있습니다.");
      candles.set(candle.time, candle);
    }
    return [...candles.values()].sort((a, b) => a.time - b.time);
  }
  function aggregateTwoDays(daily) {
    const groups = new Map();
    for (const candle of [...daily].sort((a, b) => a.time - b.time)) {
      const start = Math.floor(candle.time / 172800) * 172800;
      let group = groups.get(start);
      if (!group) {
        if (candle.time !== start) continue;
        groups.set(start, {...candle, time: start});
      } else {
        group.high = Math.max(group.high, candle.high);
        group.low = Math.min(group.low, candle.low);
        group.close = candle.close;
        group.volume += candle.volume;
      }
    }
    return [...groups.values()];
  }
  function withSignal(task, signal) {
    if (!signal) return task;
    if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const abort = () => {cleanup(); reject(new DOMException("Aborted", "AbortError"));};
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, {once: true});
      task.then(value => {cleanup(); resolve(value);}, error => {cleanup(); reject(error);});
    });
  }
  class Market {
    constructor(options = {}) {
      this.fetch = options.fetch || root.fetch.bind(root);
      this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
      this.now = options.now || (() => Date.now());
      this.cache = new Map(); this.pending = new Map(); this.waiting = []; this.active = 0;
    }
    cached(key, ttl, loader) {
      const cached = this.cache.get(key);
      if (cached && cached.expires > this.now()) return Promise.resolve(cached.value);
      if (!this.pending.has(key)) {
        const task = Promise.resolve().then(loader).then(value => {
          this.cache.set(key, {expires: this.now() + ttl, value});
          if (this.cache.size > 256) {
            for (const [oldKey, entry] of this.cache) if (entry.expires <= this.now()) this.cache.delete(oldKey);
            while (this.cache.size > 256) this.cache.delete([...this.cache.keys()].find(k => k !== "instruments"));
          }
          return value;
        }).finally(() => this.pending.delete(key));
        this.pending.set(key, task);
      }
      return this.pending.get(key);
    }
    slot(action) {
      return new Promise((resolve, reject) => {
        const run = async () => {
          this.active++;
          try {resolve(await action());} catch (error) {reject(error);}
          finally {this.active--; this.waiting.shift()?.();}
        };
        if (this.active < 4) run(); else this.waiting.push(run);
      });
    }
    request(endpoint, params) {
      return this.slot(async () => {
        const url = new URL(endpoint, API); url.search = new URLSearchParams(params).toString();
        for (let attempt = 0; attempt < 3; attempt++) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          try {
            const response = await this.fetch(url, {signal: controller.signal, mode: "cors", credentials: "omit", cache: "no-store"});
            if (response.status === 403) {
              const error = new Error("바이비트가 현재 네트워크의 접속을 거부했습니다(403). 접속 가능한 네트워크인지 확인해주세요.");
              error.permanent = true; throw error;
            }
            if (response.status === 429 || response.status >= 500) throw new Error("바이비트가 일시적으로 응답하지 않습니다.");
            if (!response.ok) {const error = new Error(`바이비트 조회 실패 (${response.status})`); error.permanent = true; throw error;}
            const payload = await response.json();
            if ([10006, 10429].includes(payload.retCode)) throw new Error("바이비트 요청 제한에 도달했습니다.");
            if (payload.retCode !== 0) {const error = new Error(`바이비트 조회 실패: ${payload.retMsg || "알 수 없는 응답"}`); error.permanent = true; throw error;}
            return payload;
          } catch (error) {
            if (error.permanent) throw error;
            if (attempt === 2) throw new Error(`바이비트 시세를 받지 못했습니다. 잠시 후 다시 시도해주세요. (${error.message})`);
          } finally {clearTimeout(timeout);}
          await this.sleep(600 * 2 ** attempt);
        }
      });
    }
    instruments() {
      return this.cached("instruments", 900000, async () => {
        const instruments = new Map(), seen = new Set(); let cursor = "";
        do {
          const params = {category: "linear", status: "Trading", limit: 1000};
          if (cursor) params.cursor = cursor;
          const payload = await this.request("instruments-info", params);
          for (const item of payload.result.list) {
            if (item.status !== "Trading" || item.contractType !== "LinearPerpetual" || item.quoteCoin !== "USDT" || item.settleCoin !== "USDT" || !CRYPTO_TYPES.has(item.symbolType ?? "")) continue;
            const tick = item.priceFilter.tickSize;
            instruments.set(item.symbol, {symbol: item.symbol, base: item.baseCoin, symbol_type: item.symbolType ?? "", tick_size: Number(tick), price_precision: precision(tick)});
          }
          cursor = payload.result.nextPageCursor || "";
          if (cursor && seen.has(cursor)) throw new Error("바이비트 종목 목록 페이지가 반복되었습니다.");
          seen.add(cursor);
        } while (cursor);
        if (!instruments.size) throw new Error("거래 중인 USDT 암호화폐 무기한 종목을 찾지 못했습니다.");
        return instruments;
      });
    }
    catalog() {
      return this.cached("catalog", 10000, async () => {
        const [instruments, payload] = await Promise.all([this.instruments(), this.request("tickers", {category: "linear"})]);
        const number = value => value == null || value === "" ? null : Number(value);
        const symbols = payload.result.list.filter(item => instruments.has(item.symbol)).map(item => ({
          ...instruments.get(item.symbol), price: number(item.lastPrice), change: number(item.price24hPcnt),
          turnover: number(item.turnover24h), funding: number(item.fundingRate),
        }));
        symbols.sort((a, b) => (b.turnover ?? 0) - (a.turnover ?? 0));
        return {symbols, updated_at: Math.floor(payload.time / 1000)};
      });
    }
    async candles(symbol, interval, limit) {
      if (!/^[A-Z0-9]{1,40}USDT$/.test(symbol) || !INTERVALS.has(interval) || !Number.isInteger(limit) || limit < 50 || limit > 450) throw new Error("올바르지 않은 차트 조회 조건입니다.");
      const instruments = await this.instruments();
      if (!instruments.has(symbol)) throw new Error("표시 대상인 USDT 암호화폐 무기한 계약이 아닙니다.");
      return this.cached(JSON.stringify([symbol, interval, limit]), 4000, async () => {
        const twoDays = interval === "2D";
        const payload = await this.request("kline", {category: "linear", symbol, interval: twoDays ? "D" : interval, limit: twoDays ? Math.min(1000, limit * 2 + 2) : limit});
        const source = parseCandles(payload.result.list);
        const candles = twoDays ? aggregateTwoDays(source).slice(-limit) : source;
        if (!candles.length) throw new Error("이 종목의 캔들 데이터가 없습니다.");
        const info = instruments.get(symbol);
        return {symbol, interval, candles, daily_tail: twoDays ? source.slice(-3) : [], updated_at: Math.floor(payload.time / 1000), price_precision: info.price_precision, tick_size: info.tick_size};
      });
    }
    async handle(path, signal) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const url = new URL(path, "https://board.invalid/");
      let task;
      if (url.pathname === "/symbols") task = this.catalog();
      else if (url.pathname === "/candles") task = this.candles(url.searchParams.get("symbol") || "BTCUSDT", url.searchParams.get("interval") || "15", Number(url.searchParams.get("limit") || 240));
      else throw new Error("지원하지 않는 시세 요청입니다.");
      return structuredClone(await withSignal(task, signal));
    }
  }
  if (typeof module !== "undefined" && module.exports) module.exports = {Market, precision, parseCandles, aggregateTwoDays};
  else root.BoardMarket = new Market();
})(globalThis);
