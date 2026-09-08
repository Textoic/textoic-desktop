import type { ActionContext } from "../actions/context.js";
import type { PlannedCall } from "../cost.js";
import type { ChatMessage } from "../types.js";

export const TWEET_MAX_CHARS = 280;
export const PROMPT_MAX_CHARS = 2000;

const TWEET_TOKENS = 200;

export const tweetMessages = (prompt: string, context: string): ChatMessage[] => [
  {
    role: "system",
    content: `You write tweets. A tweet carries exactly one idea, in at most ${TWEET_MAX_CHARS} characters, in plain text. No hashtags unless asked, no emoji unless asked, no quotation marks around the tweet, no preamble, no explanation. Write in the active voice with concrete words.`,
  },
  {
    role: "user",
    content: `${context ? `${context}\n\n` : ""}Write one tweet about this:\n${prompt.trim()}\n\nReply with the tweet text only.`,
  },
];

export const plannedTweetCalls = (prompt: string, context: string): PlannedCall[] => [
  { stage: "tweet", messages: tweetMessages(prompt, context), maxOutputTokens: TWEET_TOKENS },
];

const cleaned = (text: string) =>
  text
    .trim()
    .replace(/^["“]+|["”]+$/gu, "")
    .replace(/^tweet:\s*/iu, "")
    .trim();

export const generateTweet = async (ctx: ActionContext, prompt: string, context: string): Promise<string> => {
  const messages = tweetMessages(prompt, context);
  ctx.progress({ step: "writing tweet", done: 0, total: 1 });
  let tweet = cleaned((await ctx.call("tweet", { messages, maxOutputTokens: TWEET_TOKENS, temperature: 0.8 })).content);
  for (let attempt = 0; attempt < 2 && tweet.length > TWEET_MAX_CHARS; attempt += 1) {
    const shorter = await ctx.call(`tweet:shorten ${attempt + 1}`, {
      messages: [
        ...messages,
        { role: "assistant", content: tweet },
        {
          role: "user",
          content: `That is ${tweet.length} characters; the limit is ${TWEET_MAX_CHARS}. Keep the same single idea and cut it to under ${TWEET_MAX_CHARS} characters. Reply with the tweet text only.`,
        },
      ],
      maxOutputTokens: TWEET_TOKENS,
      temperature: 0.5,
    });
    tweet = cleaned(shorter.content);
  }

  ctx.progress({ step: "tweet written", done: 1, total: 1 });
  return tweet.length > TWEET_MAX_CHARS ? tweet.slice(0, TWEET_MAX_CHARS).trim() : tweet;
};
