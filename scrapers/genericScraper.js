const axios = require("axios");
require("dotenv").config();

const NEWSAPI_URL = "https://eventregistry.org/api/v1/article/getArticles";

const DEFAULTS = {
  size: 10,
  lang: "eng",
};

/**
 * Fetch articles from NewsAPI.ai (Event Registry) for one company x one site.
 *
 * config = {
 *   company:       "Meesho",
 *   companyId:     3,
 *   site:          "livemint",
 *   sourceUri:     "livemint.com",
 *   companyKeyword: ["Meesho"],       // array of accepted name variants
 *   topics:        ["funding", ...],  // optional narrowing keywords
 *   size:          10,
 * }
 *
 * Returns a plain array of article objects (never throws for "no results").
 */
async function genericScraper(config) {
  const apiKey = process.env.NEWSAPI_AI_KEY;
  if (!apiKey) {
    throw new Error("NEWSAPI_AI_KEY is missing - check your .env file");
  }

  const size = config.size || DEFAULTS.size;
  const lang = config.lang || DEFAULTS.lang;

  const companyKeywords = Array.isArray(config.companyKeyword)
    ? config.companyKeyword
    : [config.companyKeyword];

  const companyCondition =
    companyKeywords.length > 1
      ? { $or: companyKeywords.map((k) => ({ keyword: k })) }
      : { keyword: companyKeywords[0] };

  const andConditions = [companyCondition, { sourceUri: config.sourceUri }];

  if (config.topics && config.topics.length > 0) {
    andConditions.push({ $or: config.topics.map((t) => ({ keyword: t })) });
  }

  const query = {
    $query: { $and: andConditions },
    $filter: { lang },
  };

  const { data } = await axios.post(
    NEWSAPI_URL,
    {
      query,
      resultType: "articles",
      articlesSortBy: "date",
      articlesCount: size,
      includeArticleImage: false,
      apiKey,
    },
    { headers: { "Content-Type": "application/json" }, timeout: 30000 }
  );

  if (data && data.error) {
    throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
  }

  const results = (data && data.articles && data.articles.results) || [];

  return results.map((post) => ({
    title: post.title ?? null,
    body: post.body ?? null,
    url: post.url ?? null,
    author: post.authors?.[0]?.name ?? null,
    published: post.dateTime ?? post.date ?? null,
    site: post.source?.title ?? post.source?.uri ?? config.sourceUri,
    section_title: post.categories?.[0]?.label ?? null,
    company: config.company,
    companyId: config.companyId,
  }));
}

module.exports = genericScraper;
