/* Public Bybit market data only. */
"use strict";
const $ = (id) => document.getElementById(id);
const LABELS = {
  1: "1분",
  3: "3분",
  5: "5분",
  15: "15분",
  30: "30분",
  60: "60분",
  D: "1일",
  "2D": "2일",
  W: "주봉",
};
const SECONDS = {
  1: 60,
  3: 180,
  5: 300,
  15: 900,
  30: 1800,
  60: 3600,
  D: 86400,
  "2D": 172800,
  W: 604800,
};
const SORTS = {
  turnover: "거래대금순",
  gainers: "상승률순",
  losers: "하락률순",
  name: "이름순",
};
const KST = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const CLOCK = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem("perp." + key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem("perp." + key, JSON.stringify(value));
  } catch {}
}
const savedFavorites = read("favorites", []),
  savedInterval = read("interval", "15");
const state = {
  items: [],
  filtered: [],
  cards: new Map(),
  favorites: new Set(
    Array.isArray(savedFavorites)
      ? savedFavorites.filter((x) => typeof x === "string")
      : [],
  ),
  interval: LABELS[savedInterval] ? savedInterval : "15",
  mode: "all",
  generation: 0,
  rendered: 0,
  queue: [],
  running: 0,
  ema: read("ema", true),
  volume: read("volume", true),
  catalogBusy: false,
};
let socket,
  socketRetry,
  socketFailures = 0,
  subscriptions = new Set(),
  syncTimer;
