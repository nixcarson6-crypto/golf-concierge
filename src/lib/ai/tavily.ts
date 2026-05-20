import { optionalEnv } from "@/lib/env";

export type TavilySearchInput = {
  query: string;
  searchDepth?: "basic" | "advanced";
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  topic?: "general" | "news";
};

type TavilyResult = {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
};

type TavilyResponse = {
  answer?: string;
  query: string;
  results: TavilyResult[];
};

export async function tavilySearch(input: TavilySearchInput): Promise<string> {
  const apiKey = optionalEnv("TAVILY_API_KEY");
  if (!apiKey) {
    return JSON.stringify({ error: "TAVILY_API_KEY not configured" });
  }

  const body = {
    api_key: apiKey,
    query: input.query,
    search_depth: input.searchDepth ?? "basic",
    max_results: Math.min(Math.max(input.maxResults ?? 5, 1), 10),
    include_answer: true,
    include_raw_content: false,
    include_images: false,
    topic: input.topic ?? "general",
    ...(input.includeDomains?.length
      ? { include_domains: input.includeDomains }
      : {}),
    ...(input.excludeDomains?.length
      ? { exclude_domains: input.excludeDomains }
      : {}),
  };

  let res: Response;
  try {
    res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return JSON.stringify({
      error: "tavily network error",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return JSON.stringify({
      error: `tavily ${res.status}`,
      detail: text.slice(0, 500),
    });
  }

  const data = (await res.json()) as TavilyResponse;
  return JSON.stringify({
    query: data.query,
    answer: data.answer ?? null,
    results: data.results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content.slice(0, 600),
      score: r.score,
      published: r.published_date ?? null,
    })),
  });
}
