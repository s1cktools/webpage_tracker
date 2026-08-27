const {
  childSitemapKey,
  fetchOpenAiXml,
  OPENAI_SITEMAP_INDEX_URL,
  parseOpenAiSitemapIndex,
  parseOpenAiSitemapPages,
} = require("./openai");
const {
  collectHtmlLinksSource,
  collectRssSource,
  collectUrlsetSource,
  fetchJson,
  mapLimit,
  parseSpaceXUpdates,
  SITEMAP_CONCURRENCY,
} = require("./website-feeds");

const SPACEX_UPDATES_API = "https://content.spacex.com/api/spacex-website/updates";

const WHITEHOUSE_RSS = [
  ["rss:news", "https://www.whitehouse.gov/news/feed/"],
  ["rss:articles", "https://www.whitehouse.gov/articles/feed/"],
  ["rss:actions", "https://www.whitehouse.gov/presidential-actions/feed/"],
  ["rss:briefings", "https://www.whitehouse.gov/briefings-statements/feed/"],
  ["rss:fact-sheets", "https://www.whitehouse.gov/fact-sheets/feed/"],
  ["rss:remarks", "https://www.whitehouse.gov/remarks/feed/"],
];

const WHITEHOUSE_SITEMAPS = [
  ["sitemap:posts", "https://www.whitehouse.gov/post-sitemap.xml"],
  ["sitemap:posts2", "https://www.whitehouse.gov/post-sitemap2.xml"],
  ["sitemap:posts3", "https://www.whitehouse.gov/post-sitemap3.xml"],
  ["sitemap:pages", "https://www.whitehouse.gov/page-sitemap.xml"],
];

const BNB_SITEMAPS = [
  ["sitemap:blog", "https://www.bnbchain.org/en/blog/sitemap.xml"],
  ["sitemap:pages", "https://www.bnbchain.org/sitemap-0.xml"],
  ["sitemap:opbnb", "https://opbnb.bnbchain.org/sitemap.xml"],
  ["sitemap:greenfield", "https://greenfield.bnbchain.org/sitemap.xml"],
];

function rss(key, url, allowedRoot) {
  return collectRssSource(key, url, { allowedRoot });
}

function urlset(key, url, allowedRoot) {
  return collectUrlsetSource(key, url, { allowedRoot });
}

function htmlLinks(key, pageUrl, allowedRoot, pathIncludes) {
  return collectHtmlLinksSource(key, pageUrl, { allowedRoot, pathIncludes });
}

async function collectOpenAi() {
  const sources = [
    await rss("rss", "https://openai.com/news/rss.xml", "openai.com"),
  ];

  try {
    const indexXml = await fetchOpenAiXml(OPENAI_SITEMAP_INDEX_URL);
    const children = parseOpenAiSitemapIndex(indexXml);
    if (!children.length) {
      sources.push({
        key: "sitemap-index",
        source: "sitemap",
        pages: [],
        error: new Error("OpenAI sitemap index contained no category files"),
      });
      return sources;
    }
    const fetched = await mapLimit(children, SITEMAP_CONCURRENCY, async (childUrl) => {
      const key = `sitemap:${childSitemapKey(childUrl) || childUrl}`;
      try {
        const xml = await fetchOpenAiXml(childUrl);
        return {
          key,
          source: "sitemap",
          pages: parseOpenAiSitemapPages(xml).map((pageUrl) => ({
            url: pageUrl,
            title: "",
            source: "sitemap",
          })),
          error: null,
        };
      } catch (error) {
        return { key, source: "sitemap", pages: [], error };
      }
    });
    sources.push(...fetched);
  } catch (error) {
    sources.push({ key: "sitemap-index", source: "sitemap", pages: [], error });
  }
  return sources;
}

async function collectSpaceX() {
  try {
    const payload = await fetchJson(SPACEX_UPDATES_API);
    const pages = parseSpaceXUpdates(payload);
    return [
      {
        key: "updates",
        source: "cms",
        pages,
        error: pages.length ? null : new Error("SpaceX updates API contained no posts"),
      },
    ];
  } catch (error) {
    return [{ key: "updates", source: "cms", pages: [], error }];
  }
}

async function collectBnbChain() {
  return mapLimit(BNB_SITEMAPS, 4, ([key, url]) => urlset(key, url, "bnbchain.org"));
}

async function collectWhiteHouse() {
  const feeds = await mapLimit(WHITEHOUSE_RSS, 6, ([key, url]) =>
    rss(key, url, "whitehouse.gov")
  );
  const sitemaps = await mapLimit(WHITEHOUSE_SITEMAPS, 4, ([key, url]) =>
    urlset(key, url, "whitehouse.gov")
  );
  return [...feeds, ...sitemaps];
}

async function collectGrok() {
  return [await urlset("sitemap", "https://grok.com/sitemap.xml", "grok.com")];
}