function price(value, precision = 2) {
  return Number.isFinite(value)
    ? value.toLocaleString("en-US", {
        minimumFractionDigits: precision,
        maximumFractionDigits: precision,
      })
    : "—";
}
function percent(value) {
  return Number.isFinite(value)
    ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`
    : "—";
}
function compact(value) {
  return Number.isFinite(value)
    ? "$" +
        Intl.NumberFormat("en-US", {
          notation: "compact",
          maximumFractionDigits: 2,
        }).format(value)
    : "—";
}
function announce(message, retry) {
  const el = $("notice");
  el.replaceChildren(document.createTextNode(message));
  el.hidden = !message;
  if (retry) {
    const b = document.createElement("button");
    b.textContent = "다시 시도";
    b.onclick = retry;
    el.append(b);
  }
}
async function api(path, signal) {
  if (window.BoardMarket) return window.BoardMarket.handle(path, signal);
  const response = await fetch(new URL(`./api/${path}`, document.baseURI), {
    signal,
    cache: "no-store",
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("서버 응답을 읽지 못했습니다.");
  }
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : `조회 실패 (${response.status})`,
    );
  return data;
}
function updateTabs() {
  for (const [id, mode] of [
    ["allTab", "all"],
    ["favoritesTab", "favorites"],
  ]) {
    const active = state.mode === mode;
    $(id).classList.toggle("selected", active);
    $(id).setAttribute("aria-pressed", active);
  }
  $("favoriteCount").textContent = state.items.filter(
    (item) => state.favorites.has(item.symbol),
  ).length;
}
function updateIntervalButtons() {
  document.querySelectorAll("[data-interval]").forEach((b) => {
    const active = b.dataset.interval === state.interval;
    b.classList.toggle("selected", active);
    b.setAttribute("aria-pressed", active);
  });
}
function updateFavorite(card) {
  const active = state.favorites.has(card.item.symbol);
  card.favorite.classList.toggle("active", active);
  card.favorite.textContent = active ? "★" : "☆";
  card.favorite.setAttribute("aria-pressed", active);
  card.favorite.setAttribute(
    "aria-label",
    `${card.item.symbol} 관심종목 ${active ? "해제" : "추가"}`,
  );
}
function toggleFavorite(card) {
  const symbol = card.item.symbol;
  state.favorites.has(symbol)
    ? state.favorites.delete(symbol)
    : state.favorites.add(symbol);
  save("favorites", [...state.favorites]);
  updateTabs();
  updateFavorite(card);
  if (state.mode === "favorites") render();
}
function quote(card) {
  const item = card.item;
  card.el.querySelector(".last-price").textContent = price(
    item.price,
    item.price_precision,
  );
  const change = card.el.querySelector(".change");
  change.textContent = `${percent(item.change)} · 24H`;
  change.className = `change ${item.change >= 0 ? "up" : "down"}`;
  card.el.querySelector(".turnover").textContent = compact(item.turnover);
  card.el.querySelector(".funding").textContent = Number.isFinite(item.funding)
    ? `${(item.funding * 100).toFixed(4)}%`
    : "—";
  card.el.querySelector(".symbol-subtitle").textContent =
    `24H 거래대금 ${compact(item.turnover)}`;
}
function status(card, text, kind = "pending") {
  card.statusText.textContent = text;
  card.statusDot.className = `dot ${kind}`;
}
function makeCard(item) {
  const el = document.createElement("article");
  el.className = "card";
  el.dataset.symbol = item.symbol;
  el.innerHTML = `<div class="card-header"><div class="symbol-group"><button class="favorite"></button><div><div class="symbol-title"><h3></h3><span class="contract-badge">PERPETUAL</span></div><div class="symbol-subtitle"></div></div></div><div class="quote-group"><div class="price-block"><div class="last-price"></div><div class="change"></div></div><div class="quote-metric"><span>24H 거래대금</span><b class="turnover"></b></div><div class="quote-metric"><span>펀딩비</span><b class="funding"></b></div></div></div><div class="card-meta"><div class="ohlc">차트 데이터를 불러옵니다</div><span class="candle-label"></span></div><div class="plot"><div class="chart-host"></div><div class="overlay"><span class="spinner"></span>화면에 들어오면 차트를 불러옵니다</div></div><div class="card-footer"><div class="legend"><span><i></i>EMA 20</span><span><i class="ema60"></i>EMA 60</span></div><div class="zoom-controls"><button class="zoom-in" aria-label="차트 확대">＋</button><button class="zoom-out" aria-label="차트 축소">−</button><button class="zoom-reset" aria-label="최근 캔들로 이동">최근</button></div><div class="card-status"><span class="dot pending"></span><span>대기 중</span></div></div>`;
  const title = el.querySelector("h3");
  title.append(document.createTextNode(item.base));
  const unit = document.createElement("span");
  unit.textContent = "/ USDT";
  title.append(unit);
  const card = {
    item,
    el,
    favorite: el.querySelector(".favorite"),
    statusText: el.querySelector(".card-status span:last-child"),
    statusDot: el.querySelector(".card-status .dot"),
    overlay: el.querySelector(".overlay"),
    generation: state.generation,
    visible: false,
    chart: null,
    data: null,
    controller: null,
    loading: false,
    queued: false,
    lastMessage: 0,
  };
  card.favorite.onclick = () => toggleFavorite(card);
  updateFavorite(card);
  quote(card);
  el.querySelector(".zoom-in").onclick = () => zoom(card, 0.7);
  el.querySelector(".zoom-out").onclick = () => zoom(card, 1.4);
  el.querySelector(".zoom-reset").onclick = () => resetRange(card);
  state.cards.set(item.symbol, card);
  return card;
}
function zoom(card, factor) {
  if (!card.chart) return;
  const range = card.chart.timeScale().getVisibleLogicalRange();
  if (range)
    card.chart
      .timeScale()
      .setVisibleLogicalRange({
        from: range.to - (range.to - range.from) * factor,
        to: range.to,
      });
}
function resetRange(card) {
  if (card.chart && card.data)
    card.chart
      .timeScale()
      .setVisibleLogicalRange({
        from: Math.max(-3, card.data.length - 100),
        to: card.data.length + 4,
      });
}
function dispose(card) {
  card.visible = false;
  card.controller?.abort();
  card.controller = null;
  card.chart?.remove();
  card.chart = null;
  card.data = null;
  card.daily = null;
  card.lastMessage = 0;
  card.overlay.hidden = false;
  card.overlay.className = "overlay";
  card.overlay.replaceChildren(
    document.createTextNode("스크롤하면 다시 불러옵니다"),
  );
  status(card, "대기 중");
}
const visibilityObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const card = state.cards.get(entry.target.dataset.symbol);
      if (!card || card.el !== entry.target) continue;
      if (entry.isIntersecting) {
        card.visible = true;
        enqueue(card);
      } else dispose(card);
    }
    scheduleSubscriptions();
  },
  { rootMargin: "450px 0px" },
);
const moreObserver = new IntersectionObserver(
  (entries) => {
    if (
      entries.some((e) => e.isIntersecting) &&
      state.rendered < state.filtered.length
    )
      appendBatch();
  },
  { rootMargin: "700px 0px" },
);
function appendBatch() {
  const batch = state.filtered.slice(state.rendered, state.rendered + 16);
  const fragment = document.createDocumentFragment();
  for (const item of batch) {
    const card = makeCard(item);
    fragment.append(card.el);
    visibilityObserver.observe(card.el);
  }
  $("cards").append(fragment);
  state.rendered += batch.length;
  $("loadMore").hidden = state.rendered >= state.filtered.length;
}
function render() {
  state.generation++;
  for (const card of state.cards.values()) {
    visibilityObserver.unobserve(card.el);
    dispose(card);
  }
  state.cards.clear();
  state.queue = [];
  state.rendered = 0;
  $("cards").replaceChildren();
  const query = $("search")
    .value.trim()
    .toUpperCase()
    .replace(/[\s/_-]/g, "");
  const sort = $("sort").value;
  const exact = state.items.some((item) => item.symbol === query);
  const items = state.items.filter(
    (item) =>
      (state.mode === "all" || state.favorites.has(item.symbol)) &&
      (!query ||
        (exact
          ? item.symbol === query
          : item.symbol.includes(query) || item.base.includes(query))),
  );
  items.sort(
    sort === "name"
      ? (a, b) => a.symbol.localeCompare(b.symbol)
      : sort === "gainers"
        ? (a, b) => (b.change ?? -Infinity) - (a.change ?? -Infinity)
        : sort === "losers"
          ? (a, b) => (a.change ?? Infinity) - (b.change ?? Infinity)
          : (a, b) => (b.turnover ?? 0) - (a.turnover ?? 0),
  );
  state.filtered = items;
  $("resultCount").textContent = items.length;
  $("listDescription").textContent =
    `· ${SORTS[sort]} · ${LABELS[state.interval]}`;
  $("empty").hidden = items.length !== 0;
  $("emptyText").textContent =
    state.mode === "favorites" && !state.items.some((item) => state.favorites.has(item.symbol))
      ? "전체 종목에서 ☆를 눌러 관심종목을 추가하세요."
      : "다른 검색어를 입력해보세요.";
  appendBatch();
  scheduleSubscriptions();
}
function changeInterval() {
  state.generation++;
  state.queue = [];
  for (const card of state.cards.values()) {
    dispose(card);
    card.generation = state.generation;
    card.queued = false;
    const rect = card.el.getBoundingClientRect();
    if (rect.bottom > -450 && rect.top < innerHeight + 450) {
      card.visible = true;
      enqueue(card);
    }
  }
  $("listDescription").textContent =
    `· ${SORTS[$("sort").value]} · ${LABELS[state.interval]}`;
  scheduleSubscriptions();
}
function enqueue(card) {
  if (
    !card.visible ||
    card.chart ||
    card.loading ||
    card.queued ||
    card.generation !== state.generation
  )
    return;
  card.queued = true;
  state.queue.push(card);
  drain();
}
function drain() {
  while (state.running < 3 && state.queue.length) {
    const card = state.queue.shift();
    card.queued = false;
    if (!card.visible || card.generation !== state.generation) continue;
    state.running++;
    loadCard(card).finally(() => {
      state.running--;
      drain();
    });
  }
}
async function loadCard(card, refresh = false) {
  if (card.loading || !card.visible) return;
  card.loading = true;
  const generation = card.generation,
    interval = state.interval,
    controller = new AbortController();
  card.controller = controller;
  if (!refresh) {
    card.overlay.hidden = false;
    card.overlay.className = "overlay";
    card.overlay.innerHTML = '<span class="spinner"></span>차트 불러오는 중';
    status(card, "조회 중");
  }
  try {
    const result = await api(
      `candles?symbol=${encodeURIComponent(card.item.symbol)}&interval=${interval}&limit=240`,
      controller.signal,
    );
    if (
      controller.signal.aborted ||
      generation !== state.generation ||
      !card.visible
    )
      return;
    card.daily = new Map(result.daily_tail.map((c) => [c.time, c]));
    card.data = result.candles;
    card.updatedAt = result.updated_at;
    card.lastMessage = Date.now();
    if (!card.chart) createChart(card);
    setChartData(card);
    card.overlay.hidden = true;
    updateOHLC(card, card.data.at(-1));
    status(card, `시세 ${CLOCK.format(new Date(result.updated_at * 1000))}`);
    scheduleSubscriptions();
  } catch (error) {
    if (
      error.name === "AbortError" ||
      generation !== state.generation ||
      !card.visible
    )
      return;
    if (card.chart) {
      status(card, "갱신 실패 · 이전 시세", "offline");
    } else {
      card.overlay.hidden = false;
      card.overlay.className = "overlay error";
      card.overlay.replaceChildren(document.createTextNode(error.message));
      const button = document.createElement("button");
      button.className = "retry";
      button.textContent = "다시 시도";
      button.onclick = () => loadCard(card);
      card.overlay.append(button);
      status(card, "조회 실패", "offline");
    }
  } finally {
    card.loading = false;
    if (card.controller === controller) card.controller = null;
    if (card.visible && !card.chart && controller.signal.aborted) enqueue(card);
  }
}
function chartTime(time) {
  return typeof time === "number"
    ? time
    : Date.UTC(time.year, time.month - 1, time.day) / 1000;
}
function createChart(card) {
  const L = window.LightweightCharts;
  if (!L)
    throw new Error(
      "차트 라이브러리를 불러오지 못했습니다. 페이지를 새로고침해주세요.",
    );
  card.chart = L.createChart(card.el.querySelector(".chart-host"), {
    autoSize: true,
    layout: {
      background: { type: "solid", color: "#171b22" },
      textColor: "#8e97a6",
      fontSize: 10,
      fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
      attributionLogo: false,
    },
    grid: { vertLines: { color: "#222832" }, horzLines: { color: "#222832" } },
    rightPriceScale: {
      borderColor: "#2a303a",
      minimumWidth: 65,
      scaleMargins: { top: 0.08, bottom: 0.25 },
    },
    timeScale: {
      borderColor: "#2a303a",
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 4,
      minBarSpacing: 2,
      tickMarkFormatter: (time, type) => {
        const d = new Date((chartTime(time) + 32400) * 1000);
        return type <= 1
          ? `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}`
          : type === 2
            ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
            : `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      },
    },
    localization: {
      locale: "ko-KR",
      timeFormatter: (time) => KST.format(new Date(chartTime(time) * 1000)),
    },
    crosshair: {
      mode: L.CrosshairMode.Normal,
      vertLine: { color: "#6e7787", labelBackgroundColor: "#414958" },
      horzLine: { color: "#6e7787", labelBackgroundColor: "#414958" },
    },
    handleScroll: {
      mouseWheel: false,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false,
    },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
  });
  const format = {
    type: "price",
    precision: card.item.price_precision,
    minMove: card.item.tick_size,
  };
  card.candles = card.chart.addSeries(L.CandlestickSeries, {
    upColor: "#35c79c",
    downColor: "#ed6a7b",
    wickUpColor: "#35c79c",
    wickDownColor: "#ed6a7b",
    borderVisible: false,
    priceFormat: format,
  });
  card.volume = card.chart.addSeries(L.HistogramSeries, {
    priceFormat: { type: "volume" },
    priceScaleId: "volume",
    lastValueVisible: false,
    priceLineVisible: false,
    visible: state.volume,
  });
  card.volume
    .priceScale()
    .applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
  card.ema20 = card.chart.addSeries(L.LineSeries, {
    color: "#d9b66e",
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    visible: state.ema,
    priceFormat: format,
  });
  card.ema60 = card.chart.addSeries(L.LineSeries, {
    color: "#8299d9",
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    visible: state.ema,
    priceFormat: format,
  });
  card.chart.subscribeCrosshairMove((param) => {
    const point = param.seriesData.get(card.candles);
    if (point?.open !== undefined)
      updateOHLC(card, { ...point, time: chartTime(param.time) });
    else if (card.data) updateOHLC(card, card.data.at(-1));
  });
}
function emaData(candles, period) {
  const result = [];
  let value = 0;
  const k = 2 / (period + 1);
  for (let i = 0; i < candles.length; i++) {
    if (i < period) {
      value += candles[i].close / period;
      if (i !== period - 1) continue;
    } else value = candles[i].close * k + value * (1 - k);
    result.push({ time: candles[i].time, value });
  }
  return result;
}
function setChartData(card) {
  const range =
    card.hasLoaded && card.chart.timeScale().getVisibleLogicalRange();
  card.candles.setData(card.data);
  card.volume.setData(
    card.data.map((c) => ({
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? "#35c79c45" : "#ed6a7b45",
    })),
  );
  card.ema20.setData(emaData(card.data, 20));
  card.ema60.setData(emaData(card.data, 60));
  if (range) card.chart.timeScale().setVisibleLogicalRange(range);
  else resetRange(card);
  card.hasLoaded = true;
  card.el.querySelector(".legend").hidden = !state.ema;
}
function updateOHLC(card, candle) {
  if (!candle) return;
  const el = card.el.querySelector(".ohlc");
  el.replaceChildren(
    document.createTextNode(KST.format(new Date(candle.time * 1000)) + " "),
  );
  for (const [label, key] of [
    ["O", "open"],
    ["H", "high"],
    ["L", "low"],
    ["C", "close"],
  ]) {
    el.append(document.createTextNode(label));
    const span = document.createElement("span");
    span.textContent = price(candle[key], card.item.price_precision);
    el.append(span);
  }
  card.el.querySelector(".candle-label").textContent =
    `${LABELS[state.interval]} · ${(candle.time + SECONDS[state.interval]) * 1000 > Date.now() ? "진행 중" : "완료봉"}`;
}
function scheduleSubscriptions() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncSubscriptions, 100);
}
function desiredSubscriptions() {
  const topics = new Set();
  if (!document.hidden)
    for (const card of state.cards.values())
      if (card.visible && card.chart && card.data)
        topics.add(
          `kline.${state.interval === "2D" ? "D" : state.interval}.${card.item.symbol}`,
        );
  return topics;
}
function syncSubscriptions() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const desired = desiredSubscriptions(),
    add = [...desired].filter((t) => !subscriptions.has(t)),
    remove = [...subscriptions].filter((t) => !desired.has(t));
  if (remove.length)
    socket.send(JSON.stringify({ op: "unsubscribe", args: remove }));
  if (add.length) socket.send(JSON.stringify({ op: "subscribe", args: add }));
  subscriptions = desired;
}
function connection(text, kind = "") {
  $("connectionText").textContent = text;
  $("connectionDot").className = `dot ${kind}`;
}
function connectSocket() {
  clearTimeout(socketRetry);
  if (!navigator.onLine) {
    connection("인터넷 연결 끊김", "offline");
    return;
  }
  if (socket?.readyState === WebSocket.OPEN) {
    connection("실시간 연결");
    return;
  }
  if (socket?.readyState === WebSocket.CONNECTING) return;
  connection("실시간 연결 중", "pending");
  subscriptions = new Set();
  socket = new WebSocket("wss://stream.bybit.com/v5/public/linear");
  socket.onopen = () => {
    socketFailures = 0;
    connection("실시간 연결");
    syncSubscriptions();
    for (const card of state.cards.values())
      if (card.visible && card.chart && Date.now() - card.lastMessage > 4000)
        loadCard(card, true);
  };
  socket.onmessage = (event) => {
    if (!navigator.onLine) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.success === false) {
      connection("구독 실패 · 재연결 중", "offline");
      socket.close();
      return;
    }
    if (!message.topic?.startsWith("kline.")) return;
    const [, interval, symbol] = message.topic.split(".");
    if (interval !== (state.interval === "2D" ? "D" : state.interval)) return;
    const card = state.cards.get(symbol);
    if (!card?.visible || !card.chart || !card.data || card.loading) return;
    for (const point of message.data ?? []) updateLive(card, point, message.ts);
  };
  socket.onerror = () => connection(
    navigator.onLine ? "실시간 연결 확인 중" : "인터넷 연결 끊김",
    navigator.onLine ? "pending" : "offline",
  );
  socket.onclose = () => {
    subscriptions = new Set();
    if (!navigator.onLine) {
      connection("인터넷 연결 끊김", "offline");
      return;
    }
    connection("재연결 중 · 15초 간격 조회", "pending");
    for (const card of state.cards.values())
      if (card.chart) status(card, "재연결 중 · 이전 시세");
    socketRetry = setTimeout(
      connectSocket,
      Math.min(30000, 1000 * 2 ** Math.min(socketFailures++, 5)) +
        Math.random() * 400,
    );
  };
}
function updateLive(card, point, serverTime) {
  if (!point || !Number.isFinite(Number(point.start))) return;
  let candle = {
    time: Number(point.start) / 1000,
    open: Number(point.open),
    high: Number(point.high),
    low: Number(point.low),
    close: Number(point.close),
    volume: Number(point.volume),
  };
  if (!Object.values(candle).every(Number.isFinite)) return;
  if (state.interval === "2D") {
    card.daily.set(candle.time, candle);
    const start = Math.floor(candle.time / 172800) * 172800,
      days = [...card.daily.values()]
        .filter((c) => c.time >= start && c.time < start + 172800)
        .sort((a, b) => a.time - b.time);
    if (!days.length || days[0].time !== start) {
      loadCard(card, true);
      return;
    }
    candle = {
      time: start,
      open: days[0].open,
      high: Math.max(...days.map((c) => c.high)),
      low: Math.min(...days.map((c) => c.low)),
      close: days.at(-1).close,
      volume: days.reduce((sum, c) => sum + c.volume, 0),
    };
    for (const time of card.daily.keys())
      if (time < start - 86400) card.daily.delete(time);
  }
  const last = card.data.at(-1);
  if (candle.time < last.time) return;
  if (candle.time > last.time + SECONDS[state.interval]) {
    loadCard(card, true);
    return;
  }
  if (candle.time === last.time) card.data[card.data.length - 1] = candle;
  else card.data.push(candle);
  if (card.data.length > 480) {
    loadCard(card, true);
    return;
  }
  card.candles.update(candle);
  card.volume.update({
    time: candle.time,
    value: candle.volume,
    color: candle.close >= candle.open ? "#35c79c45" : "#ed6a7b45",
  });
  for (const [series, period] of [
    [card.ema20, 20],
    [card.ema60, 60],
  ]) {
    const tail = emaData(card.data, period).at(-1);
    if (tail) series.update(tail);
  }
  card.lastMessage = Date.now();
  card.updatedAt = Math.floor(serverTime / 1000);
  card.item.price = candle.close;
  card.el.querySelector(".last-price").textContent = price(
    candle.close,
    card.item.price_precision,
  );
  updateOHLC(card, candle);
  status(card, `실시간 · ${CLOCK.format(new Date(serverTime))}`, "");
}
async function refreshCatalog(initial = false) {
  if (state.catalogBusy || document.hidden) return;
  state.catalogBusy = true;
  try {
    const result = await api("symbols");
    const previousSymbols = new Set(state.items.map((item) => item.symbol));
    const universeChanged = previousSymbols.size !== result.symbols.length ||
      result.symbols.some((item) => !previousSymbols.has(item.symbol));
    state.items = result.symbols;
    updateTabs();
    $("marketCount").textContent = `${result.symbols.length}개 계약`;
    $("upCount").textContent = result.symbols.filter(
      (x) => x.change > 0,
    ).length;
    $("downCount").textContent = result.symbols.filter(
      (x) => x.change < 0,
    ).length;
    $("lastUpdated").textContent =
      `시장 갱신 ${CLOCK.format(new Date(result.updated_at * 1000))}`;
    announce("");
    if (initial || !state.cards.size || universeChanged) render();
    else {
      const bySymbol = new Map(
        result.symbols.map((item) => [item.symbol, item]),
      );
      for (const card of state.cards.values()) {
        const item = bySymbol.get(card.item.symbol);
        if (item) {
          card.item = item;
          quote(card);
        } else {
          visibilityObserver.unobserve(card.el);
          dispose(card);
          card.el.hidden = true;
        }
      }
    }
  } catch (error) {
    announce(
      `${state.items.length ? "이전 시세를 표시합니다. " : ""}${error.message}`,
      () => refreshCatalog(!state.items.length),
    );
  } finally {
    state.catalogBusy = false;
  }
}
$("allTab").onclick = () => {
  state.mode = "all";
  updateTabs();
  render();
};
$("favoritesTab").onclick = () => {
  state.mode = "favorites";
  updateTabs();
  render();
};
let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 200);
});
$("sort").onchange = () => {
  save("sort", $("sort").value);
  render();
};
const savedSort = read("sort", "turnover");
if (SORTS[savedSort]) $("sort").value = savedSort;
$("intervals").addEventListener("click", (event) => {
  const button = event.target.closest("[data-interval]");
  if (!button || button.dataset.interval === state.interval) return;
  state.interval = button.dataset.interval;
  save("interval", state.interval);
  updateIntervalButtons();
  changeInterval();
});
$("showEma").checked = state.ema;
$("showVolume").checked = state.volume;
$("showEma").onchange = () => {
  state.ema = $("showEma").checked;
  save("ema", state.ema);
  for (const card of state.cards.values()) {
    if (card.chart) {
      card.ema20.applyOptions({ visible: state.ema });
      card.ema60.applyOptions({ visible: state.ema });
    }
    card.el.querySelector(".legend").hidden = !state.ema;
  }
};
$("showVolume").onchange = () => {
  state.volume = $("showVolume").checked;
  save("volume", state.volume);
  for (const card of state.cards.values())
    if (card.chart) card.volume.applyOptions({ visible: state.volume });
};
$("loadMore").onclick = appendBatch;
$("toTop").onclick = () =>
  window.scrollTo({
    top: 0,
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
  });
