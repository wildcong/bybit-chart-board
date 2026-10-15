# PERP · Bybit Crypto Chart Board

Static, read-only charts for Bybit USDT crypto perpetuals. Hosted on GitHub Pages.
Market data is fetched directly from Bybit's public REST and WebSocket APIs in the visitor's browser.
No API keys, account data, Python server, or scheduled data collection are used.

Features: crypto-only filtering, favorites stored locally in the browser, 1/3/5/15/30/60-minute,
daily, two-day and weekly candles, volume, EMA 20/60, search and sorting, and lazy chart rendering.
Two-day candles use fixed UTC pairs anchored to 1970-01-01.

Chart rendering uses TradingView Lightweight Charts 5.0.9. Apache 2.0 license and NOTICE
are included in assets/vendor; attribution is retained in the page footer.
