import type { DailyRssSource } from "./dailyNews";

/**
 * 每日 AI 动态简报的 RSS 源清单（自包含，移植自 daily-news/流光）。
 * 想加/停某个源：直接改这里；enabled:false 即临时停用。分组见 DailyRssSourceGroup。
 */
export const DEFAULT_DAILY_RSS_SOURCES: DailyRssSource[] = [
  { id: "openai-blog", name: "OpenAI Blog", url: "https://openai.com/blog/rss.xml", group: "company", enabled: true, priority: 100, maxItems: 8, timeoutMs: 15000, retries: 3 },
  { id: "anthropic-news", name: "Anthropic News", url: "https://rsshub.rssforever.com/anthropic/news", group: "company", enabled: true, priority: 95, maxItems: 8, timeoutMs: 15000, retries: 3 },
  { id: "anthropic-engineering", name: "Anthropic Engineering", url: "https://rsshub.rssforever.com/anthropic/engineering", group: "company", enabled: true, priority: 92, maxItems: 6, timeoutMs: 15000, retries: 3 },
  { id: "anthropic-research", name: "Anthropic Research", url: "https://rsshub.rssforever.com/anthropic/research", group: "company", enabled: false, priority: 93, maxItems: 6, timeoutMs: 15000, retries: 3 },
  { id: "deepmind-blog", name: "DeepMind Blog", url: "https://deepmind.google/blog/rss.xml", group: "company", enabled: true, priority: 90, maxItems: 8, timeoutMs: 15000, retries: 3 },
  { id: "product-hunt-buzzing", name: "Product Hunt Daily", url: "https://ph.buzzing.cc/feed.xml", group: "products", enabled: true, priority: 88, maxItems: 10, timeoutMs: 15000, retries: 3 },
  { id: "github-trending-daily", name: "GitHub Trending Daily", url: "https://rsshub.rssforever.com/github/trending/daily/any", group: "github", enabled: true, priority: 86, maxItems: 10, timeoutMs: 15000, retries: 3 },
  { id: "simon-willison", name: "Simon Willison", url: "https://simonwillison.net/atom/everything/", group: "practitioner", enabled: true, priority: 85, maxItems: 6, timeoutMs: 15000, retries: 3 },
  { id: "gary-marcus", name: "Gary Marcus", url: "https://garymarcus.substack.com/feed", group: "practitioner", enabled: true, priority: 70, maxItems: 5, timeoutMs: 15000, retries: 3 },
  { id: "gwern", name: "Gwern", url: "https://gwern.substack.com/feed", group: "practitioner", enabled: true, priority: 70, maxItems: 5, timeoutMs: 15000, retries: 3 },
  { id: "max-woolf", name: "Max Woolf", url: "https://minimaxir.com/index.xml", group: "practitioner", enabled: true, priority: 70, maxItems: 5, timeoutMs: 15000, retries: 3 },
  { id: "george-hotz", name: "George Hotz", url: "https://geohot.github.io/blog/feed.xml", group: "practitioner", enabled: true, priority: 65, maxItems: 5, timeoutMs: 15000, retries: 3 },
  { id: "dwarkesh-patel", name: "Dwarkesh Patel", url: "https://www.dwarkeshpatel.com/feed", group: "practitioner", enabled: true, priority: 65, maxItems: 5, timeoutMs: 20000, retries: 3 },
  { id: "xe-iaso", name: "Xe Iaso", url: "https://xeiaso.net/blog.rss", group: "practitioner", enabled: true, priority: 60, maxItems: 5, timeoutMs: 15000, retries: 3 },
  { id: "geoffrey-litt", name: "Geoffrey Litt", url: "https://www.geoffreylitt.com/feed.xml", group: "practitioner", enabled: true, priority: 60, maxItems: 5, timeoutMs: 15000, retries: 3 },
  { id: "hn-ai", name: "Hacker News AI", url: "https://hnrss.org/newest?q=AI+OR+LLM+OR+GPT+OR+Claude&points=30", group: "community", enabled: false, priority: 75, maxItems: 10, timeoutMs: 15000, retries: 3 },
  { id: "lobsters-ai", name: "Lobsters AI", url: "https://lobste.rs/t/ai.rss", group: "community", enabled: false, priority: 70, maxItems: 8, timeoutMs: 15000, retries: 3 },
  { id: "huggingface-papers", name: "HuggingFace Papers", url: "https://rsshub.rssforever.com/huggingface/daily-papers", group: "papers", enabled: true, priority: 80, maxItems: 10, timeoutMs: 15000, retries: 3 },
];