window.addEventListener(
  "scroll",
  () => {
    $("toTop").hidden = window.scrollY < 700;
  },
  { passive: true },
);
document.addEventListener("visibilitychange", () => {
  scheduleSubscriptions();
  if (!document.hidden) {
    connectSocket();
    refreshCatalog();
    for (const card of state.cards.values())
      if (card.visible && card.chart) loadCard(card, true);
  }
});
window.addEventListener("online", () => {
  connectSocket();
  refreshCatalog();
  for (const card of state.cards.values())
    if (card.visible && card.chart) loadCard(card, true);
});
window.addEventListener("offline", () => {
  clearTimeout(socketRetry);
  connection("인터넷 연결 끊김", "offline");
  socket?.close();
  for (const card of state.cards.values())
    if (card.chart) status(card, "인터넷 연결 끊김 · 이전 시세", "offline");
});
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ op: "ping" }));
}, 20000);
setInterval(() => refreshCatalog(), 20000);
setInterval(() => {
  if (document.hidden) return;
  for (const card of state.cards.values())
    if (
      card.visible &&
      card.chart &&
      (socket?.readyState !== WebSocket.OPEN ||
        Date.now() - card.lastMessage > 90000)
    ) {
      status(card, "시세 다시 조회 중");
      loadCard(card, true);
    }
}, 15000);
updateTabs();
updateIntervalButtons();
moreObserver.observe($("loadSentinel"));
refreshCatalog(true);
connectSocket();
