export {
  type NewsItem,
  type NewsProvider,
  type NewsSentiment,
  SENTIMENTS,
  normalizeNewsItem,
  normalizeSentiment,
} from "./types";
export { coinKeywords, scoreRelevance, type RelevanceResult } from "./relevance";
export {
  aggregateNews,
  defaultNewsProvider,
  newsEndpointFromEnv,
  EmptyNewsProvider,
  HttpNewsProvider,
} from "./provider";
