// THROWAWAY PROTOTYPE SERVER. It serves static mock data and performs no MDLM work.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const htmlPath = fileURLToPath(new URL("./index.html", import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const html = await readFile(htmlPath);

createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }

  if (url.pathname !== "/" && url.pathname !== "/prototype/operator-conversation") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(html);
}).listen(port, "127.0.0.1", () => {
  console.log(`THROWAWAY MDLM prototype: http://127.0.0.1:${port}/prototype/operator-conversation?variant=A`);
});
