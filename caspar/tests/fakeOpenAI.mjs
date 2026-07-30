/**
 * A fake OpenAI-compatible Chat Completions server, for the LLM-proxy checks.
 *
 * It stands in for OpenAI / Gemini / xAI / OpenRouter: it accepts a real
 * `/chat/completions` request (so the checks exercise the actual request the proxy
 * builds) and returns a scripted answer, streaming or not, in real OpenAI SSE. A
 * scenario can drive a tool call followed by a final text answer, which is what
 * proves Claude Code can run an agentic turn through the translation.
 */

import http from "node:http";

export class FakeOpenAI {
  /**
   * @param opts.turns array of turn specs, one per request in order. Each:
   *   `{ text?, toolCalls?: [{id,name,arguments}], finish?: "stop"|"tool_calls",
   *      usage?: {prompt_tokens, completion_tokens} }`
   *   When there are more requests than turns, the last turn repeats.
   */
  constructor({ turns = [] } = {}) {
    this.turns = turns;
    this.requests = [];
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.port = 0;
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = this.server.address().port;
    return this;
  }

  async stop() {
    await new Promise((resolve) => this.server.close(resolve));
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  _turnFor(index) {
    if (!this.turns.length) return { text: "ok", finish: "stop" };
    return this.turns[Math.min(index, this.turns.length - 1)];
  }

  async _handle(req, res) {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      /* keep {} */
    }
    const index = this.requests.length;
    this.requests.push({ url: req.url, method: req.method, headers: req.headers, body: parsed });
    const turn = this._turnFor(index);
    const usage = turn.usage || { prompt_tokens: 11, completion_tokens: 7 };

    if (parsed.stream) return this._stream(res, turn, usage);
    return this._complete(res, turn, usage);
  }

  _message(turn) {
    const message = { role: "assistant", content: turn.text || null };
    if (Array.isArray(turn.toolCalls) && turn.toolCalls.length) {
      message.tool_calls = turn.toolCalls.map((tc, i) => ({
        index: i,
        id: tc.id || `call_${i}`,
        type: "function",
        function: { name: tc.name, arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {}) },
      }));
    }
    return message;
  }

  _complete(res, turn, usage) {
    const body = JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion",
      model: "fake-model",
      choices: [{ index: 0, message: this._message(turn), finish_reason: turn.finish || (turn.toolCalls ? "tool_calls" : "stop") }],
      usage,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  }

  _stream(res, turn, usage) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const finish = turn.finish || (turn.toolCalls ? "tool_calls" : "stop");

    send({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    if (turn.text) {
      // Stream the text in a couple of fragments to exercise reassembly.
      const mid = Math.ceil(turn.text.length / 2);
      send({ choices: [{ index: 0, delta: { content: turn.text.slice(0, mid) } }] });
      send({ choices: [{ index: 0, delta: { content: turn.text.slice(mid) } }] });
    }
    (turn.toolCalls || []).forEach((tc, i) => {
      const args = typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {});
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id || `call_${i}`, type: "function", function: { name: tc.name, arguments: "" } }] } }] });
      const mid = Math.ceil(args.length / 2);
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(0, mid) } }] } }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(mid) } }] } }] });
    });
    send({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    send({ choices: [], usage });
    res.write("data: [DONE]\n\n");
    res.end();
  }
}
