import { Embeddings } from "@langchain/core/embeddings";

// Lazy-initialized instances — created only after dotenv has loaded in bot.ts
let _llm: any = null;

export function getLlm() {
    if (!_llm) {
        // Dynamic require to avoid import hoisting
        const { ChatDeepSeek } = require("@langchain/deepseek");
        const apiKey = process.env.DEEPSEEK_API_KEY || "";
        console.log("[ai.ts] Creating ChatDeepSeek with apiKey length:", apiKey.length);
        _llm = new ChatDeepSeek({
            model: "deepseek-chat",
            temperature: 0,
            apiKey: apiKey,
        });
    }
    return _llm;
}

export class DeepSeekEmbeddings extends Embeddings {
    modelName = "deepseek-coder";
    apiKey: string;

    constructor(fields?: { apiKey?: string }) {
        super({});
        this.apiKey = fields?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
    }

    async embedDocuments(texts: string[]): Promise<number[][]> {
        const results: number[][] = [];
        for (const text of texts) {
            results.push(await this.embedQuery(text));
        }
        return results;
    }

    async embedQuery(_text: string): Promise<number[]> {
        // MVP: random vector for demonstration; replace with real embedding endpoint later
        const vector = new Array(1536).fill(0).map(() => Math.random());
        return vector;
    }
}

export const embeddings = new DeepSeekEmbeddings();