async function collectXai() {
  return [
    await htmlLinks("news-html", "https://x.ai/news", "x.ai", "/news/"),
    await urlset("sitemap", "https://x.ai/sitemap.xml", "x.ai"),
    await urlset("sitemap:docs", "https://docs.x.ai/sitemap.xml", "x.ai"),
  ];
}

async function collectPumpFun() {
  return [await urlset("sitemap", "https://pump.fun/sitemap.xml", "pump.fun")];
}

async function collectSolana() {
  return [
    await rss("rss", "https://solana.com/news/rss.xml", "solana.com"),
    await urlset("sitemap:news", "https://solana.com/news/sitemap-news.xml", "solana.com"),
    await urlset("sitemap:podcasts", "https://solana.com/podcasts/sitemap.xml", "solana.com"),
    await urlset("sitemap", "https://solana.com/sitemap.xml", "solana.com"),
  ];
}

async function collectAnthropic() {
  return [
    await htmlLinks("news-html", "https://www.anthropic.com/news", "anthropic.com", "/news/"),
    await urlset("sitemap", "https://www.anthropic.com/sitemap.xml", "anthropic.com"),
  ];
}

async function collectClaude() {
  return [
    await htmlLinks("blog-html", "https://claude.com/blog", "claude.com", "/blog/"),
    await urlset("sitemap", "https://claude.com/sitemap.xml", "claude.com"),
    await urlset("sitemap:docs", "https://claude.com/docs/sitemap.xml", "claude.com"),
  ];
}

const WEBSITE_PLAYBOOKS = [
  {
    key: "openai",
    hostname: "openai.com",
    url: "https://openai.com/",
    nickname: "OpenAI",
    ignoreLocales: true,
    summary: "news RSS + category sitemaps",
    collect: collectOpenAi,
  },
  {
    key: "spacex",
    hostname: "spacex.com",
    url: "https://www.spacex.com/",
    nickname: "SpaceX",
    ignoreLocales: false,
    summary: "updates CMS JSON",
    collect: collectSpaceX,
  },
  {
    key: "bnbchain",
    hostname: "bnbchain.org",
    url: "https://www.bnbchain.org/",
    nickname: "BNB Chain",
    ignoreLocales: false,
    summary: "blog sitemap + site pages",
    collect: collectBnbChain,
  },
  {
    key: "whitehouse",
    hostname: "whitehouse.gov",
    url: "https://www.whitehouse.gov/",
    nickname: "White House",
    ignoreLocales: false,
    summary: "6 news RSS feeds + post/page sitemaps",
    collect: collectWhiteHouse,
  },
  {
    key: "grok",
    hostname: "grok.com",
    url: "https://grok.com/",
    nickname: "Grok",
    ignoreLocales: false,
    summary: "product sitemap",
    collect: collectGrok,
  },
  {
    key: "xai",
    hostname: "x.ai",
    url: "https://x.ai/",
    nickname: "x.ai",
    ignoreLocales: false,
    summary: "/news HTML + site/docs sitemaps",
    collect: collectXai,
  },
  {
    key: "pumpfun",
    hostname: "pump.fun",
    url: "https://pump.fun/",
    nickname: "pump.fun",
    ignoreLocales: false,
    summary: "marketing sitemap",
    collect: collectPumpFun,
  },
  {
    key: "solana",
    hostname: "solana.com",
    url: "https://solana.com/",
    nickname: "Solana",
    ignoreLocales: true,
    summary: "news RSS + news/site/podcast sitemaps",
    collect: collectSolana,
  },
  {
    key: "anthropic",
    hostname: "anthropic.com",
    url: "https://www.anthropic.com/",
    nickname: "Anthropic",
    ignoreLocales: false,
    summary: "/news HTML + site sitemap",
    collect: collectAnthropic,
  },
  {
    key: "claude",
    hostname: "claude.com",
    url: "https://claude.com/",
    nickname: "Claude",
    ignoreLocales: true,
    summary: "/blog HTML + site/docs sitemaps",
    collect: collectClaude,
  },
];

function getPlaybook(hostname) {
  const host = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  return WEBSITE_PLAYBOOKS.find((playbook) => playbook.hostname === host) || null;
}

function playbookHostnames() {
  return WEBSITE_PLAYBOOKS.map((playbook) => playbook.hostname);
}

async function collectPlaybook(playbook) {
  const result = await playbook.collect();
  return Array.isArray(result) ? result : [result];
}

module.exports = {
  BNB_SITEMAPS,
  SPACEX_UPDATES_API,
  WEBSITE_PLAYBOOKS,
  WHITEHOUSE_RSS,
  WHITEHOUSE_SITEMAPS,
  collectPlaybook,
  getPlaybook,
  playbookHostnames,
};
