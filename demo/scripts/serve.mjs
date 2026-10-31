// Serves dist/ on http://localhost:$PORT (5180). The demo must not share the wallet's origin:
// the wallet refuses its own origin as an app. Any web wallet may open it in its Apps view
// (`frame-ancestors *`).
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const dist = new URL("../dist/", import.meta.url);
const port = Number(process.env.PORT ?? 5180);
createServer(async (request, response) => {
  const file = new URL(request.url.split("?")[0] === "/main.js" ? "main.js" : "index.html", dist);
  response.writeHead(200, {
    "Content-Type": file.pathname.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8",
    "Content-Security-Policy": "frame-ancestors *",
  });
  response.end(await readFile(file));
}).listen(port, () => console.log(`demo: http://localhost:${port}/?wallet=<web wallet URL> (and &slot=<Flush Slot>, 46 by default)`));
