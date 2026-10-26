// Runs the local LLM off the main thread so the page stays responsive while it generates.
import { WebWorkerMLCEngineHandler } from "../vendor/web-llm/index.js";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
